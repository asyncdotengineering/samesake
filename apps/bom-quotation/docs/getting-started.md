# Getting started: turning a parts list into a price

Picture this. You run an electrical supply shop. This morning a contractor emailed
you a spreadsheet — forty lines of things they need for a building: *"3C x 2.5 sqmm
Cu/PVC cable, 250m"*, *"32A SP MCB"*, *"8 way SPN DB"*, and on it goes. They'd like
a price by end of day.

So you do what you've always done. You open your price list, and for each line you
squint at the shorthand, work out which product they actually mean, find your cost,
add your margin, apply *this* contractor's discount, and type it into a quote. Forty
lines. An hour, maybe two. And if you misread "32A" as "40A", you've just quoted the
wrong breaker — and you might not notice until it's installed.

This app does that hour in about a minute. The rest of this page is just helping you
build a clear picture of *how it thinks*, so you trust it when it's right and catch
it when it isn't.

## The one idea to hold onto

Most people hear "match the line to a product" and picture a search box — type some
words, get a list, pick one. That's not quite what's happening here, and the
difference matters.

When the contractor writes *"32A SP MCB"*, they aren't *searching* for breakers in
general. They mean **one specific product** in your shop. Your job isn't to show them
ten options — it's to **recognise** which exact part they meant, and to be honest
about how sure you are.

That's the whole game: **recognition, with a confidence attached.** A search engine
that's a little bit wrong just shows a slightly-off list, no harm done. A quote
that's a little bit wrong charges for the wrong part. So the app is built to either
be *confident and right*, or to *raise its hand and ask you*. It never quietly
guesses.

## Walk through what happens to one line

Take *"3C x 2.5 sqmm Cu/PVC cable - 250m, coil"*. Here's the journey, in plain terms:

1. **Read it off the page.** Whether the BOM is a spreadsheet or a PDF, the app first
   pulls the raw lines out — and skips the noise (headers, "Sub-total", "Please quote
   your best rates", page numbers). You'd do the same: your eye ignores the letterhead.

2. **Translate the shorthand.** Trades have their own dialect. "3C" means three cores.
   "sqmm" means square millimetres. "Cu" is copper. "SP" is single pole. "Coil" of
   cable means roughly 100 metres. The app expands all of that into plain, consistent
   language — and crucially, it pulls out the *numbers that matter*: 3 cores,
   2.5 mm², copper. This step is doing the thing an experienced counter person does
   without thinking.

3. **Find the part — carefully.** Now it looks for the matching product. Two instincts
   work together here. One reads the *meaning* of the description ("three-core copper
   power cable"). The other reads the *exact characters* — useful for codes and part
   numbers, where one digit changes everything. Together they propose the best match
   and a confidence score.

4. **Refuse to mix up variants.** Here's the safety rail. Even if a part *looks* like a
   great match, the app checks the hard facts: a 32-amp line can never be matched to a
   40-amp part. A 3-core cable never to a 4-core. If the unchangeable numbers don't
   agree, that candidate is thrown out — no matter how similar the words were. This is
   the single most important thing that keeps a quote honest.

5. **Decide: confident, unsure, or no.** If the match is strong *and* the hard facts
   line up, it's accepted automatically. If it's plausible but not certain, it's set
   aside for you to confirm — recognition is easy for a human ("oh yes, that one"), so
   the app shows you the close options rather than making you remember part numbers. And
   if nothing fits (the contractor asked for a smoke detector and you don't stock those),
   it says so plainly instead of forcing a wrong answer.

6. **Price it from your rules.** Once a part is settled, the price isn't a mystery
   number. It's your list price, adjusted by *your* rules: a markup on accessories, a
   margin per brand, this contractor's tier discount, an extra break for large
   quantities, and tax on top. And every quote line shows its working — *"−18%
   Contractor Tier A, −2% qty ≥ 200"* — so you, or the contractor, can see exactly how
   the number was reached.

Do that forty times, add it up, and you have a branded PDF quotation ready to send.

## Why it asks you sometimes

You'll notice the app doesn't auto-match everything. That's deliberate, and it's the
feature that earns its trust.

Think about the cost of being wrong in each direction. If the app asks you about a line
that was actually obvious, you lose five seconds confirming it. If the app *guesses*
on a line it wasn't sure about and gets it wrong, you ship a quote with the wrong part
at the wrong price — and that mistake travels. Those costs aren't equal, so the app
leans toward asking. The lines it flags are exactly the ones worth a human glance.

When it asks, you don't have to type anything from memory. It shows you the near-misses
to pick from, or lets you search your catalogue — and when you correct it, it *remembers*,
so the next quote with that same shorthand leans your way.

## Running it

You need a Postgres database (with the pgvector extension) and a Gemini API key — both
already in the repo-root `.env`. Then:

```bash
cd apps/bom-quotation
bun install
bun run gen:bom     # makes a realistic, messy sample BOM (Excel + PDF) to play with
bun run setup       # loads your product list so the app can recognise parts
bun run quote       # quotes the sample BOM → a summary, plus a PDF and a JSON file
```

That last command prints a line-by-line summary (a ✓ for confident matches, a ? for
the ones it wants you to confirm, an ✗ for genuine no-matches) and writes
`data/quote-output.pdf`. Open it — that's what your contractor would receive.

Want the clickable version? Run the backend and the web app:

```bash
bun run serve                 # the API, on :3001
cd web && bun install && bun run dev   # the page, on :3000
```

Now you can drag a BOM in, watch it match, fix anything it flagged, and download the PDF.

## Making it *yours*

Everything specific to your business lives in three plain files in `data/`, not in the
code:

- **`company.json`** — your name, address, currency, the letterhead.
- **`catalog.json`** — your products: code, description, brand, price, and the specs
  that make each one distinct.
- **`pricing-rules.json`** — your tiers, discounts, brand margins, quantity breaks, and
  tax.

Change those, and it's *your* shop quoting *your* prices. You never touch the engine.
(And if you don't keep a catalogue at all — thousands of products, no inventory system
— there's a direction for pricing straight from attribute rules instead; see the
[thought process](./thought-process.md) and the decision records in [`adr/`](./adr/).)

## The mental model, in one breath

A BOM line is a *thing the contractor already has in mind*, written in trade shorthand.
The app translates the shorthand, recognises the part, refuses to confuse variants, tells
you how sure it is, prices it from your rules with the working shown, and asks you about
anything it isn't certain of. That's it. Everything else is detail.
