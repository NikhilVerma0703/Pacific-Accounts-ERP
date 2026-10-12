# Business context — the reference for every future task

This file records the understanding the system is built on. Later phases should be checked
against it rather than re-explained.

## The company

A stone manufacturing company selling both **domestic** and **export**. Accounts works
alongside **Tally** and the **e-Invoice / IRN** process — this tool complements them, it does
not replace them.

## The current workflow

```
Commercial Team → Final Commercial Invoice → Accounts Verification → e-Invoice / IRN
→ Tally Entry → Accounts Excel / MIS → Payment & Receipt Tracking → Outstanding / Balance
→ Due / Overdue → CN / DN → Shipping & Export Information → INR / Exchange / Forex
→ Status & Remarks → Management Tracking
```

## The problem

The Accounts employee maintains a large Excel/MIS by hand. The same information is typed
again and again from documents that already contain it.

> "If I have to manually enter everything again into your ERP, then what is the point?"

## The governing principle

**Enter or upload once → extract, reuse and calculate automatically → minimum manual entry.**

Every design decision is judged against that sentence. A feature that adds typing has to
earn its place.

## Where each piece of information comes from

| Source | Supplies |
|---|---|
| **Commercial Final Invoice** (Phase 1) | invoice no./date, parties, PO/PI, terms, currency, product, quantities, weights, totals, ports, container, HSN, GSTIN/IEC/LUT, bank, AD code, and the exchange rate when printed |
| **e-Invoice / IRN** (Phase 2) | IRN, acknowledgement no., e-Way Bill, portal values to compare against |
| **Tally** (Phase 2) | voucher reference, booked INR amount, customer code, ledger position |
| **Payment / bank data** (Phase 2) | receipts, receipt dates, receipt exchange rates |
| **CN / DN** (Phase 2) | adjustments against an invoice |
| **Shipping team / liner** (Phase 2) | shipping bill no. & date, BL no. & date, vessel, ETA, arrival |
| **Customer master** | customer code, sales person |
| **Calculated** | INR value, outstanding, payment %, due date, overdue days, forex gain/loss, balance per books vs per customer |

The field catalogue (`src/lib/extraction/catalog.ts`) carries this as the `origin` of each
field, which is why the UI can explain a blank instead of just showing one.

## Rules that must not be broken

1. **Never fabricate.** If a value is not on the document it is *Missing* or *Not Present*,
   with the reason — not a guess.
2. **Never invent a business rule.** A payment term such as "100% CAD" does not by itself
   imply any credit period. Due dates come only from rules the company configures.
3. **Say where a value came from.** Every extracted value keeps its source cell / line.
4. **Flag inference.** Anything derived from layout rather than an explicit label is marked
   *Needs verification* with an explanation.
5. **Keep extraction and business logic apart**, so a new document source never disturbs the
   Accounts rules and vice versa.
6. **Prevent duplicates** by file checksum and by invoice number.
7. **Keep an audit trail** of every manual correction.

## Phase plan

| Phase | Scope | State |
|---|---|---|
| **1** | Commercial invoice → upload → read → extract → structure → Accounts table | **built** |
| 2 | Payments & receipts, outstanding, due/overdue, CN/DN | tables exist, screens pending |
| 3 | Tally & e-Invoice comparison, mismatch reporting | extractor slot ready |
| 4 | Shipping updates, reminders, management reports & MIS export | navigation in place |

## What "success" means for Phase 1

An Accounts employee uploads the final commercial invoice and the maximum useful Accounts
information is organised for them automatically, with the remainder clearly identified as
something to fill in or something that arrives later.

## Implementation note

Phase 1 was first proven as a Python reference implementation against the real invoice, then ported
to TypeScript so the Accounts module matches the rest of the Pacific Surfaces ERP (Next.js 15,
Prisma, Auth.js v5, Inngest). The port is verified by re-running the reference implementation's
assertions against the same invoice — see `tests/extraction.test.ts`. Both implementations produce
identical values for every field, from the Excel and the PDF form of the document.
