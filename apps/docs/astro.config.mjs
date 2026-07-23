// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "samesake",
      description:
        "A TypeScript-first commerce intelligence engine. Compose enrich, resolve, and search over ports supplied by your application.",
      customCss: ["./src/styles/custom.css"],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/asyncdotengineering/samesake" },
        { icon: "npm", label: "npm", href: "https://www.npmjs.com/package/@samesake/core" },
      ],
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=Newsreader:opsz,wght@6..72,400;6..72,500&family=JetBrains+Mono:wght@400;500&display=swap",
          },
        },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "What is samesake", slug: "start/what-is-samesake" },
            { label: "Why samesake?", slug: "start/why-samesake" },
            { label: "Build a search experience", slug: "start/build-a-search-experience" },
            { label: "Quickstart", slug: "start/quickstart" },
          ],
        },
        {
          label: "Integrations",
          items: [
            { label: "Porulle", slug: "integrations/porulle" },
            { label: "MedusaJS", slug: "integrations/medusajs" },
            { label: "Headless Shopify", slug: "integrations/shopify" },
            { label: "Headless WooCommerce", slug: "integrations/woocommerce" },
          ],
        },
        {
          label: "Running the pipeline",
          items: [
            { label: "Running the enrich pipeline durably", slug: "guides/enrich-pipeline" },
            { label: "Enrichment without the reference backend", slug: "guides/enrichment-without-postgres" },
            { label: "Search without the reference backend", slug: "guides/search-without-postgres" },
            { label: "In-memory pipeline", slug: "guides/pipeline-in-memory" },
            { label: "Inngest pipeline", slug: "guides/pipeline-inngest" },
            { label: "Upstash Workflow pipeline", slug: "guides/pipeline-upstash" },
            { label: "Cloudflare Workflows pipeline", slug: "guides/pipeline-cloudflare-workflows" },
            { label: "Vercel Workflows pipeline", slug: "guides/pipeline-vercel-workflows" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "From a store idea to search that gets people", slug: "guides/idea-to-search" },
            { label: "Faceted instant search", slug: "guides/faceted-search" },
            { label: "Search for a fashion marketplace", slug: "guides/marketplace-search" },
            { label: "Conversational search — intent & price", slug: "guides/conversational-search" },
            { label: "From an idea to a working agent", slug: "guides/from-idea-to-agent" },
            { label: "Shopping agent with Mastra + samesake", slug: "guides/mastra-ecommerce-assistant" },
            { label: "Fashion app with Porulle + Next.js", slug: "guides/porulle-fashion-app" },
            { label: "Pipeline lifecycle", slug: "guides/pipeline-lifecycle" },
            { label: "Tuning search relevance", slug: "guides/tuning-search" },
            { label: "Measure enrichment accuracy", slug: "guides/eval-enrichment" },
            { label: "Eval from search snapshots", slug: "guides/eval-from-snapshots" },
            { label: "Eval gate — tune floor and exponents", slug: "guides/eval-gate" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Canonical API", slug: "reference/canonical-api" },
            { label: "@samesake/core", slug: "reference/packages/core" },
            { label: "@samesake/enrich", slug: "reference/packages/enrich" },
            { label: "@samesake/query", slug: "reference/packages/query" },
            { label: "@samesake/presets", slug: "reference/packages/presets" },
            { label: "@samesake/embed", slug: "reference/packages/embed" },
            { label: "@samesake/postgres", slug: "reference/packages/postgres" },
            { label: "Reranking", slug: "reference/reranking" },
            { label: "Relevance judge", slug: "reference/relevance-judge" },
            { label: "Providers", slug: "reference/providers" },
          ],
        },
      ],
    }),
  ],
});
