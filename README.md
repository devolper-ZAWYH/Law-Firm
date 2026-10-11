# Ali AlBaker Law Firm — Authentication Portal

A production-ready authentication portal built with **Next.js 14 (App Router, TypeScript)**, backed by **Supabase (Postgres)**, and deployed on **Vercel**. It provides a branded login, signed session cookies, three roles (`admin`, `manager`, `user`) with role-based dashboards, and an admin-only user-management screen.

Later served at **https://albaker.io**.

---

## Features

- 🔐 **Login** with email *or* username + password (bcrypt-hashed via `bcryptjs`).
- 🍪 **Sessions** as a signed **HS256 JWT** (`jose`) in an **httpOnly** cookie, 12-hour expiry.
- 👥 **Three roles** — `admin`, `manager`, `user` — each with its own dashboard (`/admin`, `/manager`, `/user`).
- 🛡️ **Middleware route protection**: unauthenticated → `/login`; wrong role → own panel.
- 🧑‍💼 **Admin user management** (`/admin/users`): list users and create new ones with a role.
- 🗄️ **All DB access is server-side only** via the Supabase **service-role key**. RLS is enabled with **no anon policies**.
- 🧱 **Security headers**: CSP, `X-Frame-Options: DENY`, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `noindex`.
- 🚦 **Rate-limited** login endpoint.
- 🎨 Firm branding: navy (`#1c2b3a` / `#14212d`), gold accent (`#b8924a`), light card background (`#f4f5f7`).

---

## Project structure

```
albaker-portal/
├── app/
│   ├── layout.tsx            # root layout, global metadata (noindex)
│   ├── globals.css           # brand styling
│   ├── page.tsx              # redirects to dashboard or /login
│   ├── login/                # login page + client form
│   ├── forgot-password/      # stub page
│   ├── admin/                # Admin Panel
│   │   └── users/            # user management (list + create)
│   ├── manager/              # Manager Panel
│   ├── user/                 # User Panel
│   └── api/
│       ├── login/route.ts    # POST: authenticate, set session
│       ├── logout/route.ts   # POST: clear session
│       └── users/route.ts    # GET/POST: admin list + create user
├── components/               # PanelShell, LogoutButton
├── lib/
│   ├── supabase.ts           # server-only service-role client
│   ├── auth.ts               # JWT sign/verify (edge-safe)
│   ├── session.ts            # cookie helpers, requireRole
│   ├── password.ts           # bcrypt hash/verify
│   ├── users.ts              # parameterized data-access
│   └── rateLimit.ts          # in-memory login rate limiter
├── middleware.ts             # route protection
├── supabase/schema.sql       # database schema
├── scripts/seed.ts           # seed first admin
├── public/albaker-logo.png   # logo (placeholder — replace with real file)
├── next.config.js            # security headers
├── railway.json / nixpacks.toml  # Railway build — PRODUCTION
├── vercel.json               # Vercel — testing environment only
├── .env.example
└── README.md
```

---

## Environment variables

Set these in `.env.local` for local dev and in the **Vercel** project Environment Variables tab for production (see "Deploying on Vercel"). See `.env.example`.

| Variable | Required | Description |
| --- | --- | --- |
| `SUPABASE_URL` | ✅ | Supabase project URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase **service_role** key (server-only; bypasses RLS). Never expose to the browser. |
| `AUTH_SECRET` | ✅ | Secret for signing the session JWT (HS256). **≥ 32 chars.** Generate: `openssl rand -base64 48` |
| `DATABASE_URL` | ✅ | Direct Postgres connection string. Required for `npm run migrate`, which the Vercel build runs on every deploy (see "Deploying on Vercel"). |

> The app never uses the Supabase **anon** key — all access is server-side with the service-role key.

---

## Setup

### 1. Create the Supabase project & run the schema

1. Create a project at <https://supabase.com>.
2. In **Project Settings → API**, copy the **Project URL** (`SUPABASE_URL`) and the **service_role** key (`SUPABASE_SERVICE_ROLE_KEY`).
3. Open **SQL Editor**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates `app_users`, enables RLS (with **no** anon policies), and adds case-insensitive unique indexes.

### 2. Configure environment variables

```bash
cp .env.example .env.local
# then edit .env.local and fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AUTH_SECRET
openssl rand -base64 48   # use this for AUTH_SECRET
```

### 3. Install & seed the first admin

Requires **Node 24** (see `engines.node` in `package.json`).

```bash
npm install
npm run seed
```

`npm run seed` inserts the first admin using a **bcrypt hash generated at runtime** (no plaintext stored):

- **Username:** `admin`
- **Email:** `yousef@albaker.qa`
- **Password:** `Wle591LdcN`  *(change after first login)*

> To seed with a different password without editing code, set `SEED_ADMIN_PASSWORD` before running: `SEED_ADMIN_PASSWORD='...' npm run seed`. Running the seed again is safe — it updates the existing `admin` row rather than duplicating it.

You can also seed manually: generate a hash and `INSERT` it via the SQL Editor, but the script is the recommended path.

### 4. Run locally

```bash
npm run dev
# http://localhost:3000  → redirects to /login
```

Sign in as `admin` → lands on `/admin` → **Manage Users** to create `manager` / `user` accounts.

---

## Replacing the logo

A generated placeholder lives at `public/albaker-logo.png`. Replace it with the firm's real PNG at the **same path/filename**. The login screen falls back to an “AB” monogram if the file is missing.

---

## Deploying (Railway = production, Vercel = testing)

**Production deploys from Railway. Vercel is the TESTING environment.** Both
are live and both are used, so neither set of instructions below is dead
reference — read the one matching the environment you are changing. They differ
in one way that matters, and it is the reason `vercel-build` exists.

### Both run in an EU region, beside the database

The Supabase project is in **Central EU**. The app used to run in US West,
which put a ~220ms round trip under every single query — and opening a folder
makes several of them, so it cost seconds of visible waiting. Measured from a
US West function, one trivial `select` took 215–272ms; co-located it is single
digits.

So the region is pinned in config, not left to a dashboard default:

- **Railway** — `railway.json` sets `deploy.region` to `europe-west4` (EU West,
  Amsterdam). Config-as-code wins over the dashboard setting. Changing it
  redeploys the service, so it is **not** a zero-downtime edit.
- **Vercel** — `vercel.json` sets `regions: ["fra1"]` (Frankfurt).

If the database ever moves, move both. A mismatch here does not fail anything
loudly; it just quietly makes every page slow again.

### Migrations run in the BUILD, not at startup

Railway's start command **is** `npm run migrate && npm run start`, so every
production deploy applies pending migrations on the way up. **Vercel has no
start command** — a
Next.js app there is built once and then served as functions, so there is no
boot step to hang a migration on. Left alone, the schema would simply never
move, and new code would run forever against the database it was written to
replace.

So the migration runs during the build instead. Vercel prefers a `vercel-build`
script over `build` when one exists, and this repo's is:

```
"vercel-build": "npm run migrate && next build"
```

Plain `npm run build` is left untouched, so a local build does **not** touch any
database.

This is safe because `scripts/migrate.ts` exits 0 on failure by design (see its
header): an unreachable database, or an unset `DATABASE_URL`, prints a loud
`MIGRATION PROBLEM` block and lets the build continue on the schema that exists.
The data layer already tolerates a missing column — that is the state it is in
during every deploy anyway. **Read the build log after deploying a migration**;
a failure is noisy but not fatal, which is exactly why it is easy to miss.

### Required Vercel environment variables

Set these in **Project → Settings → Environment Variables**:

| Variable | Needed at | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | Runtime | As in the table above. |
| `SUPABASE_SERVICE_ROLE_KEY` | Runtime | Server-only. Never expose. |
| `AUTH_SECRET` | Runtime | ≥ 32 chars. |
| `DATABASE_URL` | **Build** | Was optional on Railway. It is now **required**, because it is what `vercel-build` migrates with — without it every deploy skips the migration and warns. |

`DATABASE_URL` must be available to the **Build** environment, not just
Production runtime, or the migration step cannot see it.

### Commits must carry an email Vercel can map

A deployment fails with **"Invalid git email address"** when the commit author's
email is not one Vercel can attribute to an account. It is a deploy-time check
on the commit itself, so a perfectly good build never starts.

The way this happens is quiet: if `user.email` is set neither for the repo nor
globally, git invents one from the machine's hostname —
`someone@Their-Mac.local` — and commits succeed locally for weeks before anyone
tries to deploy them.

Check before committing:

```bash
git config user.email        # must print a real address, not *.local
```

Set it if it is empty or a hostname:

```bash
git config user.email "you@example.com"     # this repo only
```

The address has to be **verified on the GitHub account linked to Vercel**. A
GitHub `…@users.noreply.github.com` address works and keeps a personal address
out of public history.

Only the commit being deployed matters, so a bad author on older commits needs
no history rewrite — the next correctly-authored commit deploys fine.

### Node version

`engines.node` is `24.x`. Vercel reads that field to pick the build image, and
deployments created on or after **2026-10-01** fail on Node 20. Node 24 also
clears the `EBADENGINE` warnings from `@supabase/*`, which require ≥ 22.

---

## Deploy to Railway

1. Push this repo to GitHub (see note below — do this once you provide the token).
2. In Railway, **New Project → Deploy from GitHub repo** and pick this repo.
3. Railway auto-detects **Nixpacks**; `nixpacks.toml` pins **Node 20**, installs deps, and runs `next build`.
4. Add the **environment variables** from the table above in the service **Variables** tab.
5. Railway sets `PORT` automatically; the start command is `npm run start` (binds to `$PORT`).
6. After the first deploy, run the seed once. Options:
   - Locally against the production Supabase project: set the prod env vars in `.env.local` and run `npm run seed`, **or**
   - Use Railway’s one-off command / shell to run `npm run seed`.
7. Open the generated `*.up.railway.app` URL to verify login works.

> **Next.js version:** pinned to `^14.2.35` to satisfy Railway’s security scanner (older versions carry CVEs).
>
> **CI note:** No `.github/workflows` files are included — the provided GitHub token cannot push workflow files.

---

## Attaching the `albaker.io` custom domain (cPanel DNS)

1. In **Railway → your service → Settings → Networking → Custom Domain**, add `albaker.io` (and/or `www.albaker.io`). Railway shows a **CNAME target** like `xxxx.up.railway.app`.
2. Log in to **cPanel** for `albaker.io` and open **Zone Editor** (under *Domains*).
3. Add DNS records:
   - **`www` subdomain (recommended, CNAME):**
     - Type: `CNAME`, Name: `www`, Value: the Railway target (`xxxx.up.railway.app`), TTL: default.
   - **Root/apex `albaker.io`:** apex domains can’t use CNAME. Either:
     - Use cPanel’s **CNAME flattening / ALIAS** record if available (Type `ALIAS` or `CNAME` at root → Railway target), **or**
     - Point the root at Railway with an **A record** if Railway provides an IP for your plan, **or**
     - Set the apex to **redirect to `www`** (cPanel *Redirects*) and serve the app on `www.albaker.io`.
4. Back in Railway, wait for the domain to show **“Active”** — Railway provisions the TLS certificate automatically (Let’s Encrypt).
5. DNS propagation can take from a few minutes up to 24–48 hours. Verify with:
   ```bash
   dig www.albaker.io CNAME +short
   ```
6. Once live, `https://albaker.io` serves the portal over HTTPS (HSTS is enabled).

---

## Security notes

- **Service-role key** is read only in server modules guarded by `import 'server-only'`; it never reaches the browser bundle.
- **RLS** is enabled on `app_users` with no anon/authenticated policies, so the anon key cannot read the table even if exposed.
- **Passwords** are hashed with bcrypt (`bcryptjs`, cost 12). Plaintext is never stored or logged.
- **Sessions** are signed JWTs (HS256) in `httpOnly`, `SameSite=Lax`, `Secure` (in production) cookies; 12-hour expiry.
- **Queries** are parameterized through the Supabase client (no string-built SQL).
- **Login errors** are generic (“Invalid credentials.”) to avoid user enumeration.
- **Rate limiting** on `/api/login`: 10 attempts/minute/IP (in-memory, per instance). For multi-replica strictness, back it with Redis/Upstash.
- **Headers**: CSP, `X-Frame-Options: DENY`, HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `noindex`.

---

## Roles & routes

| Role | Landing route | Extra access |
| --- | --- | --- |
| `admin` | `/admin` | `/admin/users` (list + create users) |
| `manager` | `/manager` | — |
| `user` | `/user` | — |

Unauthenticated visits to any protected route redirect to `/login?next=…`. Authenticated users hitting a route for another role are redirected to their own panel.
