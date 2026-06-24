# Cisco BOM → customer quote, with no inventory catalog

A real problem: a Cisco CCW estimate gives you 22 priced lines — routers, support contracts,
5-year software subscriptions — and you need to (a) know which is which, (b) reconstruct the
Product / Service / Subscription buckets, and (c) put your own margin on top to quote the
customer. The catch: **you don't keep a Cisco inventory catalog.** So how do you classify a line
you've never seen?

You don't need a catalog. The signal is in the SKU.

## The trick: rule-match on the part number

Cisco's part numbers are systematic, so a handful of regex rules classify every line:

| Prefix | Kind | Cisco disc. |
|---|---|---|
| `CON-…` | service (support / RMA) | 74% |
| `LIC-`, `DNA-`, `TE-`, `SVS-`, `SSP-` | subscription (term license) | 74% |
| `C8…`, `C1…`, `ISR…`, `ACS-…`, `R-OS-…` | product (hardware / perpetual) | 76% |

That's `src/rules.ts` — the same rule-pack idea as the `bom-quotation` app's prefix pricing,
keyed on the part number instead of extracted specs.

## Run it (zero setup — no DB, no LLM, no catalog)

```bash
bun run src/run.ts
```

```
Classified 22 Cisco lines from part numbers alone — no catalog.

  Bucket match vs Cisco:   22/22   ✓
  Discount match vs Cisco: 22/22   ✓
  Needs human review:      0

  Bucket         lines    Cisco net (cost)   margin    DCSL price
  ----------------------------------------------------------------
  product           8         $16,986.34     15%     $19,534.30
  service           3          $7,235.82     20%      $8,682.98
  subscription     11         $31,638.00     12%     $35,434.54
  ----------------------------------------------------------------
  TOTAL            22         $55,860.16             $63,651.82

  Cisco net cost reproduced: $55,860.16  (estimate says $55,860.16)
  DCSL customer quote:       $63,651.82
```

The rules recover Cisco's own classification **22/22** — validated against the discount % and the
bucket each line lands in (from the estimate's `Total` formulas). The buckets reproduce the
estimate totals to the cent, then your per-kind margin produces the customer quote.

## Read a real export

`run.ts` uses a frozen copy of the data; to quote straight from a CCW `.xlsx`:

```bash
bun run src/run-from-file.ts /path/to/Cisco_Estimate.xlsx
```

`src/parse-export.ts` finds the priced sheet, locates the `Part Number` header, and keeps only
real line items (dropping group headers, deployment sub-headers, `Initial Term …` annotations and
subtotals). On the real Micro Solutions export that's **57 lines**, reproducing the same
$55,860.16 net. Two things to note in the output:

- **Discount agrees with the file 57/57** — the export carries Cisco's own `Disc(%)`, so the run
  self-validates the classification (no hand-labelled truth needed).
- **11 lines trip the review gate** — the long-tail `$0` bundled SKUs (`L-DNA-T0-5M`,
  `SDWAN-CLOUD-PF`, IOS images…) whose prefixes the rules don't cover. They don't affect the
  total, but they're flagged rather than guessed — which is the honest behaviour, and exactly the
  set samesake's enrichment would classify from the description.

## Where samesake fits

The rules are the reliable core. samesake adds two things on top:

- **`matcher.facets()`** — push the classified lines into a collection and roll the buckets up with
  the query-free aggregation (no SQL against an internal table). See `src/samesake.ts`:
  ```bash
  DATABASE_URL=… bun run src/samesake.ts
  ```
- **The enrich pipeline** — for the long tail the prefix rules miss (an OEM you haven't ruled, an
  oddly-named SKU), samesake's LLM enrichment classifies it from the *description* into the same
  `kind` — so you never build or maintain the catalog. Anything still ambiguous trips the
  **review gate** (`confident: false` in `src/classify.ts`) instead of being silently mispriced.

## Honest limits

- **samesake doesn't invent Cisco's list prices.** Here the net cost came from the CCW estimate;
  the example applies *your* margin on that net. To start from list, you still need a Cisco price
  feed.
- **Classification isn't magic.** Prefix rules are the dependable part; enrichment fills gaps; the
  review gate is what keeps a wrong guess off the quote. That gate — not the LLM — is what makes
  it trustworthy.

Data in `data/cisco-bom.ts` is the real Micro Solutions / DCSL 5-year SD-WAN BOM; Cisco's own
discount / net / bucket are kept only to validate the rules.
