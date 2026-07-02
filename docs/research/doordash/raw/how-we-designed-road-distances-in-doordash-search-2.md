# How we Designed Road Distances in DoorDash Search
URL: https://careersatdoordash.com/blog/how-we-designed-road-distances-in-doordash-search-2/
Published: 2017-09-22T19:40:00+00:00
Authors: Richard Hwang

## Figures
- https://careersatdoordash.com/wp-content/uploads/2017/09/Screenshot-2024-02-09-at-12.22.52%E2%80%AFPM-2-1024x360.png — _(no caption; Figure 1 nine-mile radius circle around an address in Southern California, and Figure 2 Dasher drive time)_
- https://careersatdoordash.com/wp-content/uploads/2017/09/Screenshot-2024-02-09-at-12.26.09%E2%80%AFPM-1-1024x410.png — _Figure 3 (left): Isochrones of 10 and 20 minutes (walking). Figure 4 (right): geojson representation of an isochrone._
- https://careersatdoordash.com/wp-content/uploads/2017/09/0_u8AsjM9aq-SZvA7c-1024x750.webp — _Figure 5: Structure of architecture to determine stores within a consumer's delivery address._
- https://careersatdoordash.com/wp-content/uploads/2017/09/0_ypnUqBB8RMSSmD6h-1024x871.webp — _Figure 6: Nine mile isochrone for address in Figure 1._

## Body
One of our goals at DoorDash is to surface to consumers a wide range of stores that are quickly deliverable to their given address. This process involves calculating accurate road distances for each store-consumer pair in our real-time search pipeline. Our earlier blog post about [recommendations](https://blog.doordash.com/powering-search-recommendations-at-doordash-8310c5cfd88c) for search primarily focuses on the ranking component of search at DoorDash. This blog post describes how we architected our search system using open source technologies to help determine consumer selection.

## Problem and Motivation

Calculating accurate driving distance in real time is critical to the selection that a DoorDash consumer sees. A mere straight line circle-based distance could be inaccurate and would result in very long Dasher drive times, especially when the topology of the region has unevenness due to barriers like mountains, lakes, bridges, parks, etc.

_Figure 1_ depicts a circle with a nine mile radius centered around an address in Southern California. If a consumer orders from a store on the edge of this circle, it will take at least half an hour (as shown in _Figure 2_) just for the Dasher to get from the store to the consumer.

![Figure 1 and Figure 2](https://careersatdoordash.com/wp-content/uploads/2017/09/Screenshot-2024-02-09-at-12.22.52%E2%80%AFPM-2-1024x360.png)

## Basic Definitions

Before we delve into the system architecture, let us define some terms:

- **Latitude, Longitude**: A unique location point on the planet, abbreviated as (lat, lng.)
- [**Geohash**](https://en.wikipedia.org/wiki/Geohash): A hierarchical encoding system to subdivide space into grid like structure.
- [**Isochrone**](http://wiki.openstreetmap.org/wiki/Isochrone): A curve of equal travel time, represented as a [GeoJSON](http://geojson.org/). _Figure 3_ shows an isochrone in San Francisco depicting areas that can be reached in 10 (inner region) and 20 (outer region) minutes by walking. _Figure 4_ is geojson representation of an isochrone.

![Figure 3 and Figure 4](https://careersatdoordash.com/wp-content/uploads/2017/09/Screenshot-2024-02-09-at-12.26.09%E2%80%AFPM-1-1024x410.png)
_Figure 3 (left): Isochrones of 10 and 20 minutes (walking). Figure 4 (right): geojson representation of an isochrone._

## Architecture

The following diagram describes the overall architecture to determine if a store is in the consumer's delivery address to determine its selection.

![Figure 5](https://careersatdoordash.com/wp-content/uploads/2017/09/0_u8AsjM9aq-SZvA7c-1024x750.webp)
_Figure 5: Structure of architecture to determine stores within a consumer's delivery address._

### Offline component:

The offline component involves an isochrone service responsible for computing isochrones for a given location (lat and lng, which is converted to a level seven geohash) and parameters (eg: travel time).

To compute isochrones, we use our custom fork of [Galton](https://github.com/urbica/galton), an open source project. Galton is built on top of [OSRM](http://project-osrm.org/), an open source routing engine, and [concaveman](https://github.com/mapbox/concaveman), a fast implementation of a concave hull algorithm. Galton first generates a grid of coordinates of configurable size and granularity around the input coordinate. OSRM then computes travel times from the input coordinate to each of the grid coordinates. Grid coordinates with travel times greater than the input travel time are filtered out. Finally, the concave hull algorithm generates an outline of the remaining coordinates, producing the appropriate isochrone as shown in _Figure 6_, which is the nine mile isochrone for the same address in _Figure 1_.

![Figure 6](https://careersatdoordash.com/wp-content/uploads/2017/09/0_ypnUqBB8RMSSmD6h-1024x871.webp)
_Figure 6: Nine mile isochrone for address in Figure 1._

The service caches isochrones in DynamoDB, as simple key-value lookups for speedy retrieval. Further, we key by geohash, precision 7, rather than exact coordinate, to reduce the number of entries we need to store. Precision 7 geohashes have an error of 0.076 km; isochrones for coordinates within these bounds will not vary drastically. We store isochrones in order of millions and with lookup time under ten milliseconds.

For each request, the service queries for DynamoDB: if the isochrone is present then it is returned. If the isochrone is absent then an asynchronous job is launched to generate and store it, returning a null response. On subsequent requests for that address and parameters, the generated isochrone will be returned. When we launch a new market, we bootstrap it by running a script to pre populate isochrone entries for all geohashes in the market, to get the market up to speed for accurate selection upfront.

### Online component:

1. DoorDash clients call the search backend API for the specific (lat, lng)
2. Search module calls isochrone service with the (lat, lng) and parameters like travel time to fetch the corresponding isochrone. These parameters are district-specific and configurable, so we can run experiments for testing conversion changes based on selection. If the isochrone is absent (as in the case when the isochrone is absent in dynamodb), we fall back to the naive straight line distance computations (with tighter radius). We persist the selection logic (isochrone or straight line along with parameters) at a session level in the backend search module to provide a consistent notion of selection across browsing sessions for the consumer.
3. The search module on fetching the isochrone for that address is encoded as a [polygon geoshape](https://www.elastic.co/guide/en/elasticsearch/reference/5.5/geo-shape.html#geo-shape) to construct a [geoshape query](https://www.elastic.co/guide/en/elasticsearch/reference/5.5/query-dsl-geo-shape-query.html) to hit Elasticsearch.
4. Stores that are indexed into Elasticsearch have the store location encoded in [geo-point](https://www.elastic.co/guide/en/elasticsearch/reference/5.4/geo-point.html) format. Elasticsearch builds a [prefix tree structure](https://www.elastic.co/guide/en/elasticsearch/reference/5.5/geo-shape.html#prefix-trees) at index time to support fast geo queries at runtime. Elasticsearch runs the given ES geoshape query from Step 3 to compute an intersection of the polygon with stores in the index for retrieval.
5. Store results are deserialized and returned to the client for that address.

## Conclusion

Our current implementation accounts for the topology of the region via driving distance addressing the inaccurate selection problem in _Figure 1_ by isochrone selection as shown in _Figure 6_. Furthermore, this architecture allows flexibility to configure and control selection logic based on regionality, to dynamically change selection logic based on supply/demand curves, and to run selection experiments.

Some potential areas that we will be working on in the future include getting more accurate real-time traffic and road condition updates into the system.
