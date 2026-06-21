// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "samesake",
      description:
        "A TypeScript-first search engine compiler for visual commerce. Declare your catalog and retrieval in TypeScript; run a Postgres-backed hybrid search layer inside your app.",
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
            { label: "Search for a fashion marketplace", slug: "guides/marketplace-search" },
            { label: "From an idea to a working agent", slug: "guides/from-idea-to-agent" },
            { label: "Shopping agent with Mastra + samesake", slug: "guides/mastra-ecommerce-assistant" },
            { label: "Fashion app with Porulle + Next.js", slug: "guides/porulle-fashion-app" },
            { label: "Pipeline lifecycle", slug: "guides/pipeline-lifecycle" },
            { label: "Tuning search relevance", slug: "guides/tuning-search" },
            { label: "Eval from search snapshots", slug: "guides/eval-from-snapshots" },
            { label: "Eval gate — tune floor and exponents", slug: "guides/eval-gate" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Reranking", slug: "reference/reranking" },
            { label: "Relevance judge", slug: "reference/relevance-judge" },
            { label: "Providers", slug: "reference/providers" },
          ],
        },
      ],
    }),
  ],
});
