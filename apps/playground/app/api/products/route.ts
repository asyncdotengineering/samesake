import { listProducts } from "@/lib/catalog";

// Storefront browse: the full active catalog from Porulle.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const products = await listProducts();
  return Response.json({
    hits: products.map((p) => ({
      id: p.id,
      title: p.title,
      brand: p.brand,
      category: p.category,
      color: p.color,
      price: p.price,
      imageUrl: p.imageUrl,
    })),
  });
}
