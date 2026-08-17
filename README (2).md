# Hardware Configurator & Tender Reader

Three surfaces over one catalog and one compatibility rule engine, for
Panache DigiLife:

- **Configurator** (`/`) — a prospect builds a machine from real parts.
  Impossible combinations are blocked live, with the reason shown.
- **Admin** (`/admin`) — parts, landed costs, margins, stock, lead times,
  rules, extraction fields, leads, tenders. Excel round-trip throughout.
- **Tender reader** (`/tender`) — upload a GeM tender, get cited key points,
  rule-valid matched builds, a stock and lead-time read, and a budgetary
  quotation.

**The AI reads. Deterministic code prices.** The model turns tender prose
into structured requirements and does nothing else. It never sees a cost, a
margin or a price, and it never picks a part. Part selection is a constrained
search over the catalog validated by the same rule engine the configurator
uses; pricing is arithmetic in `src/lib/pricing.js`. The worst a misread can
do is state a wrong requirement — and every extracted value carries its page
number and a verbatim evidence fragment so that is checkable in seconds.

---

## Build status

This repository is being built in the order set out in the brief, testing
each layer before moving on. Where something is not built yet it says so
here rather than half-working.

| Layer | State |
|---|---|
| 1. Data layer + schema | **Done**, tested against a real Postgres |
| 2. Catalog CRUD + Excel round-trip | **Done**, tested |
| 3. Rule engine + browser build | **Done**, 25 unit tests over every operator and side kind |
| 4. Configurator UI | Not started — shared stylesheet and login page only |
| 5. Tender extraction | Not started |
| 6. Matching + quotation | Not started |
| 7. Auth hardening | **Done** (constant-time compare, per-IP lockout, trust proxy) |
| 8. Deploy configs | `render.yaml` and `vercel.json` written; `BlobIntake` lands with layer 5 |

`npm test` runs the rule engine tests with no database.
`npm run test:integration` needs `DATABASE_URL` and `ADMIN_TOKEN`, and creates
and drops its own tables — point it at a scratch database, never production.

---

## What works on which host

| | Render (Web Service) | Vercel |
|---|---|---|
| Configurator | Yes | Yes |
| Admin dashboard | Yes | Yes |
| Excel import / export | Yes | Yes (files are well under the cap) |
| Tender upload | Yes, `UPLOAD_MODE=disk` | Only with `UPLOAD_MODE=blob` |
| Tender pipeline | Yes | Yes, once the file is in object storage |
| Long extractions | Yes | Yes — Pro allows up to 30 minutes |

Vercel's **4.5 MB request body cap** is infrastructure, not configuration.
Real GeM tenders routinely exceed it, and no `vercel.json` setting raises it.
It has no persistent filesystem and never runs `app.listen()`. So:

- `src/app.js` exports the configured app and **does not listen**.
  `server.js` listens (Render, local); `api/index.js` wraps the same export
  as one function (Vercel).
- File intake sits behind one interface with two implementations, chosen by
  `UPLOAD_MODE`:
  - `disk` — multer to a temp path. Render and local.
  - `blob` — the browser uploads straight to Vercel Blob / S3 / R2 via a
    presigned URL and posts only the resulting URL; the server fetches and
    parses it. The large payload never transits a Vercel function, so the cap
    stops applying.

Render is the primary host. If you deploy only one, deploy that one.

---

## Local setup

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and ADMIN_TOKEN
npm run dev                 # http://localhost:3000
```

Use the **pooled** Neon connection string (the host contains `-pooler`).
The unpooled one works locally and exhausts connections under Render.

The schema is created idempotently on boot and seeded only when empty.
**It seeds settings and the ~22 extraction fields, and no parts.** An empty
catalog is more useful than a fictional one: fake parts produce confident
nonsense on a real tender. Load your catalog through Admin → Excel import.

Compatibility rules are also not seeded. A starter pack of ten
server/workstation rules lives in `src/rules/starter-pack.js` and loads on
demand from Admin → Rules once your category ids exist. They are ordinary
editable rows from that moment on.

---

## Excel import format

Download the current catalog from Admin (`GET /api/admin/export.xlsx`), edit,
upload it back. Sheets: `Categories`, `Options`, `Rules`,
`ExtractionFields`, `Settings`. Any sheet you leave out is skipped.

Rules of the round-trip:

- Rows match on **`id`**. A new id creates a row; a known id updates it.
- **Nothing is ever deleted by an import.** Retire a part with `active = 0`.
- The import runs in **one transaction**. If any row fails validation the
  whole file is rejected and the database is untouched — a half-applied price
  list is worse than a rejected one.
- `attrs` is a JSON object, e.g. `{"socket":"LGA3647","cores":10,"tdp":100}`.
  It is validated before anything is written.
- **`price` is the landed cost.** It is never sent to a customer.
- An **empty `margin_pct`** means "use `default_margin_pct`" and is stored as
  NULL. A stored 0 means "sell at landed cost" — the API refuses to write 0
  unless you send `allow_zero_margin: true`, because a 0 that was meant as
  "unspecified" quietly shows customers your cost.

`Options` columns: `id`, `category_id`, `name`, `specs`, `price`,
`stock_qty`, `lead_days`, `active`, `attrs`.
`lead_days = 0` means **no lead time on record**, not "available today".

---

## Rules are data, not code

A rule compares a left side to a right side and carries the plain-English
message the customer reads when it blocks something.

Side kinds: `sum`, `max`, `min`, `count`, `value`, `const`, `expr`.
Operators: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `nin`, `subset`.
`left_scale` and `left_offset` give headroom maths — PSU wattage ≥
(total draw × 1.25) + 110 is `sum` of `tdp` with scale 1.25 and offset 110,
compared `lte` against `max` of `watts`.

Two behaviours worth knowing:

- **A rule with a missing side is skipped, not failed.** A half-built
  configuration is incomplete, not illegal.
- Comparisons are universally quantified over the left side: *every* selected
  memory module must match the board, not just one.

`/rules.browser.js` is `src/rules/engine.js` served verbatim — the browser
validates with the exact code the server trusts. There is no second copy and
no build step. Do not fork it.

Admin → Rules includes a tester: pick a build, see every rule, whether it
fired, the arithmetic on both sides, and why any rule was skipped.

---

## API

Public:

- `GET /api/catalog` — categories, options at **sell** price, enabled rules.
  Costs and margins are stripped here, at the API layer, so a template
  mistake cannot expose them.
- `POST /api/validate` — `{ selection: [{ option_id, qty }] }` → blocks,
  warnings, missing required categories.
- `POST /api/price` — the same shape → a priced build sheet.
- `POST /api/enquiry` — validates server-side before storing. A build the
  browser allowed but the rules block is rejected with 422.

Admin (all under `/api/admin`, all requiring the token):
`catalog`, `categories`, `options`, `options/:id` (DELETE retires),
`rules`, `rules/:id`, `rules/test`, `rules/starter-pack`, `settings`,
`export.xlsx`, `import`, `leads`, `tenders`.

`GET /healthz` reports the database connection.

## Auth

One shared `ADMIN_TOKEN`, accepted as an `x-admin-token` header, a
`Bearer` token, a `?token=` query parameter, or an `admin_token` cookie.

- Comparison is **constant-time** (both sides hashed to a fixed width first,
  so length does not leak either).
- **8 failed attempts per IP** locks that IP out for 15 minutes with a 429
  and a `Retry-After`. Both limits are env-tunable.
- `app.set('trust proxy', 1)` — behind Render and Vercel the real client IP
  is in `x-forwarded-for`.
- Proxy headers are **not** used to infer internal vs external. Every request
  behind a platform proxy carries them; that check locks out everyone.

Per-user logins later mean changing `verify()` in `src/lib/auth.js` and
nothing else.

## Postgres notes

Plain SQL through `pg` — no ORM. `src/db/pool.js` exposes `q.get`, `q.all`,
`q.run`, `q.val` and `q.tx`, rewriting `?` and `@named` placeholders to
`$1..$n`. Inside `q.tx` use the helper passed to your callback, not the
module-level `q`, or the statements escape the transaction.

Schema statements run **one at a time**; some poolers reject multi-statement
queries. `COUNT(*)` is cast with `::int`, new ids come from `RETURNING id`,
and `EXCLUDED` is uppercase in `ON CONFLICT DO UPDATE`.

Settings are cached for a few seconds (`SETTINGS_TTL_MS`) because pricing and
the rule engine read them on nearly every request and the database is now a
network hop away. Every write clears the cache.
