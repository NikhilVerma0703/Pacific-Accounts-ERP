# Accounts Automation — Pacific Surfaces

**Upload the final Commercial Invoice → it is read, extracted, structured and turned into an
Accounts register row.** Nothing is re-typed that the document already contains, and nothing that
the document does not contain is ever guessed.

This build is **local-first**: no sign-in, no Docker, no database server. A SQLite file in the
project folder holds everything.

| | |
|---|---|
| Framework | Next.js 15.5 (App Router) + TypeScript + Tailwind v4 |
| Database | SQLite file via Prisma 6 (`prisma/dev.db`) |
| Jobs | Inngest 4 — optional, off by default |
| Extraction | `exceljs` (Excel) + `pdfjs-dist` (text PDF), pure TypeScript |
| Auth | none in this build — see *Adding sign-in back* below |

Every screen is built: import, manual entry, the register, invoice detail, payments & receipts,
shipping & export, Tally & e-Invoice, reports & MIS and the dashboard. What is deliberately **not**
built is the two integrations — the Commercial ERP feed and the Tally / e-Invoice feed — and both have
their boundary in place, so writing them does not change the register.

---

## Run it

```bash
copy .env.example .env      :: Windows   (cp .env.example .env on macOS/Linux)
npm install
npm run db:push             :: creates prisma/dev.db — run it again after any schema change
npm run dev                 :: http://localhost:3000
```

That's the whole setup. Open the app, go to **Import Invoice** and drop in your commercial invoice —
`tests/fixtures/sample_invoice.xlsx` is there if you want to try it with the one already tested.

### Checking it works

```bash
npm test        # extraction, register, payment terms, the four real payment
                # sheets, editability, currency formatting, exports.
                # No database, no network.
npm run verify  # full stack against SQLite: imports the sample invoice, prints the
                # Accounts row, checks duplicates, a correction, a due-date rule,
                # receipts / notes / the balance, the reports and deletion — then
                # all four customer payment sheets through Payment Tracking, and a
                # check that the register was untouched. Cleans up after itself.
```

`npm run verify` is the one that proves the database path end to end. Run it once after `db:push`.

### Useful commands

| | |
|---|---|
| `npm run db:studio` | browse the SQLite data in Prisma Studio |
| `npm run db:reset` | wipe and recreate the database |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | production build |

---

## What it does today

| Step | Where |
|---|---|
| Upload one or many invoices (.xlsx / .xlsm / text PDF) | **Import Invoice** |
| Create a complete record by hand, with receipts and notes | **Manual Entry** |
| Record receipts against an invoice, with forex gain/loss | **invoice → Receipts → + Add Receipt** |
| See every receipt, what is outstanding and the forex position | **Payments & Receipts** |
| Import receipts from a payment sheet or remittance advice | **Payments & Receipts → Import receipts** |
| Record credit / debit notes | **invoice → Credit / Debit notes** |
| Read → extract → normalize → validate → Accounts row | automatic, in the upload request |
| Review every field with its status, source cell and reason | **invoice detail** |
| Correct anything, with an audit trail | invoice detail → *Edit* on any field |
| Edit the line items — every cell, add or clear a row | invoice detail → **Line items** |
| Delete an import — file, register row and corrections together | register row → *Delete*, invoice detail, or *Undo this import* |
| Search / filter / export the register to Excel or CSV | **Accounts Register** |
| Fill in and track PI/PO, shipping bill, BL, container and ETA | **Shipping & Export** |
| Record IRN, e-Invoice status, Tally voucher and the books value | **Tally & e-Invoice** |
| See the position at a glance — invoiced, received, outstanding, what needs attention | **Dashboard** |
| Seven reports over one filter set, each exporting to Excel or CSV | **Reports & MIS** |
| Define the company's own due-date rules | **Settings** |
| Track what customers owe from their own payment sheets — a separate system, needing no invoice upload | **Payment Tracking** |
| Upload a customer payment sheet of any layout, and see exactly what was read | **Payment Tracking → Upload Sheet** |
| Enter a payment record by hand with no required fields at all | **Payment Tracking → New Record** |
| Adjust receipts, rates, CN/DN for a whole customer in one editable register | **Payment Tracking → a customer** |
| Edit any field of any record, imported or typed, and see what was overwritten | that record's own screen |

### Deleting an import

One action, three places to reach it: the **Delete** button on any register row, the *Remove this
import* card on the invoice detail screen, and *Undo this import* on the import results — for the
moment you realise you picked the wrong file.

Whichever you use, it removes the same things together: the uploaded file, that invoice's row in the
Accounts Register, and the corrections recorded against it. There is no state where the file is gone
but the row remains, or the other way round. Deleting also releases the invoice number and the file
checksum, so **the same document can be imported again straight afterwards** — useful when a
commercial invoice is reissued.

It always asks first. The button turns into a short question naming the invoice and the file, and
nothing happens until you confirm — no browser pop-up, and no way to delete a row with one stray
click. The removal is written to the import log (visible on the dashboard and in Settings), so the
register can still account for a row that is no longer there. It cannot be undone otherwise.

### Editing: every field, however it got there

Every stored field in the application has an edit box, and an imported value is
no more protected than a typed one. An invoice uploaded from a sheet that filled
13 of its fields is the same record as one typed by hand: the other 12 are filled
in later through the same form, and any of the 13 can be corrected.

| Where | How |
|---|---|
| Any of the ~90 catalogue fields on an invoice | **invoice detail** → the field's *Edit* |
| Commercial / shipping, Tally / e-Invoice | their blocks on the invoice screen, saved as a group |
| Line items — every cell, add a row, clear a row | **invoice detail → Line items** |
| Receipts and credit / debit notes | their panels, *Edit* on any row |
| A Payment Tracking invoice, receipt, note or customer | that record's screen |

Three rules make this safe rather than merely possible.

**A form can only change what it showed.** A blank box clears its value — that is
deliberate, so a withdrawn payment term does not linger. But a field whose input
was *not on the form* keeps what it had. The two are indistinguishable in a
submitted form unless somebody distinguishes them, and the cost of not doing so
was real: the inline receipt row showed four of a receipt's five fields, so
correcting an amount wrote a blank over the remittance note the importer had
stored in the fifth, silently, on a field nobody was looking at. Both sections
now write only what they were given, and every inline form carries every field
its action can write — which `tests/editing.test.ts` checks by reading the forms.

**A derived figure is recalculated, not retyped.** Editing a line item recomputes
*Sum of Line Items* from the rows as saved and re-runs the cross-check against
the invoice total; it is labelled *added up from the line items*, never
*entered*. Balances, differences and forex are not editable anywhere, in either
section, because they follow from the receipts and the rates — one function
computes them for the screen, the register and the export, so the three cannot
disagree.

**Provenance is not editable.** Where a record came from — the source file, the
sheet's as-on date, which row — is reported, never typed. A record of a value's
own origin that can be retyped is not a record.

### Correction history

The register records every field change with its old value, new value, time and
author, and shows it on the invoice. **Payment Tracking now does the same**, in
`pt_field_edits`, covering invoices, receipts, notes and customer records.

It earns its place there for a specific reason: about half the figures in that
section arrive from a customer's own spreadsheet, and *Received 59,651.63* reads
identically whether the customer said it or we did. So each entry also records
whether the record came from an upload, and the invoice screen carries an
**Overwritten from the uploaded sheet** block — each imported value that has
since been changed by hand, and what the sheet said. The history itself is the
one read-only thing in the section; a correction history that can be corrected is
not one.

### Field statuses — the point of the whole design

| Status | Meaning |
|---|---|
| **Extracted** | Read directly off the invoice, with the cell reference recorded |
| **Calculated** | Derived from reliable fields (INR value, invoice type, outstanding) |
| **Needs verification** | Found, but inferred or ambiguous — the reason is shown |
| **Missing** | The field *is* on the invoice and the cell is blank |
| **Not present** | Not on this document — it comes from Tally / bank / shipping / e-Invoice |

An Accounts employee never has to wonder whether a blank means "not read" or "not there".

---

## The Accounts register

The column set is **not fixed**. It is:

```
Sl. No. … Currency  │  Receipt 1  │  Receipt 2 …  │  CN … Overdue Days
                       (5 columns)  (5 columns)
```

| Block | Columns |
|---|---|
| **Invoice** | Sl. No., Invoice Date, Invoice No., Customer Invoice Value, Customs Value / As per Books, Exchange Rate, Consignee, Notify Party, Payment Terms, Currency |
| **Each receipt** | Receipt *n* Date, Receipt *n* FCY, Exchange Rate for Receipt *n*, Difference *n*, Forex Gain/Loss *n* |
| **After the receipts** | Credit Note (CN), Debit Note (DN), Balance as per Books, Balance as per Customer, Status, PI / PO No., PO No., Shipping Bill No., Shipping Bill Date, BL No., BL Date, Container No., ETA / Arrival Date, Due Date, TODAY, Overdue Days |

Receipt 1 is always shown, even before any receipt exists — its cells say *no receipt recorded yet*
rather than sitting blank. **+ Add Receipt** on the invoice screen adds Receipt 2, and the register
grows by five columns on its own; the number of groups is simply the most receipts any invoice on
screen has. There is no fixed limit.

### The three formulas

```
Difference n      = Receipt n Exchange Rate − Invoice Exchange Rate
Forex Gain/Loss n = Difference n × Receipt n FCY          (positive = gain, negative = loss)
Balance           = Invoice Value − Σ Receipt FCY − CN + DN
```

None of these is ever typed in or stored as a figure someone could edit. They are recomputed from
the receipts and notes every time a row is built, so adding a receipt, changing an amount or
recording a note moves them immediately — and they cannot drift away from the numbers they come
from. Where a receipt has no exchange rate, Difference and Forex stay blank and say why; the balance
still moves, because it does not need a rate.

*Balance as per Books* stays blank: it is Tally's figure, and the same formula will run on it once
that source is connected. It is never assumed from the invoice.

### Status

Worked out from what has actually been recorded, in this order — the order *is* the business rule:

| | |
|---|---|
| **Missing Information** | the invoice value could not be read, so the position cannot be trusted |
| **Paid** | nothing outstanding, whatever the due date says |
| **Overdue** | past the due date — said even when part paid, because that is what needs action |
| **Partially Paid** | some money in, not yet due |
| **Unpaid** | nothing received and no due date known yet |
| **Due** | falls due within the window set in Settings (a week by default) |
| **Not Due** | later than that |

A credit note counts as settled, a debit note as more owed, so the status and the balance always agree
— both come from `Invoice Value − Receipts − CN + DN`. Hovering the Status cell shows the working:
*"10,000.00 of 18,348.49 settled across 1 receipt(s), 8,348.49 outstanding, due 2026-11-30."* No Tally
value is ever invented to reach a status.

### Due date, TODAY and overdue days

**Due Date is only ever calculated from a rule you configured in Settings.** A payment term like
`100% CAD` implies no number of credit days on its own, so without a matching rule the cell reads
**Pending / requires verification** — not a blank, which could be taken for "no credit period" — and
the note says exactly what is missing. **TODAY** is the system date, recomputed on every render.
**Overdue Days** is Today − Due Date; before the due date it reads **Not due (11d)** rather than a bare
`0`, which reads like a problem that has just started. The stored value stays `0` so the column still
sorts and sums.

### Shipping & Export

PI/PO No., PO No., Shipping Bill No. and Date, BL No. and Date, Container No., Vessel and ETA — all
editable on the invoice screen as one block, and listed across every invoice on **Shipping & Export**
with a count of what each one is still waiting on. Nothing is guessed: a blank means the shipping team
has not supplied it.

These are exactly the fields the Commercial ERP already holds, so that screen is where an automatic
feed will appear. The adapter produces `CommercialUpdate` objects for `applyCommercialUpdate`
(`src/server/commercial.ts`); `POST /api/commercial/sync` is the endpoint, and a value typed in by
hand is never overwritten by a sync.

### Tally & e-Invoice

| Field | From |
|---|---|
| IRN, Ack No., Ack Date, e-Invoice Status, E-Way Bill No. | the e-Invoice / IRP |
| Books Value, Books Value (INR), Tally Voucher No. / Date, Ledger | Tally |

**A books figure is Tally's, never the invoice's.** Until a real value arrives, *Customs Value / As per
Books* and *Balance as per Books* read **Pending Tally** — they are never filled from the invoice
total, because a books column that copied the invoice would make the invoice-versus-books comparison
always read zero and look reconciled when nothing had been checked.

Once a books value exists — typed in on the invoice, or later from a Tally export — the same balance
formula runs on it (`Books Value − Receipts − CN + DN`), and **Invoice − Books** appears on the invoice
screen and on the **Tally & e-Invoice** screen, which flags every invoice that disagrees with the
books. The difference is deliberately *not* a register column: the 16 trailing columns are fixed.

The future integration is one adapter producing `BooksUpdate` objects for `applyBooksUpdate`
(`src/server/tally.ts`), with `POST /api/tally/sync` as the endpoint — refused with 501 until
`COMMERCIAL_ERP_SYNC="true"`. Uploading an e-Invoice PDF or a Tally export means writing one reader
that emits these catalogue keys; the register, the exports and both screens already read them, so
nothing downstream changes.

### Payments & Receipts

One screen for the receivable position: per-currency totals (invoiced, received, CN, DN, outstanding,
forex gain/loss), then a row per invoice listing each receipt with its difference and forex, the
balance, the due date and the status — with a **+ Receipt** shortcut straight to that invoice. Amounts
in different currencies are never added together; each currency gets its own totals.

The invoice screen carries the same figures as a **Receivable position** panel, laid out as the
formula so it can be read down: invoice value, less receipts, less CN, plus DN, balance — then Balance
as per Books marked *awaiting Tally*, the forex total, and the status with its reasoning.

### Receipts: typed in, or read off a document

Both routes end in the same `saveReceipt`, writing the same fields, so an imported receipt and a
typed one are the same record — only `source` says which.

* **By hand** — invoice screen → *Receipts* → **+ Add Receipt**: date, FCY, rate, bank reference.
* **From a document** — **Payments & Receipts** → upload the payment sheet or remittance advice
  (.xlsx / .xlsm / text PDF). The reader finds the table, matches each line to its invoice by
  invoice number, and adds it as that invoice's next receipt.

The importer will not guess. No invoice number, no posting; a number that does not match one in the
register exactly, no posting. Every line it leaves out is listed with the cell it came from and the
reason, so it can be entered by hand. A different bank's wording is a one-line addition to the
header dictionary in `src/lib/extraction/receiptReader.ts`.

## Two ways in: import, or type it

Import still fills sixty-odd fields from one upload and is unchanged. **Manual Entry** (sidebar, or
*Create New Record* on the register) is the other door into the same register: one save produces the
same row — same columns, same statuses, same formulas — for an invoice that never arrived as a file,
and for building up practice records to test the register against.

The form covers every column an invoice could fill, grouped as Invoice / Parties / Commercial &
shipping, plus optional **receipts** and **credit / debit notes** so one save exercises the whole row
rather than needing a second trip to the invoice screen. What it cannot offer is exactly what no
invoice carries: Tally's two columns, the system's Sl. No. and TODAY, and everything calculated.

Built for repeated entry:

* **Create & add another** stays on the page and clears the form.
* **Fill with example values** pre-fills obviously-fake data — `DUMMY/003`, *Test Consignee Ltd* — and
  suggests the next free dummy number, so a practice record can never be mistaken for a real invoice.
  Every value is editable before saving.
* A rejection (a duplicate invoice number, say) is reported without throwing away what was typed.

Values typed in are marked as entered by a person, which is the highest-precedence source in the
system — see below. `tests/manual.test.ts` asserts the parity: same column set as an imported row,
same formulas, same honesty about blanks.

## Where each value comes from, and what may overwrite it

| Source | Fills |
|---|---|
| **Commercial / invoice** | invoice, party, PO/PI, shipping and container fields |
| **Receipt / payment** | receipt date, FCY, rate, bank reference |
| **Tally** | Customs / Books value, Balance as per Books |
| **System** | difference, forex, balance, due date, status, TODAY, overdue days |

Precedence, applied wherever values meet:

```
entered by a person  >  read from a document  >  synced from another system  >  derived
```

A sync never overwrites a person. A value already read off the invoice is not replaced by a sync
unless that sync is explicitly marked authoritative. Derived values are recomputed freely, because
they are not anyone's input.

## Ready for the Commercial ERP

The integration is **not built**. The boundary it will plug into is, in `src/server/commercial.ts`:

```ts
applyCommercialUpdate({ invoiceNo, sourceSystem, values })   // one invoice
applyCommercialUpdates([...])                                 // a batch
```

`POST /api/commercial/sync` is the endpoint the Commercial ERP will call, refused with 501 until
`COMMERCIAL_ERP_SYNC="true"` — deliberately, because it writes to the register and has no
authentication yet.

What is already decided: the invoice number is the match key (the external id is carried alongside);
the Commercial ERP owns PI/PO, shipping bill, BL, container, ports and ETA and nothing about money;
and every synced field is written into the same audit trail as a manual correction, so "who changed
this" has one answer. Writing the integration means producing `CommercialUpdate` objects. Nothing in
the Accounts module changes.

### The two exports

| | |
|---|---|
| **Export Excel** | For reading, printing and sending. Every column is sized to its longest printed value — a date is 11 characters wide, not the 60 its stored form would suggest, and no cell shows `#####` or hides its tail behind the next column. Anything longer than 52 characters wraps instead of running off the page. Money and dates stay *typed*, so they sort, filter and total. Set to print landscape, fit to one page wide, with the header row repeated. |
| **Export CSV** | For feeding another system. Every value complete, money as plain numbers (`18348.49`, not `18,348.49`, so `SUM` works), dates as `12-Sep-2026`, UTF-8 BOM and CRLF so Excel opens it correctly on any Windows locale. |

A CSV file cannot carry column widths — that is the format, not this export. Opened in Excel its
columns arrive at the default width, so **use the Excel export when it has to look right**.

**Party columns are short on screen, complete in the file.** The register shows `Ciot Inc` so the
table stays readable; the export writes the whole block as printed on the invoice — `Ciot Inc, 9225
Boul Saint-Laurent, Montreal, QC H2N 1N2, Canada, Tel: 514 389 6540`. Hovering the cell on screen
shows the same thing. Any cell can do this: set `full` on it in `buildAccountsRow`.

### An improvement to the reader reaches invoices you already imported

Every invoice is stamped with the version of the reader that produced it
(`EXTRACTION_VERSION` in `src/lib/extraction/index.ts`). When the reader learns to read something it
used to miss, invoices below that version are **read again from the file they were imported with** —
the file kept with every invoice exists for this — the next time the register or that invoice is
opened. Up to 25 per page load, so one screen never turns into a minute; the rest follow, and a note
says how many were re-read.

**Manual corrections survive it.** A re-read replays every correction from the audit trail on top of
the fresh extraction, so nothing anyone typed is ever undone by re-reading the document. Settings →
*Re-extract every stored invoice* does the same thing on demand.

Bump `EXTRACTION_VERSION` whenever the reader gains a field, a label or a fix. Without it, an
improvement only ever reaches invoices uploaded after it.

### Changing the columns never blanks the register

Each row is saved at import time and stamped with `ROW_VERSION`. When the column set changes, rows
saved under an older version are rebuilt from the extraction already stored with the invoice — the
original file is kept too — and written back, the first time the register is opened. Nothing has to
be re-uploaded, and a new column can never render blank for data the system already holds.
`src/server/registerRows.ts` does this; bump `ROW_VERSION` in `src/lib/business/accounts.ts`
whenever a column is added, removed or given a new meaning.

---

## The sidebar

Six areas, not eleven entries. A group heading is a link to that area's main
screen, and its children appear only while you are inside it — so the list is short
at rest and nothing is more than one click away.

```
Dashboard
Invoices          Accounts Register · Import Invoice · Manual Entry ·
                  Shipping & Export · Tally & e-Invoice
Payments          Payments & Receipts · Import Receipts
Payment Tracking  Master Table · Upload Sheet · New Record
Reports & MIS     Invoice Register · Payment / Receipt · Outstanding & Ageing ·
                  Credit / Debit Notes · Customer Outstanding · Shipping / ETA ·
                  Currency Summary
Settings
```

**Outstanding & Ageing**, **Credit / Debit Notes** and **Customer Outstanding** are
views of the reports page and are reachable there only. **Payment Tracking** is an area of its
own because it is a separate system, not a seventh report — see the section below.
`tests/nav-structure.test.ts` checks the navigation against the routes that
actually exist, in both directions: a page with no nav entry fails, and so does a
nav entry pointing at a page that is not there.

The highlight is worked out from the pathname alone. Reading the query string would
mean `useSearchParams` in the shell, which opts every page out of static rendering
and undoes the navigation-speed work — so inside Reports the heading is the marker,
and which report is open is shown by that page's own tab strip.

## Payment Tracking

A **separate system** for tracking what customers owe, living in the same application and sharing
nothing with it. It was asked for that way, and the separation is the point: it has to work from
customer payment sheets and typed-in records alone — no commercial invoice, no Tally, no Commercial
ERP as a prerequisite.

So it has its own tables, its own importer, its own payment-term engine, its own calculations, its own
screens and its own export. Nothing above this line feeds it and nothing below it feeds the register.

### The separation is enforced, not intended

Every table is prefixed `pt_` so the split is visible in a database browser, and
`tests/navigation.test.ts` fails the build if it ever blurs:

* nothing under `src/lib/payments/**` or `src/server/payments/**` may import a register module
  (`business/accounts`, `server/ingest`, `server/receivables`, `server/reports`, …)
* nothing in the register may import `@/lib/payments` or `@/server/payments`
* the section's queries may touch `prisma.pt*` and nothing else
* `exceljs` may appear in the upload screen's bundle and nowhere else in the section

`scripts/verify-local.ts` then checks the same thing against the database: it counts every register
table before the Payment Tracking checks run and again afterwards, and fails if a single row moved.

### Two ways in, and neither is required

**Upload a sheet.** `/payment-tracking/import` reads an Excel file and finds its shape rather than
assuming it. The four reference sheets have four layouts: the header row is on row 3, 5, 6 or 31, the
customer's name is in a labelled cell on three of them and only in the tab name on the fourth, one
carries the payment term in a header cell instead of a column, one has no payment terms at all, and
one holds two stacked tables. 27 fields are matched by pattern, so *Invoice No. / Inv No / Invoice
Number* all land in the same place.

The upload reports itself: **which sheet column became which field**, which headings matched nothing
(and were therefore not imported), what each payment-term wording was understood to mean, what
changed, and what is worth knowing. A silent importer is one nobody can trust with their own data.
Imports are **re-runnable** — invoices are matched on invoice number within the customer, so a
refreshed sheet updates what it recognises instead of duplicating it. The same file byte-for-byte is
refused unless you ask for it again, and a **dry run** reports everything and writes nothing.

**Type it in.** `/payment-tracking/new` has **no required field — not one, not even the invoice
number.** There is no `required` attribute in any input on any screen in this section (a test
asserts it), and no validation that refuses a save. Save what you know now, come back to the rest,
and the record tells you what it is still missing. The create form starts with three receipt slots;
once saved, the invoice screen has **Add Receipt** with no limit at all.

Three rules the reader works to, each learned from a specific defect in the real sheets:

**Never believe a printed total.** One sheet's invoice-value total is `=SUM(G32:G52)` over a
23-row table, so it omits two invoices of 35,811.09 each — **71,622.18** — and a cell below subtracts
that broken total from a good one and presents the shortfall as a disagreement with the customer. It
is not one: once the rows are added up, the two blocks agree exactly. Totals are always recomputed,
and the printed ones are kept only so the difference can be reported.

**Merged cells are read at their master.** Excel answers with a merged range's master value from
every cell in the range, so a total row whose label spans four columns says "Total" when asked for its
invoice number — and reading that as a data row doubles every figure on the sheet. Three of the four
sheets do this.

**A working cell is not a data row.** `=SUM(G6:G10)` parked in column M, and `=G27-G55` sitting below
a table, are reported as stray cells with their formulas rather than imported as invoices.

### Payment terms, worked out independently

`src/lib/payments/terms.ts` owes nothing to the register's rule table. It reads a term as written and
says what it understood:

| Written | Understood as |
|---|---|
| 120 Days From BL Date | 100% due 120 days after the BL date |
| 90 Days From BL | 100% due 90 days after the BL date |
| 100% CAD | 100% due when the documents are presented to the bank |
| 70% CAD + 30% at 90 Days | 70% on presentation, 30% ninety days after the BL date |

Each milestone carries its own percentage, its own number of days and its own date basis — BL date,
invoice date, ETA, documents presented, or shipping bill date — and money settles against the earliest
milestone first. Percentages split the invoice value exactly, with the rounding remainder on the last
portion.

**A date is never fabricated.** If the basis the term counts from is not on the record — a CAD term
with no presentation date, a 90-day term with no BL date — the invoice gets **no due date** and is
reported as *Requires Verification*. It does not fall back to the invoice date, and it is never
reported as overdue: the status ladder tests `REQUIRES_VERIFICATION` **before** `OVERDUE`, and a test
asserts that order. Where the wording leaves something unsaid ("90 days" without saying from what),
the assumption made is recorded and shown.

The brief's worked example runs as a test: BL **30-May-2026** + 120 days = **27-Sep-2026**, and as at
09-Oct-2026 that is **12 days** overdue.

### The calculations

Stated once, in `src/lib/payments/money.ts`, and used by every screen:

```
Exchange Rate Difference  =  Receipt Rate − Invoice Rate
Forex Gain / Loss         =  Difference × Receipt Amount (FCY)
Balance as per Customer   =  Invoice Value − Σ Receipts − Σ CN + Σ DN
```

Rates are **home currency per one unit of foreign currency**. Forex is totalled **per receipt**, not
from a blended rate, and a missing rate yields *no figure* rather than zero.

**Balance as per Books is never part of that sum.** It arrives from the books with its own receipts
already applied, so subtracting ours again would count them twice. It is held beside the calculated
balance and the **difference between them is reported** — which is the whole reason to keep both.

Nothing is stored: every figure is recomputed on read, so changing a receipt, a date or a term shows
up immediately in the master table, the dashboard, both detail screens and the export at once.

### The master table

One wide table, 50-plus columns in seven groups across a two-row header, scrolling horizontally:
invoice · terms & due · receipts · balances · documents & shipping · notes · source. Every row
expands to show its milestones, its receipts with each one's rate difference and forex, and why it
needs attention. Headings are links, so sorting is in the URL — and so is every filter, which is how
the export is guaranteed to be what was on screen.

Search covers **customer name and invoice number** (and PO, PI, container, BL, terms and remarks).
Filters: customer, currency, status, ageing bucket, PO, payment term, a date range over the invoice /
due / receipt / BL date, needs-attention, nothing-received, requires-verification and open-items-only.
Grouping: none, customer, invoice month, PO or status.

### The customer payment register

The customer screen lists one row per invoice with its totals: value, rate,
INR value, number of receipts, received (with a collected bar), CN, DN,
outstanding, balance as per books, due date and status. Click a row (or
**Expand all**) to open it:

- **Invoice details**: invoice no., date, terms, value, invoice rate, BL no.,
  BL date, due date, CN, DN, balance as per books and remarks, all editable.
- **Receipts**: listed one under another, exactly as many as the invoice has
  (three for one invoice, four for the next), each with date, amount, rate and
  bank reference, and the derived **difference** and **forex gain/loss**.
  **+ Add receipt** adds as many new lines as needed; there is no limit.

Closing a row keeps what was typed in it. An amber dot marks invoices with
unsaved changes, and a bar at the bottom saves or discards them all at once.
Only what differs from the stored record is written, every change goes into
the correction history, and a save that fails keeps everything entered. The
derived figures are never inputs: they are computed by the same functions the
invoice screen uses, so the two cannot disagree.

An invoice carrying two or more credit (or debit) notes shows their total as a
link instead of an input; those are edited individually on the invoice.

### Currency formatting

The grouping follows the currency, not the reader:

```
USD   $1,331,027.96      lakh grouping would be the wrong number
INR   ₹13,31,027.96      thousands grouping would be the wrong number
```

One function, `src/lib/money.ts`, with the locale per currency and a test that
fails if a USD figure ever picks up Indian grouping again — which is what the
whole application used to do, symbol-less, including on the dashboard KPIs.
A currency nobody has configured prints its ISO code beside the number rather
than borrowing another currency's symbol.

**Forex gain/loss and every "home value" are rupee figures** whatever the
invoice is denominated in, because the rate is rupees per unit of foreign
currency — so they use the home formatter, not the invoice's. A separate test
asserts that too.

### Foreign currency to INR

Each invoice carries its FCY amount, its exchange rate and the INR equivalent
computed from **its own rate** — the book value of the receivable. The dashboard
shows an INR strip per currency, and where more than one currency is present, a
combined INR total across all of them.

Every INR figure states how many invoices it covers. An invoice with no rate
contributes **nothing, never zero**: a zero would be added into the total as if
the invoice were worth nothing at all. With the four reference sheets none of
the 41 invoices carries a rate, so these figures stay empty until rates are
entered — which is the honest state, not a bug.

### The dashboard

Per currency, never across it. Five tiles:

| | |
|---|---|
| **Total invoice value** | with invoice and customer counts |
| **Total received** | and the collection rate |
| **Total outstanding** | value − receipts − CN + DN |
| **Overdue — with its denominator** | overdue can only be computed where a due date exists, so the tile prints how much of the book that covers and how much cannot be assessed at all. A percentage with a hidden denominator is how a correct number produces a wrong decision |
| **Needs attention** | and why |

Then a customer-wise summary table, and status chips: Paid · Partly Paid · Nearly Settled · Unpaid ·
Due Soon · Overdue · Overpaid · Requires Verification · No Value. All of it computed from this
section's own data and nothing else.

### The screens

| Route | What it is |
|---|---|
| `/payment-tracking` | the dashboard, the filter bar and the master table |
| `/payment-tracking/import` | upload a sheet, and the report of what was read; also lists and deletes past uploads |
| `/payment-tracking/new` | enter a record by hand, nothing required |
| `/payment-tracking/customer/[id]` | one customer: their KPIs, their invoices, their defaults |
| `/payment-tracking/invoice/[id]` | one invoice: its term explained milestone by milestone, **Add Receipt** with no limit, CN/DN, what it is still missing |
| `/api/payment-tracking/export` | the master table as Excel or CSV — 44 columns, the same filters, a receipt-by-receipt sheet, and a note explaining every calculated column |

### What the reference sheets actually contain

41 invoices across 4 customers, all USD, **1,331,027.96** invoiced and **581,592.25** received.
More than half have no payment terms at all, so they have no due date, and the dashboard says so in
figures rather than leaving a blank that reads as *fine*.

| Sheet | Invoices | Value | Received |
|---|---|---|---|
| Fair Deal Marble | 9 | 348,688.54 | 59,651.63 |
| Partner Kamienia | 4 | 127,137.02 | 0 |
| Blue Planet Inc | 5 | 195,741.04 | 73,964.10 |
| Terry Stone | 23 | 659,461.36 | 447,976.52 |

`tests/payment-sheets.test.ts` asserts every one of those figures against the real files.

## The management view

**Dashboard** — five headline figures (invoices, invoiced, received, outstanding, *needs attention*),
then the six payment states as tiles that link straight into a filtered register, then: needs-attention
list (overdue money, plus anything whose invoice value could not be read), outstanding by customer,
per-currency totals, ageing buckets, and recent activity. Every figure comes from `loadReceivables`,
which uses the same `balanceFrom` / `receiptMaths` / `paymentStatus` as the register — the dashboard
cannot disagree with the register, because it is not a second calculation. No charts: at this data
volume a number is easier to read than a picture of a number.

Where invoices exist in more than one currency, the headline totals say so and point at the currency
summary, because a USD + EUR total is only a rough sense of scale.

## Reports & MIS

| Report | What it answers |
|---|---|
| **Invoice Register** | every register column, as the register shows it |
| **Payment / Receipt Report** | one row per receipt with its rate, difference and forex gain/loss |
| **Outstanding & Ageing** | past due, oldest first, with ageing buckets |
| **CN / DN Report** | every note, its effect on the balance, and the balance now |
| **Shipping / ETA Report** | shipping bill, BL, container, ETA — and what is still waiting |
| **Customer Outstanding** | one row per customer: invoiced, received, outstanding and the oldest item |
| **Currency-wise Summary** | totals per currency, never added across them |

These report on the **Accounts Register**. Payment Tracking's own customer summary is a different
thing from a different source, and the two are not expected to agree — one is the register, the other
is what the customer's sheets and Accounts' own entries say.

One filter set serves all seven: search, invoice date from/to, customer, currency, status, payment
state (paid / partly paid / unpaid) and overdue-only. **What is on screen is what exports** — the
screen and the export route call the same `buildReport`, so the numbers cannot differ.

The Excel file keeps the styling, the column widths and the full party blocks the register export uses,
puts the totals row in bold, and adds an **About this report** sheet carrying the report's note and the
time it was generated — so a copy sent to management still explains itself.

## Why navigation is fast

Four things were making a section change take seconds. None of them was the network.

**1. Every screen carried the document readers.** `exceljs` is 23 MB of module graph and
`pdfjs-dist` is 37 MB. The register imported `server/ingest` only to call `loadRules()`, and in Next a
route inherits the whole server graph of everything it imports — so opening the register loaded the
Excel reader. Database helpers now live in **`src/server/invoiceData.ts`**, which imports nothing heavy;
`ingest.ts` keeps only what reads a *file*. Work that genuinely needs a reader sits behind
**`POST /api/maintenance/reextract`** and `importActions.ts`, so exactly two routes carry them — the two
import screens. `tests/navigation.test.ts` fails if that ever regresses.

**2. The register parsed documents while rendering.** `reextractStale()` ran inside the server render,
opening and parsing up to 25 stored files before the page could be sent. It is still automatic, but
`HealStaleInvoices` asks for it from the browser *after* the page paints; the render does one indexed
`countStaleInvoices()` instead.

**3. A register render fanned out into per-row queries.** Rebuilding rows asked for each invoice's
receipts and notes one invoice at a time — a fifty-row page meant a hundred sequential round trips.
Now two queries cover the page, the payment-term rules load once, and row write-backs are issued
together instead of awaited one by one. A register whose rows are all current issues no extra query at
all.

**4. The shell was rebuilt on every click.** The layout called `headers()` to learn the pathname so the
sidebar could highlight the active section — and a layout that reads the request is dynamic, so the
whole shell was re-rendered and re-sent for every navigation. The sidebar is now a client component
using `usePathname()`, the layout is static, and the middleware that existed only to supply that header
is gone. That also fixed a visible bug: the highlight was wrong on five sections.

On top of that, **`src/app/(app)/loading.tsx`** gives the group a streaming boundary. Without one, Next
holds the *previous* page on screen until the next page's render finishes — which is exactly "I click
and nothing happens for a few seconds". With it, the content area swaps immediately and the router can
prefetch that shell. The boundary is not a substitute for the three fixes above; it makes the small
amount of remaining work invisible rather than hiding a large amount.

Known limit: the dashboard, Payments & Receipts and Reports each load every invoice with its receipts
and notes (one cached read per request, shared between them). That is right for hundreds of invoices
and will want pagination or SQL aggregation at tens of thousands.

## Architecture

```
 Commercial Invoice (xlsx / pdf)
            │
   ┌────────▼──────────┐  src/lib/extraction/
   │ Document          │  sheetGrid.ts   merged-cell aware worksheet view
   │ Extraction        │  textGrid.ts    PDF → the same grid shape
   │                   │  labels.ts      the label dictionary (synonyms live here)
   │                   │  invoiceReader.ts  format-independent invoice reader
   └────────┬──────────┘  catalog.ts     the canonical field vocabulary
            │  ExtractionResult  (fields + status + source + line items)
   ┌────────▼──────────┐  src/lib/normalize/
   │ Normalized Data   │  normalizer.ts  catalogue fill-in, safe derivations
   │                   │  validators.ts  quality score + "what is still needed"
   └────────┬──────────┘
            │
   ┌────────▼──────────┐  src/lib/business/
   │ Business Logic    │  rules.ts       due-date rules & status engine (company-owned)
   │                   │  accounts.ts    the Accounts register row
   └────────┬──────────┘
            │
   ┌────────▼──────────┐  src/server/    ingest, export, server actions
   │ Accounts Data     │  prisma/        schema + audit + rules
   └───────────────────┘  src/app/       App Router screens
                          src/inngest/   optional background jobs
```

The layers are separate on purpose: adding the e-Invoice PDF or a Tally export in Phase 2 means
writing one new reader that emits the same canonical keys. Nothing downstream changes.

**Payment Tracking is a second stack beside that one, not a layer in it:**

```
 Customer Payment Sheet (xlsx)        typed in by hand
            │                              │
   ┌────────▼──────────────────────────────▼───────┐  src/lib/payments/
   │ sheetReader.ts   finds the table, the customer, the as-on date
   │ terms.ts         reads a payment term and builds its milestones
   │ money.ts         the three formulas, stated once
   │ record.ts        one tracked invoice: status, ageing, what is missing
   └────────┬──────────────────────────────────────┘
            │
   ┌────────▼──────────┐  src/server/payments/
   │                   │    import · query · actions · registerActions
   │   pt_* tables     │    audit · export
   │                   │  prisma/
   └───────────────────┘    pt_customers · pt_invoices · pt_receipts
                            pt_notes · pt_imports · pt_field_edits
```

It imports nothing from the stack above and nothing above imports it. That is checked by a test, not
left to discipline.

`src/lib/extraction/catalog.ts` is the single list of field keys the whole system speaks. Each field
records where its value is expected to come from (`invoice`, `tally`, `eInvoice`, `bank`, `shipping`,
`master`, `calculated`), which is what lets the UI say *"not on the invoice — will come from the
shipping team"* instead of just showing a blank.

### Background jobs (optional)

Uploading always extracts synchronously — it takes a fraction of a second. Two actions affect the
whole register: recalculating after a payment-term rule changes, and re-extracting every stored
invoice. By default they run inline in the request, so nothing else has to be started.

To move them off the request:

```bash
# .env
USE_INNGEST="true"
```

```bash
npm run inngest:dev     # in a second terminal
```

The Inngest functions in `src/inngest/functions.ts` also register a nightly due/overdue refresh.
Every uploaded file is stored with its invoice, so the whole register can be re-read later without
asking anyone to upload anything again.

### Extending it

* **A new invoice layout** → add synonyms in `src/lib/extraction/labels.ts`. No other code changes.
* **A new document type** (e-Invoice, Tally export, bank statement) → add a reader under
  `src/lib/extraction/` that emits catalogue keys, and dispatch to it in `index.ts`.
* **A new Accounts column** → add a `FieldDef` in `catalog.ts` and an entry in `ACCOUNTS_VIEW`.
* **A due-date rule** → Settings screen; no code, no assumptions baked in.

---

## Deliberate design decisions

1. **No hardcoded values from any sample invoice.** Extraction is driven by labels, geometry and
   value types. `tests/extraction.test.ts` proves it by running a modified copy of the template with
   a different customer, ports, terms, HSN, amounts and exchange rate.
2. **Side matter is ignored.** Real templates carry address look-up blocks and helper columns next to
   the printed form; the reader first works out where the printable invoice ends.
3. **Strict number parsing.** `Container No. MSNU 1968136` must never be read as a number.
4. **Exchange rate is not assumed.** It is taken from an explicit label, or from the workbook's own
   conversion formula, or — failing both — inferred from the layout and clearly marked
   *needs verification*.
5. **Due dates are never invented.** `100% CAD` implies no number of credit days by itself. Until a
   rule exists in Settings, the register says so and explains what is needed.
5a. **Who the customer is, is a company decision, not a guess.** These invoices consign goods to one
   party and bill another, so where no separate *Buyer* block is printed, the **notify party is the
   actual end buyer** — Pacific Surfaces' own rule, written once in
   `src/lib/business/rules.ts → BUYER_WHEN_NOT_NAMED`. The address and country travel with the party
   they belong to: customer address, country **and contact** all come from the notify block, never
   borrowed from the consignee, and a field that block cannot fill goes honestly blank rather than
   keeping an older rule's value. Following the rule is reported as *calculated*, not *needs
   verification* — the
   company has said what its invoices mean, so there is nothing to confirm. Only the rare case where
   the invoice has no notify party either falls back to the consignee, and that one stays flagged.
   The rule is re-applied every time an invoice is loaded, so changing it corrects invoices already
   in the register without re-reading their files. A customer typed in by hand is never overwritten.
6. **Duplicates are prevented twice**: by SHA-256 file checksum and by invoice number.
7. **Every manual correction is recorded** with old value, new value and time.
8. **Deleting is one action, confirmed once.** The file and its register row belong together, so they
   go together — and the import log keeps the record of it.
8a. **The screens explain nothing they can instead show.** Formulas, conventions and design
   rationale are documented here, not repeated in page copy; a figure that needs a caveat carries it
   in its own cell or status. What stays on screen is labels, counts, validation messages, format
   hints and warnings bound to real data.
9. **Payment Tracking keeps nothing back for being incomplete.** It was asked for as a system that
   works from customer sheets and typed-in records alone, which means it must accept a record with
   almost nothing in it. So no field anywhere in that section is required, a blank saves, and what
   cannot be calculated from what is present is reported as *Requires Verification* rather than
   blocking the save or being filled in with a plausible guess.
10. **Its independence is a test, not a promise.** Module imports, the Prisma tables it touches,
   which route bundles carry `exceljs`, the order of the status ladder, and the absence of any
   `required` attribute are all asserted in `tests/navigation.test.ts`, and the database-level check
   runs in `npm run verify`. Intentions decay; a failing build does not.
11. **A field a form does not show is a field an edit destroys.** So "only write what the form
   carried" is a rule of the save path, not a habit of whoever writes the next form — and
   `tests/editing.test.ts` reads every inline form and fails if one offers fewer fields than its
   action writes. The bug that prompted it wiped a receipt's remarks on every amount correction,
   and nothing anywhere said so.

---

## Moving on from the local build

### Adding sign-in back

There is no authentication in this build. `src/lib/session.ts` is the single place the rest of the
code asks who the current user is — it returns a fixed local operator. To add Auth.js v5 with the
ERP's `OPERATOR` / `MANAGER` / `ADMIN` roles, replace that one file with a real session lookup, add a
`User` model, and re-introduce the guards at the top of each page and server action. Nothing else in
the application depends on it.

### Switching to PostgreSQL

`prisma/schema.prisma` is written for SQLite so it needs no server. For Postgres:

1. `datasource db { provider = "postgresql" }` and point `DATABASE_URL` at it.
2. The five JSON-text columns (`fields`, `lineItems`, `quality`, `accountsRow`, `warnings`) can
   become `Json` / `String[]` — or stay as they are, which works unchanged.
3. The string columns holding `invoiceType`, `status`, `format`, `outcome`, `basis` and `noteType`
   can become native enums.
4. Add `mode: "insensitive"` back to the `contains` filters in `src/server/invoiceQuery.ts`
   (SQLite's `LIKE` is already case-insensitive for ASCII; Postgres's is not).

## Tests

407 tests across 16 files, none of which needs a database or a network connection.

```
tests/extraction.test.ts   the real invoice, a modified copy, the PDF, and due-date rules      13
tests/register.test.ts     the column order, the assumption, and the calendar-dependent cells  14
tests/navigation.test.ts   the readers stay out of the render path, the shell stays static, a
                           register render does not fan out into per-row queries — and
                           Payment Tracking is a separate system                               46
tests/nav-structure.test.ts  six areas, every screen still reachable, highlight follows path   58
tests/instalments.test.ts  split payment terms: the portions add up, settle oldest-first, and
                           only the portion that has fallen due is overdue                     28
tests/payment-terms.test.ts  the independent term engine: 120 / 90 days from BL, CAD,
                           70 + 30 splits, the brief's worked example, and every case where
                           a due date must not be invented                                     43
tests/payment-sheets.test.ts  the four real payment sheets: merged total rows, the broken SUM
                           range, stray working cells, terms at three levels, the exchange-rate
                           convention, outstanding without double-counting, and ageing         48
tests/flow.test.ts         both ways in — manual and imported — through register, receipt,
                           CN/DN, balance, due/overdue, status, report totals and export        7
tests/manual.test.ts       a hand-entered record matches an imported one, column for column     8
tests/receipts.test.ts     the three formulas (with the brief's worked examples), the dynamic
                           receipt columns, and the payment-sheet reader                       26
tests/books.test.ts        balance as per books held beside ours, never inside it               9
tests/editing.test.ts      every field is editable: every column of every table has a box on a
                           form, every catalogue field has an Edit, every inline form posts every
                           field its action writes, the customer register and the action agree on
                           their field names                                                   33
tests/money.test.ts        the grouping follows the currency, not the reader; a missing rate
                           gives no home-currency figure rather than zero                       22
tests/home-currency.test.ts  each invoice converted at its own rate, and how many had one        2
tests/exporter.test.ts     the register workbook, the CSV and the per-invoice extraction sheet  5
scripts/verify-local.ts    the database path, end to end: the register (import, correction,
                           rule, receipts, reports, export, deletion), Payment Tracking (all
                           four sheets, a wholly blank record, 120-days-from-BL, six receipts,
                           search, export), and editing — proving that saving one field leaves
                           the fields the form never showed alone      (npm run verify)
```

`npm run verify` needs a database, so run `npm run db:push` first. It cleans up after itself, and it
skips the Payment Tracking half rather than overwriting anything if those four customers already
exist in your `pt_*` tables.
