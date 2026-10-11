# AlBaker Portal — working notes

Next.js 14 (App Router, TypeScript) · Supabase (Postgres) · **production on
Railway, testing on Vercel**.
A multi-company legal-practice portal: folders (client matters), tasks with a
workload calendar, attendance, CRM, and a capability-based permission system.

---

## Read this before your first command

**Node 24 is installed** at `~/.local/node-v24.10.0-darwin-arm64`, with
`node`, `npm` and `npx` symlinked into `~/.local/bin` (already on PATH). Check
with `node --version` — it should print `v24.10.0`.

If that ever disappears (a wiped home directory, a reset PATH), reinstall it the
same way — download, **verify the checksum**, unpack, symlink:

```bash
curl -fsSLO https://nodejs.org/dist/v24.10.0/node-v24.10.0-darwin-arm64.tar.gz
curl -fsSL https://nodejs.org/dist/v24.10.0/SHASUMS256.txt | grep darwin-arm64.tar.gz | shasum -a 256 -c -
tar xzf node-v24.10.0-darwin-arm64.tar.gz -C ~/.local
ln -sf ~/.local/node-v24.10.0-darwin-arm64/bin/{node,npm,npx} ~/.local/bin/
```

There is still no version manager, so this is the only Node on the machine.

**`.env.local` already exists** (gitignored) with working Supabase credentials,
`AUTH_SECRET`, and `SEED_TEST_PASSWORD`. It points at the **testing** database.

---

## Commands

```bash
npm run dev          # dev server on :3000
npx tsc --noEmit     # typecheck — fast, run constantly
npm test             # vitest, 468 tests
npm run build        # production build
npm run migrate      # apply pending SQL migrations
npm run db:snapshot  # read-only row counts, to prove a migration removed nothing
npm run seed:test    # the three test accounts
npm run seed:test-tasks  # a spread of demo tasks, one per calendar state
npm run import:paylater  # the 560 PayLater files (see the PayLater section)
```

`npm run lint` is **not configured** — it prompts to set ESLint up. Not part of
this project's checks.

### `npm run build` kills a running dev server

Both write `.next`, and a production build leaves the dev server serving
half-deleted chunks — the symptom is 404s for `main-app.js` and a page of
console errors that look like real bugs but are not. After any `npm run build`:

```bash
pkill -f "next dev"; rm -rf .next; npm run dev
```

---

## Test accounts

Password `TestPass1234` for all three, in Ali AlBaker Law Firm:

| Role | Email |
|------|-------|
| Admin (global) | `test-admin@albaker.io` |
| Manager | `test-manager@albaker.io` |
| Employee | `test-employee@albaker.io` |

Username and email are deliberately identical — the Employees screen sets
`username = email` on save, so a seeded account whose username differed was
renamed the first time an admin touched it and the login silently broke.

---

## Conventions that are load-bearing

**Migrations are additive and idempotent.** `add column if not exists`, never a
drop or a destructive alter. `scripts/migrate.ts` runs them on every deploy and
**exits 0 on failure by design** so a migration problem cannot stop the site
booting — which means a failure is easy to miss. Read the build log.

**The data layer tolerates a missing column.** New code reaches production
before its migration runs, so readers probe-and-latch (`lib/platform/files.ts`,
`lib/platform/tasks.ts`) and fall back to the older column set. Follow that
pattern for any new column.

**Authorization is server-side, always.** Permission props on components decide
which *controls* are drawn; every one is re-checked in the route. A wrong prop
costs a button that returns 403, never access.

**`expandCapabilities` expands child → parent as well as parent → child.**
So granting a leaf implies its parent. This is why `files.viewAll` is a
*presentation-only* parent that no route enforces — enforcing it would let one
section grant the whole company. There is a test that greps the source to keep
it that way. Read the note in `lib/platform/capabilities.ts` before adding
nested capability keys.

**Bilingual, Arabic default.** Every string goes in `lib/i18n.ts` in both
languages. Numbers, units, emails and times are kept LTR at render time — a
number with a Latin unit inside an RTL paragraph reorders ("0.5 h" → "h 0.5"),
so mark those `dir="ltr"`.

**Wide content scrolls inside its own container**, never the page. Tables use
`.dash-table-wrap` (`overflow-x: auto`); the workload calendar does the same
below 720px.

**A refused request is not a failed one.** 403/404 where the server is enforcing
a boundary should read as a quiet "not available to you", not a red error.
Shouting "could not load" at someone who is simply not included tells them the
product is broken. Real failures (500, network) still show red.

---

## Deployment

**Two environments, and they are not the same shape.** Getting this backwards
is easy — the repo's docs had it backwards for a while — so it is spelled out:

| | Production | Testing |
|---|---|---|
| Host | **Railway** | **Vercel** |
| Config | `railway.json` + `nixpacks.toml` | `vercel.json` |
| Migrations run | at **start** (`startCommand` = `npm run migrate && npm run start`) | in the **build** (`vercel-build` = `npm run migrate && next build`) |
| `DATABASE_URL` needed in | runtime | the **Build** environment |

The split exists because Vercel has no start command to hang a migration on — a
Next app there is built once and served as functions — so the migration has to
happen during the build. Railway does have a start command, so it uses it. On
Vercel, `DATABASE_URL` must be in the **Build** environment specifically, or
migrations silently never run.

**Both are pinned to an EU region, beside the database.** Supabase is in
Central EU; the app was in US West, which put a ~220ms round trip under *every*
query. Opening a folder makes several, so it cost seconds. `railway.json` sets
`deploy.region: europe-west4` and `vercel.json` sets `regions: ["fra1"]`. If
you move the database, move both. Changing a Railway region redeploys the
service, so it is not a zero-downtime edit.

**Commits need an email Vercel can map to an account** or the *testing* deploy
fails with "Invalid git email address" before the build starts. Railway does not
care, so a bad author email breaks testing while production looks fine.
`git config user.email` is set for this repo; check it prints a real address and
not a `*.local` hostname. See the README section for the full note.

---

## PayLater portal

A second portal at `/paylater`, for the firm's debt-recovery work. The spec is
`docs/superpowers/specs/paylater-portal.md` — **read it before touching
anything PayLater**; it records decisions that should not be silently revisited.

**Milestone one is built:** the sign-in portal chooser, `/paylater` routing, the
PayLater role on the Employees card, migration #34's seven tables, the 560 real
files imported, and v2's month-start intake (Excel import with preview, the
customer form with orders, completeness, duplicate merge, multi-select bulk
notice dates, file numbers from QID order).

### The PayLater role is ONE per person, and is not a capability

`memberships.paylater_role` (#35) — a single-valued column, set from a dropdown
at the top of the Employees card, beside the Manager/Employee role.

It shipped briefly as four capability checkboxes and that was wrong: nothing
stopped one person being both Lawyer and Auditor, who in the case journey exist
to check each other's work. `CAPABILITY_TREE` is for **additive** grants and
cannot express "exactly one of these four" — `expandCapabilities` runs in both
directions, so any grouping either implies all four or implies a parent nobody
granted. A column makes two roles unrepresentable rather than merely discouraged.

Add a fifth role in `lib/platform/paylaterRoles.ts` **and** widen the check
constraint in #35. Setting the role is gated on `people.permissions`, like the
other grants — a manager staffing their own team should not need an admin.

**What each role may do**, from the journey and the gates spec:

| | Team Leader | Employee | Lawyer | Auditor |
|---|---|---|---|---|
| Open the portal | ✅ | ✅ | ✅ | ✅ |
| Create batch · import Excel | ✅ | — | — | — |
| Divide the batch · notice dates | ✅ | — | — | — |
| Prepare/edit a file · extraction | ✅ | ✅ | — | — |

`canLead` and `canEditFiles` in `lib/platform/paylater.ts` are the two rules;
every route re-checks them. **The lawyer and auditor are read-only on intake by
design** — they close gates 2.3 and 2.5 on the same file as checks on each
other, so letting either edit the debt they sign for removes the check. Their
own actions (stamp/sign, memo audit) are Phase 2 and not built.

`assigned_to` (#36) is who is working the file now — a live link to an account,
set by the Team Leader (journey ¶22), and what "my files" filters on. It is
deliberately separate from `handler_name`, which is the historical free-text
name from the source spreadsheet.

### Reading the customer report needs no API key

`lib/platform/paylaterPdf.ts` parses the PDF directly. All 73 reports in Batch 7
carry a text layer, so the spec's open question is closed: no OCR, no model, no
`ANTHROPIC_API_KEY`, and the same output every run — which is the point, because
the QID and the debt land on a legal notice.

`pdfjs-dist` is kept **out of the server bundle** (`next.config.js`) and its
worker is loaded for its side effect; without both, the route fails at runtime
with a worker-resolution error while `tsc` stays green.

Validated against the three v2-seeded customers who appear in this batch — 37 of
37 fields — and across all 73 reports (210 orders, 840 instalment rows) with no
gaps. Two traps the corpus revealed: order ids are `SQ` **or** `PL`, and the
instalment row has a variable number of integers before the amount.

**Not built, by decision:** the gates (`WORKFLOW_GATES_spec.md` is design only —
`stage` and `history` are written from day one so they can be switched on
without a migration), v4's dashboards and reports, and document upload.

### Why every imported file reads "0/4" for intake

All 560 came from the Progress Report and the enforcement file, which carry
**none** of the intake detail — not one has a gender, a report date, a PayLater
registration date, or a single order. That data lives in the customer's PDF
report, which was never part of that export.

So the completeness rule (v2's, in `lib/platform/paylaterIntake.ts`) is right and
every file is genuinely incomplete. What was wrong was showing it as one verdict:
560 identical "Incomplete" chips is not information. The table shows **`0/4`**
with the missing parts on hover, and the count moves as a file is filled in.

`paylaterIntake.ts` is deliberately **client-safe** — no `server-only` — because
the table and the form need the same answer as the save route. Importing a value
from `lib/platform/paylater.ts` (which IS `server-only`) into a client component
builds green under `tsc` and fails at runtime; there is a test for it.

### The data is real, and it is not in git

`PayLater Portal/` and the v4 dataset carry real names, QIDs, phone numbers and
debts. They stay untracked. `npm run import:paylater` reads the dataset from
`~/Desktop/PayLater system/VERSION 4/` — including from inside `files.zip`,
which is where it normally lives — or from a path passed as an argument.

The import is idempotent and re-validates the claim totals against the source
before it finishes.

### Two things to know before trusting a number

Both are surfaced in the portal's **الملاحظات** screen, and neither was fixed:

- **D100 #31 is a guess.** Two rows were numbered 1 and #31 was missing; the
  parser assigned the larger claim to #31 so the batch totals reconcile. Nobody
  has confirmed it. The screen carries a confirm control that records who said
  yes.
- **46% of QIDs have a trailing zero.** 258 of 560 carry 12 digits where a
  Qatari QID has 11; every one ends in `0` and stripping it yields a valid QID.
  It is an Excel numeric-format artifact, confined to A10/A50/A100/B100. **The
  decision was to infer nothing** — the data is stored exactly as parsed. Only
  *search* casts wider, matching the 11-digit form too, because offering someone
  more rows to read is not the same as merging two files.

Also flagged: in those same four batches the per-file claims do not sum to the
batch total the firm's Dashboard states (4,160.47 across all four). Cause not
determined.
