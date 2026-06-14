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
          label: "Guides",
          items: [
            { label: "Fashion app with Porulle + Next.js", slug: "guides/porulle-fashion-app" },
            { label: "Eval from search snapshots", slug: "guides/eval-from-snapshots" },
          ],
        },
      ],
    }),
  ],
});
