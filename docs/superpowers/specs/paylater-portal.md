# PayLater Portal — implementation spec

**Status:** milestone one (shell + full v2 intake) is **built**. Everything
below is the agreed design and still governs the work; the notes marked
*[built]* record what shipped and where any decision was made differently.

Written at the end of the session that gathered the requirements, so that the
session which builds it does not have to re-derive any of these decisions.

A second portal alongside the existing one, for the firm's PayLater debt-recovery
work. Sign-in gains a portal chooser; PayLater access is granted from the
existing Employees tab.

---

## Later decisions that CHANGED what is written below

Four asked for directly, after the portal was first seen in use. Each one
reverses or extends something further down, so they are recorded here rather
than edited silently into the text they contradict.

**1. It is called Collections.** Everything a person reads says Collections /
التحصيل, and the pages live at `/collections`. `/paylater` redirects
permanently, because links to it were already sent out. What is NOT renamed:
the `/api/paylater/*` routes, the seven `paylater_*` tables, the
`memberships.paylater_role` column, and the `lib/platform/paylater*` modules.
Stored and wired names are permanent — renaming one silently revokes access,
which is the same rule the capability keys follow.

**2. It uses the MAIN PORTAL's styling, not v2's.** This reverses "Use v2's
buttons and v2's columns, not the platform's" and the commits around it. The
two portals sat side by side and read as two products: the same action was a
near-black pill in one and a gold button in the other, and a form field changed
its radius and background when you crossed between them. The `pl-*` classes are
kept and RESTYLED in terms of the platform's (`.dash-btn-gold`,
`.dash-btn-ghost`, `.dash-input`, `.dash-chip`) rather than four thousand lines
of markup being rewritten to swap class names — so the layout the prototype
established survives, and only the controls change. The override block at the
end of `app/globals.css` says which platform rule each one mirrors; a change to
one belongs in both.

**3. A customer file opens as a DRAWER over its batch, at half the viewport.**
Working through a batch is a loop — open a file, fill what is missing, return
to the list, open the next — and a full page change for each turn of it lost
the reader's place. The `/collections/customer/[id]` page still exists and
still renders full width, because a link pasted into a message has no batch to
open over. `GET /api/paylater/customers/[id]` exists to feed the drawer, which
has no server render to hang the record on.

**4. There is a way in from the main portal's sidebar.** Until then the only
entrance was the chooser on the sign-in screen, so somebody already signed in
had to sign out to reach a portal they had access to. The link is gated on
`hasCollectionsAccess`, resolved from the membership row identity already
reads — no extra query — and `app/collections/guard.ts` still decides the same
question server-side.

---

## Source material — read these first

All paths are on this machine, outside git (see "Why the prototype is not
committed"):

| Path | What it is |
|------|------------|
| `PayLater Portal/Pay_Later_Case_Journey.docx` | The workflow in 26 steps, intake → enforcement → closure. The authority on what actually happens. |
| `PayLater Portal/VERSION 2/V2/paylater_system_v2.html` | **The prototype to build.** Single-file app, Arabic-first. |
| `PayLater Portal/VERSION 2/V2/VERSION_2_notes.md` | What v2 does, and its own list of what does not work yet. |
| `PayLater Portal/VERSION 2/V2/WORKFLOW_GATES_spec.md` | The gated pipeline. Design only — nothing built, and not in this milestone. |
| `~/Desktop/PayLater system/VERSION 4/files.zip` | **v4 — newer than the folder above.** Contains `paylater_dataset_full.json` (560 real files), `paylater_excel_parser.py`, and `VERSION_4_notes.md`. |

### Why v2 and v4 are both here

They are not increments of one another and the difference caused real
confusion, so it is written down:

- **v2 (25 Aug)** is an *intake* tool — monthly Excel import, PDF+QID
  extraction, per-customer form, completeness, duplicate merge.
- **v4 (30 Aug)** is a *portfolio* tool — built from the firm's real Progress
  Report and ملف التنفيذ: 560 files, 7 batches, dashboards, four buckets,
  progress report, enforcement file. Its notes say v3's document storage was
  **not** carried into it.

**The decision: build v2's SCREENS on v4's DATA MODEL.** v2's screens are what
the firm needs first; v4's record is the only one that can hold the 560 real
files without discarding their court and enforcement state. Storing the fuller
record now means v4's dashboards and reports can be added later with no
migration.

---

## Decisions

Every one of these was asked and answered. Do not silently revisit them.

### Scope of the first milestone

**Shell + full v2 intake.** That is: the sign-in chooser, `/paylater` routing,
PayLater roles in the Employees tab, the database tables, the 560 records
imported, *and* v2's whole month-start workflow — Excel import with preview,
the customer form, completeness, duplicate merge, upload-while-editing,
multi-select bulk notice dates, file numbers from QID order.

### Data model

Store the **union** of v4's 48 fields and v2's intake fields. Nothing from
either is dropped. v4's dataset shows the case-tracking half:
`case_number, court_date, judg_*, enf_*, stage, bucket, fees, observations`.
v2 adds the intake half: `gender, mobile, email, registration date, instalment
count, dpd` and an **orders** array (order id, date, merchant AR + EN, amount,
instalment, paid count, paid total, remaining).

`stage` and `history` are written **from day one** even though gates are not
enforced, so the gated pipeline can be switched on later without a migration.

### Access and roles

- PayLater is **scoped to the Ali AlBaker Law Firm company**.
- **Admins and managers reach PayLater by role** — they need no PayLater role
  assigned. This mirrors how the rest of the platform already works.
- **Any other employee needs an explicitly assigned PayLater role**, granted
  from the existing Employees tab.
- The roles, from the journey: **Team Leader · Employee · Lawyer · Auditor.**
  - *Team Leader* — divides batches, assigns notice dates, final notice review, override.
  - *Employee* — prepares files, sends notices, handles comms and settlements.
  - *Lawyer* — stamps and signs notices (Yusuf, Ali, Ahmed in the journey).
  - *Auditor* — audits and prints the legal memos (Mr. Sayed).
- **Override** (once gates exist): managers, admins and Team Leaders.

*[built, and corrected]* The role is **one per person**, stored as
`memberships.paylater_role` (#35) and set from a **dropdown at the top of the
Employees card**, next to the Manager/Employee role.

It was first built as four capability checkboxes, which let one person hold both
Lawyer and Auditor — two roles that exist to check each other's work, so holding
both turns a review into a self-review. The capability tree is for additive
grants and cannot express "exactly one of"; a single column can, so the
combination is now unrepresentable rather than merely discouraged.

*[built]* **The four roles now have four different sets of powers**, audited
end to end against a running server:

| | Team Leader | Employee | Lawyer | Auditor |
|---|---|---|---|---|
| Create batch · import Excel | ✅ | 403 | 403 | 403 |
| Divide batch · notice dates | ✅ | 403 | 403 | 403 |
| Prepare/edit a file · extraction | ✅ | ✅ | 403 | 403 |

The lawyer and auditor are **read-only on intake**: they close gates 2.3 and 2.5
as checks on each other, so neither may edit the claim they sign or audit. Their
own actions are Phase 2 and remain unbuilt.

*[built]* **¶22 — dividing the batch among the employees** is now real:
`paylater_customers.assigned_to` (#36), set by the Team Leader from the same
multi-select bar as the notice dates, with a "my files" filter for ¶56's
"employee responsible for the relevant batch". Only employees and team leaders
can be assigned; the route verifies the assignee rather than trusting the
client, and applying a date alone never silently unassigns anyone.

### Sign-in

A portal dropdown: **Main portal** / **PayLater portal**. Credentials are
checked **first**; someone without PayLater access is told plainly that they do
not have access and lands in the main portal. Nothing about the choice is
revealed before authentication. A switcher in the shell so nobody signs out to
change portal.

### Batches

**Monthly, created in the portal** by a Team Leader (code, month, capacity) —
not the hard-coded `A10…F100` list v2 ships with, which needs a deploy to add
September. The 7 existing batches (A10, A50, A100, B100, C100, D100, E100 —
February to August) import as they are.

### Files and attachments

**Supabase Storage**, server-side access like every other data path here.

### Extraction

v2 calls `api.anthropic.com` **directly from the browser**, which cannot ship —
it would expose an API key to anyone who opens the page.

Build `/api/paylater/extract` server-side, reading `ANTHROPIC_API_KEY` from the
environment. **It must degrade gracefully:** with no key configured the button
says extraction is not configured rather than erroring, and every other feature
works. The key is not mandatory — see the open question below.

### Real data

Import all **560 records** from `paylater_dataset_full.json`. These carry real
names, QIDs, phone numbers and debts; the user confirmed this for the testing
database.

---

## Open question, deliberately unresolved

**Can customer purchases be read without an AI key?**

The `orders[]` detail exists only inside the customer report PDFs — the monthly
Excel does not carry it. v2 sends the raw PDF to Claude as a `document`.

If those PDFs are **machine-generated and carry a text layer**, a deterministic
parser (`pdf-parse` / `pdfjs`) can extract the orders with no key, no
per-document cost, and — the part that matters for legal work — the same output
every run. The firm already does exactly this for Excel in
`paylater_excel_parser.py`, validating itself against known totals.

If they are **scans**, that needs OCR, and Arabic merchant names through OCR are
materially worse than the model.

**Waiting on:** a sample customer report PDF. Check for a text layer, then
decide. Until then build the extract route ready and degraded — nothing else in
the milestone depends on the answer.

*[ANSWERED — the PDFs have a text layer, and there is no API key.]*

Batch 7 arrived with 73 customer reports. Checked, not assumed:

- **73 of 73** carry an extractable text layer. None is a scan.
- **73 of 73** contain the English section (pages 3–4), which uses Latin digits
  where the Arabic pages use Arabic-Indic — so nothing has to be transliterated
  before it can be compared.
- Inside each report the order-summary and loan-summary tables **agree on the
  order count in every file**.

So `/api/paylater/extract` now parses deterministically
(`lib/platform/paylaterPdf.ts`, using `pdfjs-dist`) and **reads no API key at
all**. That was the spec's own preference and for the stated reason: these
figures are printed on a legal notice, and a parser gives the same output every
run where a model only usually does.

**Validated against ground truth, not just "it returned something."** Three of
the four customers seeded into the v2 prototype are in this batch, so their
correct values were known independently of the parser: **37 of 37 assertions
match**, including each order's paid count, its copied paid/remaining totals,
and the Arabic merchant names (ستارلينك, فناك, موبيلي ستوري). Across all 73
reports the parser finds **210 orders and 840 instalment rows** with no missing
amounts, no missing merchants, no missing dates, and no order whose paid +
remaining fails to equal its amount.

Two things the corpus taught that a single sample would not have:
- Order ids are **not all `SQ`** — 40 of the 210 are `PL`, and a parser that
  knew only `SQ` reported nine customers as having no orders at all.
- The instalment row carries **one to three integers** between the loan account
  and the amount, and which it is varies between reports.

Still true, and still correct: **gender is not in the report**, so it remains
the one intake field a person supplies from the dropdown. The QID card is a
genuine vision task and is still not needed — the QID and name are in the Excel.

Note the QID *image* is genuinely a vision task, but most of what it is used for
(QID number, name) is already in the Excel. The remaining derivation is gender,
which a dropdown answers more reliably than inference from a name.

---

## Where it plugs into the existing code

The integration points are already clean:

- **`app/api/login/route.ts`** returns `{ ok, redirect }` and the client follows
  it — so the portal choice becomes part of that decision.
- **`middleware.ts`** guards by path prefix (`PROTECTED_PREFIXES = ['/admin', '/me']`).
  `/paylater` becomes the third.
- **`lib/platform/capabilities.ts`** — `CAPABILITY_TREE` is rendered directly by
  the Employees → Permissions card, so a new `paylater` group appears there with
  no UI work. **Read the note in that file about `expandCapabilities` expanding
  child → parent** before adding nested keys; it is why `files.viewAll` is a
  presentation-only parent.
- **`supabase/migrations/`** — additive, idempotent, auto-applied by
  `scripts/migrate.ts` on deploy. Next number is **#34**.
- **`lib/i18n.ts`** — every string bilingual, Arabic default.

---

## Assumptions, stated so they can be corrected

- Bilingual AR/EN throughout, Arabic default, matching the main portal.
- File numbers: smallest QID is 001; a manual override sticks, is marked يدوي,
  and the automatic sequence works around it (v2's rule).
- Gates are **not** enforced this milestone.

---

## Two things flagged to the user, still open

1. **D100 numbering.** v4's notes: D100 has two rows numbered 1 and no row 31;
   the larger claim (NAVEEN KUMAR HARBANS LAL, 4,944) was assigned #31 to make
   the totals reconcile. **This is a guess sitting under reconciled figures** and
   the user has not confirmed it. Import as the parser decided, surface it in a
   notes screen, do not bury it.

   *[built]* Imported as the parser decided and shown in الملاحظات as
   unconfirmed, with a confirm control that records who confirmed it and when.
   The import preserves confirmations across re-runs. **Still unconfirmed.**
2. **v4 is newer than the folder the user pointed at.** They chose v2's screens
   knowingly, after being shown this.

---

## Found while building — two things the spec did not know

*[built]* Both are in the الملاحظات screen. Neither was fixed.

1. **46% of QIDs carry a trailing zero.** 258 of the 560 records have a 12-digit
   QID where a Qatari QID has 11. Every one of them ends in `0`, and removing it
   yields a valid 11-digit QID in all 258 cases — an Excel numeric-format
   artifact, confined to A10/A50/A100/B100 (C100, D100 and E100 are clean; so
   are v2's four seeded records). It matters because QID is the duplicate-skip
   key and drives file numbering.

   **Decision taken: infer nothing.** The data is stored exactly as parsed.
   `qid_normalized` exists as the seam a future correction would use, and is
   currently an exact copy. Only *search* casts wider, matching the 11-digit
   form as well, so someone holding a card can still find the file.

   Two QIDs are simply broken and are flagged individually: B100 #23 is
   `045112026` (a date) and B100 #40 is `20`.

2. **The claims do not sum in four batches.** In A10, A50, A100 and B100 the
   per-file claims do not add up to the batch total the firm's own Dashboard
   states — 4,160.47 across the four. Row counts and row numbering are both
   correct, so it is not a missing or duplicated file. A10's gap is exactly one
   file's claim (a customer whose observation says he had already paid through
   the app), A50's 0.88 reads as rounding, and A100's and B100's match no single
   row. **No cause is asserted** — guessing a rule from one of four cases is how
   the D100 #31 problem was created.

---

## Why the prototype is not committed

`PayLater Portal/` is deliberately **left untracked**. The v2 HTML carries four
seeded customer records with real names, QIDs, phone numbers and emails, and
`paylater_dataset_full.json` carries 560 more. Committing them would write real
client personal data into git history permanently, where it cannot be removed
without rewriting every commit after it.

The files stay on disk at the paths above, so a session working in this
directory can read them. If the material ever does need to be in the repo, strip
the personal data first.
