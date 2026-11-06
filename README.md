# POS Backend

Express + SQLite API for a multi-branch POS. It serves **two roles from one
codebase**: the **cloud** server, and the **edge** service embedded in the desktop
till. Only the transport differs — see [EDGE.md](./EDGE.md) for the edge design.

- **Runtime:** Node 18+ (developed on 20.x), ESM (`"type": "module"`)
- **Database:** SQLite via `better-sqlite3` — synchronous, no ORM, no migration tool
- **Auth:** JWT access token + rotated refresh token; 4-digit PIN for offline till unlock

---

## Quick start

```bash
npm install
npm run seed     # creates data/pos.db with demo company, branches, products, users
npm run dev      # http://localhost:4000, restarts on change
```

Verify:

```bash
curl -s localhost:4000/api/health
# {"ok":true,"service":"pos-backend","version":"1.0.0","time":"..."}
```

`npm run seed` **wipes and recreates** the database. `npm run reset` does the same
explicitly (`rm -f data/pos.db && npm run seed`).

### Demo accounts (password `password123`)

| Role | Email | PIN |
|---|---|---|
| Super Admin | `admin@kopinusantara.id` | `1234` |
| Manager (Jakarta) | `manager.jkt@kopinusantara.id` | `2222` |
| Cashier (Jakarta) | `kasir.jkt@kopinusantara.id` | `1111` |
| Cashier (Bandung) | `kasir.bdg@kopinusantara.id` | `1112` |

---

## Scripts

| Script | Does |
|---|---|
| `npm start` | Run the server (no watch) |
| `npm run dev` | Run with `--watch` |
| `npm test` | Full suite — spawns real cloud + real edge processes |
| `npm run seed` | Recreate `data/pos.db` from scratch with demo data |
| `npm run reset` | Delete the DB, then seed |
| `npm run cli -- status` | Operator CLI: `status`, `create-company`, `set-password` |

### Tests

`npm test` is **not** a unit suite. Each test boots a real cloud server and a real
edge server as child processes on OS-assigned ports, then asserts over real HTTP
against two real SQLite files. A full run takes ~40s; every test builds its own
world (~2s each) because leftover stock or queue rows would mask exactly the
failures being asserted.

- `test/edge-sync.test.mjs` — replay idempotency, duplicate delivery, conflict-then-retry,
  and first-bootstrap onto a till that has never synced
- `test/stock-policy.test.mjs` — the three stock policies, at checkout and on replay
- `test/settings.test.mjs` — settings permission boundary, validation, bootstrap allowlist
- `test/register-once.test.mjs` — one company per till, and the cloud's `ALLOW_SIGNUP` switch
- `test/web-root.test.mjs` — serving the built SPA from the API process (`WEB_ROOT`),
  including the two ways it can break: swallowing `/api/*` and caching `index.html`
- `test/cli.test.mjs` — `src/cli.js` creates exactly one company, with its branch and owner

Tests must run serially (`--test-concurrency=1`) because each one binds real ports.

---

## Configuration

All configuration is environment variables. There is no config file.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address. **Ignored in edge mode**, which is always `127.0.0.1` |
| `JWT_SECRET` | `dev-secret-change-me` | Cloud token signing key. **Set this in production.** |
| `JWT_EXPIRES` | `60m` | Access token lifetime |
| `REFRESH_TTL_DAYS` | `30` | Refresh token lifetime |
| `DB_DIR` | `./data` | Directory for `pos.db` and `uploads/` |
| `DB_PATH` | `$DB_DIR/pos.db` | Explicit database file path |
| `WEB_ROOT` | unset | Serve the built web app (`frontend/dist`) from this process, so one port serves the SPA and the API. Cloud only; **ignored in edge mode** |
| `EDGE_MODE` | unset | `1` runs the embedded edge service |
| `EDGE_JWT_SECRET` | unset | Edge signing key (set by the Tauri supervisor) |
| `EDGE_UPSTREAM_URL` | unset | Cloud base URL for the edge drain worker |
| `ALLOW_SIGNUP` | unset (open) | Set to `0` to close `POST /api/auth/register` on the **cloud**. A till ignores it — it has its own one-time rule |
| `LOGIN_MAX_FAILS` | `6` | Failed logins before lockout |
| `LOGIN_WINDOW_MINUTES` | `15` | Rolling window for counting failures |
| `LOGIN_LOCK_MINUTES` | `15` | Lockout duration |

A missing `JWT_SECRET` silently falls back to a known dev value. Rotate it by
changing the variable; all existing tokens stop validating.

**Company registration.** `POST /api/auth/register` is the only self-service way to
create a tenant, and on a **cloud** it stays open unless you set `ALLOW_SIGNUP=0` —
which is what a deployment owned by a single, already-registered company wants, and
what you should do once your company exists. On a **till** the flag is ignored: the
route is open only while the local replica holds no company at all, because the
till's `companies` row is a copy of the cloud's and a second signup there would be a
phantom `super_admin` tenant over the local service. See `EDGE.md`.

---

## Deployment

Three supported shapes, all documented in [../deploy/README.md](../deploy/README.md):

| Shape | Entry point | Best for |
|---|---|---|
| Docker — one container, API + SPA + named volume | `docker compose up -d --build` | a VPS, or a host that already runs Docker |
| Linux — systemd unit, dedicated user, offline payload | `sudo ./install.sh` | a shop server with no Docker |
| Windows — scheduled task running as SYSTEM | double-click `install.cmd` | the same, on Windows |

All three set `WEB_ROOT`, so **one process and one port** serve both the SPA and the
API: the browser's origin *is* the API, so there is no CORS and no reverse proxy to
configure. Put nginx/Caddy in front only when you need TLS.

A deployed server is single-tenant, so signup is closed (`ALLOW_SIGNUP=0`) and the
first company is created out of band, on the console:

```bash
# Docker
docker compose run --rm pos node src/cli.js create-company \
  --company "Nama Perusahaan" --name "Nama Owner" \
  --email owner@example.com --password "rahasia123"

# anywhere else (systemd/Windows installers ask for the same four values)
node src/cli.js create-company --company ... --name ... --email ... --password ...
node src/cli.js status          # database path, company, row counts
node src/cli.js set-password --email owner@example.com   # recovery; no email is sent
```

Tills are separate: they embed this same code as an edge service (`EDGE_MODE=1`)
and are installed from the Tauri bundle, not from these packages. See
[EDGE.md](./EDGE.md).

---

## Data model notes

**Money is stored as integers.** No floats anywhere in the money path.

**Stock lives in two places per product per branch:**

- `branch_products.is_available` — an on/off flag for the menu
- `branch_stocks.quantity` — the actual count

`branch_stocks` has **no `updated_at` column** except in rows created by
`/sync/bootstrap`. This matters if you build a cloud→till stock delta pull: add the
migration first, because you cannot watermark on a column that does not exist.

**Idempotency is `transactions.client_uuid`**, not the `sync_queue` memo. Replaying
a sale returns the original `transaction_id` and never charges twice. Do not move
this guarantee into `sync_queue` — that table is a cache whose statuses get
rewritten as rows are retried.

**`settings` is populated by `initSchema`** with `INSERT OR IGNORE` defaults, so an
existing value is never overwritten. `seed.js` also writes them, but `seed.js` is a
demo script the service never runs — do not rely on it for defaults that must
exist in production.

---

## Stock policy at checkout

`settings.allow_negative_stock` controls what happens when a sale asks for more
stock than the branch has.

| Value | At `POST /api/transactions` | On offline replay (`/sync/batch`) |
|---|---|---|
| `warn` *(default)* | Sale succeeds; shortfalls returned in `stock_warnings` | **Refused** → conflict queue |
| `block` | `409 INSUFFICIENT_STOCK` with shortfalls; no transaction, no stock move | Refused → conflict queue |
| `ignore` | No check | Applied |

`warn` is the default deliberately: upgrading must not start refusing sales at a
busy counter.

The replay asymmetry is intentional. An offline replay is reconciled *after the
fact*, so there is no cashier left to warn — refusing puts the sale in the queue
for a human instead. Only `ignore` turns the check off there.

The check runs **inside** the same `db.transaction()` as the decrement, so it
cannot interleave with a concurrent sale. Under `block` the refusal throws before
any write, so the sale rolls back whole.

Change it via the API (requires `company.manage`, i.e. super_admin):

```bash
curl -X PUT localhost:4000/api/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"allow_negative_stock":"block"}'
```

---

## Permissions

Declared in `src/permissions.js`, enforced with `requirePermission('key')`.
Built-in roles: `super_admin`, `manager`, `cashier`, `warehouse`, `kitchen`.
Custom roles live in the `roles` table.

Two that matter operationally:

- **`company.manage`** — super_admin only. Gates `GET/PUT /api/settings`.
- **`device.manage`** — gates `POST /edge/pair` and `GET /sync/pin-users`. Both
  decide whose cloud credentials a till reuses, and both hand out material that
  authorises manager-level actions. A bcrypt hash of a 4-digit PIN has only 10,000
  candidates, so releasing one is equivalent to releasing the PIN.

### What a till replicates

`GET /sync/pin-users?branch_id=` returns the branch's **whole active roster**, with
`pin_hash` where it exists — not only the users who hold a PIN. The earlier
PIN-holders-only filter silently dropped a manager who had never set a PIN: they
could not unlock the till and the offline staff list omitted them with no
explanation.

`password_hash` is **never** in that payload. Shipping it would make every till's
unencrypted SQLite file an offline-crackable credential store — a PIN has 10,000
candidates and a rate-limited unlock path, a password has neither. The replica
stores the sentinel `'!offline-replica'` instead, so offline login is PIN-only and
password login stays an online path to the cloud. This is a deliberate product
decision, not an omission: it is what makes "same account auth on cloud and edge"
safe to ship.

Two consequences handled in `applyBootstrap`:

- A till set up by registering locally already holds its own admin row for the same
  person (same `email`, different `id`; `users.email` is UNIQUE). Replication
  updates that row **in place** rather than inserting the cloud id or deleting it:
  the local id is baked into tokens already issued, and deleting it would log the
  admin out mid-setup. `company_id` is left alone, because `authRequired` rejects a
  token whose `company_id` disagrees with the stored row (*Tenant mismatch*).
- The summary splits `users` (roster size) from `pin_users` (how many can actually
  unlock). A single number let a till look provisioned while nobody could log in.

---

## API surface

Everything is under `/api`. `GET /api/openapi.json` returns a machine-readable spec
and `GET /api/permissions` the matrix for the caller.

| Module | Covers |
|---|---|
| `auth.routes.js` (`/auth`) | register, login, PIN login, refresh, me, company |
| `org.routes.js` | branches, users, roles |
| `catalog.routes.js` | categories, products, variants, per-branch catalog |
| `stock.routes.js` | branch stock, adjustments, movements |
| `transfer.routes.js` | inter-branch transfers |
| `pos.routes.js` | transactions, receipt, void |
| `hold.routes.js` | hold orders |
| `kitchen.routes.js` | order queue |
| `shift.routes.js` | open/close shift, cash handover, reconciliation |
| `device.routes.js` | terminal registration, remote logout |
| `report.routes.js` | daily/sales reports, export |
| `audit.routes.js` | audit log |
| `settings.routes.js` | **editable settings, allowlisted** |
| `sync.routes.js` (`/sync`) | `bootstrap` (full snapshot), `batch` (offline replay) |
| `edge.routes.js` (`/edge`) | **edge mode only** — health, queue, unlock, config, pair |

In cloud mode `/api/edge/*` is not mounted and returns 404.

### Editing settings

`PUT /api/settings` accepts an **allowlist** defined in `src/routes/settings.routes.js`.
Keys outside it are rejected, not ignored — silently dropping a typo'd key would
leave an operator believing a policy is in force when it is not.

The allowlist is not decoration: `settings` also holds the `edge_*` upstream
credentials, so a blanket writer would let a caller repoint a till at an arbitrary
upstream — the same authority `POST /edge/pair` gates behind `device.manage`. Every
change is audited with its previous value.

`/sync/bootstrap` sends tills a **separate, smaller** allowlist (`TILL_SETTING_KEYS`).
Adding a sensitive key to `settings` does not automatically ship it to tills.

---

## Running behind the desktop app

The Tauri app bundles this backend (`tauri.conf.json` → `bundle.resources`) and
spawns it with `EDGE_MODE=1` on a random loopback port. It expects:

- `node` on `PATH` (or bundled beside the app)
- `backend/src/server.js` at the expected relative path
- write access to `DB_DIR`, which the supervisor points at the app's **local**
  (non-roaming) data dir

`better-sqlite3` is a **native, platform-specific** module. Whatever platform
builds the Tauri bundle also decides which binary gets packaged — see the frontend
README for the consequence, because it is the single most likely thing to break a
cross-platform build.

---

## Operational notes

**Backups.** SQLite is one file, but a naive `cp` during a write can capture a
half-committed WAL. Use:

```bash
sqlite3 data/pos.db ".backup /path/backup.db"
```

**Roaming/synced directories break SQLite.** OneDrive, iCloud Drive and similar can
corrupt the WAL journal mid-shift. `src-tauri/src/edge.rs` deliberately uses the
local app data dir for this reason; keep cloud deployments off synced paths too.

**Uploads** go to `$DB_DIR/uploads` and are served at `/uploads/:filename`
unauthenticated. Filenames are random UUIDs and so not enumerable. Public-read is
by design so `<img>` tags work without a token — do not put anything private there.

**Migrations** are the idempotent `migrate()` in `src/db.js`, run on every boot. It
adds missing columns via `ALTER TABLE`. There is no version table and no
down-migration, so any schema change must be safe to run twice.

