# Edge (embedded) service — runtime data written into the app's local data dir.

The desktop build ships enough of this backend to run the till without a network
connection. The same code serves both roles; only the transport differs.

## Two ways to run the same server

| | cloud | edge |
|---|---|---|
| start | `npm start` | spawned by Tauri (`EDGE_MODE=1`) |
| bind | `0.0.0.0:4000` | `127.0.0.1:<random free port>` |
| database | server's `data/pos.db` | `%LOCALAPPDATA%`/`Application Support` under `edge/` |
| signing key | `JWT_SECRET` | per-machine secret (`edge-secret.key`, generated on first boot) |
| `/api/edge/*` | not mounted (404) | health, queue, unlock, config |

Loopback binding is not cosmetic: the till's database and its offline login must
never be reachable from the local network, and the CORS policy in edge mode
rejects any non-loopback origin.

## How a sale survives an outage

1. The webview always calls the local service — it never switches base URLs
   mid-cart. `connectEdge()` (frontend) pins the API client to `127.0.0.1`.
2. `POST /api/transactions` runs exactly as it does on the cloud, so shift totals,
   stock and the receipt are real, not deferred.
3. `enqueueOutbox()` copies the sale into `edge_outbox` with status `pending`.
4. `startUpstreamWorker()` replays pending rows to the cloud's
   `POST /api/sync/batch`, which dedupes on `client_uuid` — replaying the same
   sale twice still applies it once. Verified: the second replay returns the same
   `transaction_id` with `duplicate: true`.
5. `conflict` / `rejected` rows stay visible via `GET /api/edge/queue/problems`
   for a human to resolve; transient failures back off exponentially (15s → 15min).
6. Resolving one is `POST /api/edge/queue/retry`: after the cause is fixed (in
   practice, stock), the row goes back to `pending` and the next drain replays it.

Two verdicts are not symmetric, and the difference matters:

* `applied` is **terminal**. Replaying an applied sale returns the original
  `transaction_id` and never charges twice.
* `conflict` / `rejected` are **past** verdicts. The cloud re-evaluates them
  rather than replaying the memo, because the cause may have been corrected.
  Before this, a sale refused once for stock could never be applied afterwards —
  retrying was a no-op, and the sale was stranded permanently.

Double-charge protection does not depend on the `sync_queue` memo; it rests on
`transactions.client_uuid` in `persistTransaction`.

A till that is never connected to a cloud keeps its rows pending forever, which
is the intended behaviour for a stand-alone outlet.

## Why the queue is in SQLite, not localStorage

## The other two lanes: kitchen tickets and parked carts

A sale is not the only thing that has to reach the cloud, and the sale replay is
*terminal*: once `/sync/batch` answers `applied`, nothing revisits that
transaction. Two small lanes carry the state that keeps changing afterwards.

| lane | table | endpoint | carries |
| --- | --- | --- | --- |
| KDS status | `edge_queue_sync` | `POST /api/sync/queue` | one row per ticket: status, timestamps, cancel reason, per-line ticks |
| On Hold carts | `edge_hold_sync` | `POST /api/sync/holds` | one row per parked cart: header, lines, and its ticket's state |

Both are absolute (last-write-wins), keyed by an id that exists on both sides —
`transactions.client_uuid` for a sale ticket, the till's own hold id for a parked
cart — both coalesce a burst of taps into one request, and both drain in the same
order: sales → holds → ticket status. Holds go before ticket status because the
cloud must already have the ticket before a status patch can address it.

A hold is cart state, not money: it never entered `edge_outbox`, which is why the
cloud's Hold list used to stay empty while carts sat parked on the till.
Discarding or resuming a cart writes a tombstone instead of a snapshot, so the
cloud's card goes with it; a ticket the bar already started is kept on both sides
(that work really happened) and stays addressable through `order_queue.origin_ref`
even after the hold row is gone.

### Resuming a cart must not ask the bar to make it twice

Parking a cart raises a real ticket, because the drinks are made while the customer
waits. Paying for that cart later — the "resume" flow — therefore must *continue*
the ticket, not raise a second one: the bar has already handed the order over, and a
fresh ticket sends it back to the start of the board.

The sale carries `hold_id` (see `POST /api/transactions`), and the checkout path
hands it to `adoptHoldTicket`, which finds the ticket by `origin_ref` and links it to
the sale while keeping its number, status and timestamps. Lines the sale added at the
counter are folded in — more of a drink bumps that line's quantity, a new item becomes
a new line — and quantities already made are never reduced. `hold_id` travels with the
replay payload too, so `/api/sync/batch` performs the same adoption on the cloud's
copy of the ticket instead of duplicating it there.

Tickets the bar never touched are dropped when the cart is resumed (nothing was made),
so the paid sale simply raises its own ticket in that case.

## Keeping the paired credential alive

The drain runs with the token stored at pairing, which has the cloud's ordinary
access lifetime (`JWT_EXPIRES`, 60 minutes by default). Pairing therefore also
stores the refresh token that came with it, and `lib/edgeUpstream.js` exchanges it
whenever the cloud answers `401` — once, then retries the same request. Without
that, every lane stopped an hour after pairing with "Invalid or expired token" and
the only cure was re-pairing by hand. A till whose pairing is genuinely gone (the
cloud database was reseeded) still reports "re-pair", because its refresh token is
refused as well.


Money must survive a webview cache clear, an app reinstall, or a browser storage
eviction. `edge_outbox` is a real table with a `client_uuid` primary key.

## Offline login

`POST /api/edge/unlock` verifies the PIN against `users.pin_hash` — the same
bcrypt hash the cloud uses — because the edge service holds a replica of the
database. There is deliberately no second credential to drift out of sync. A till
that has never been online has no user rows and therefore cannot log anybody in;
that is the correct failure mode, not a bug.

Rate limiting (`edge_login_attempts`) mirrors the cloud's lockout so a till
cannot be brute-forced faster just because it is local.

## Provisioning a till is a privileged action

`POST /api/edge/pair` (choose which cloud account the till syncs as) and
`GET /api/sync/pin-users` (hand out PIN hashes) both require `device.manage`.

This is deliberate. A bcrypt hash of a 4-digit PIN has only 10,000 candidates, so
releasing one is equivalent to releasing the PIN, and a PIN authorises
manager-level actions such as void approval and cash handover. Without the
permission check, any cashier could pull a manager's hash from their own session
and crack it offline. Pairing decides whose cloud token the till reuses, which is
the same kind of authority, so the two are gated together: whoever may pair may
also provision offline logins.

## Registering the till happens exactly once

The app's login page carries a "Daftar Perusahaan" tab, and the till answers the
same `POST /api/auth/register` route the cloud does. That route creates a company,
a `Cabang Utama` and a `super_admin` — which on a till means an account with every
permission over the local service, including `device.manage`. Since the till's
`companies` table is a *replica* of the cloud's, a second registration is not a
second tenant: it is a phantom row that holds the paired cloud token, the drain
queue and the PIN list, and no bootstrap ever removes it.

So on a till the route is open exactly while `companies` is empty, and refuses
afterwards with `409`. `GET /api/health` reports the same decision as
`features.register`, and the login page hides the tab when it is false. Hiding the
tab is only a courtesy, though: the refusal lives in the route, because a hidden
button protects nothing against a request sent by hand.

The first registration is still required, because it mints the only session that
may call `/api/edge/pair`. In practice: fresh till → register once → pair →
bootstrap → the tab disappears for good. Additional staff arrive from the cloud
via the normal sync, never from the till's login page.

**Changing the cloud address drops the pairing.** `PUT /api/edge/config` requires
`device.manage` when it actually changes the upstream, and clears
`edge_device_token`, `edge_device_user` and `edge_paired_at`, because that token was
minted by the previous host and `upstreamFetch` would otherwise present it to
whatever address was typed in. Re-sending the address the till already has stays
open to any session — the app does that on every login and on branch switch. After
a real change, pair again from Pengaturan → Server.

**A till that already has a second company** is not repaired by either rule: the
phantom row and its `super_admin` were written before the check existed, and they
keep `device.manage` over the local service. `authRequired` re-reads the user row on
every request, so deactivating the account is immediate (no need to rotate keys):

```sql
-- inspect first: a healthy till holds exactly one company
SELECT c.name, u.email, u.role FROM companies c LEFT JOIN users u ON u.company_id = c.id;
-- then disable the phantom tenant's accounts (its data stays, nothing cascades)
UPDATE users SET is_active = 0 WHERE company_id = '<phantom company id>';
```

## Product photos are files, so they need their own lane

`applyBootstrap` copies `products.image_url` and `users.avatar_url` verbatim —
typically `/uploads/p_<uuid>.png`. The till then serves `/uploads` from **its own**
data directory, so a replicated catalogue on a fresh till pointed at a folder that
did not exist: the rows arrived, the replica was correct, and every thumbnail was
broken with no error anywhere. The database replica and the blob store are two
different things and only one of them was being synced.

So photos travel separately, as files:

* `GET /api/sync/assets?branch_id=` (cloud) lists what the branch needs: the photos
  of its branch-available products and the avatars of its active staff, restricted to
  names under `/uploads/`. Rows whose file is gone from the cloud's disk are reported
  in `missing` instead of being offered — one stale path must not fail the pull.
* `GET /api/sync/assets/:name` (cloud) returns that one file. The name comes off the
  URL, so it goes through `uploadPath`, which refuses separators, `..` and anything
  outside the whitelist before any `fs` call.
* `POST /api/edge/sync-assets` (till) pulls the whole manifest — this is also the
  retry button in diagnostics.
* `POST /api/edge/bootstrap` runs it automatically after the replica lands, and
  returns the outcome as `assets` / `assets_error`.

Why a manifest and per-file fetches rather than inlining base64 in
`/sync/bootstrap`: base64 inflates by 1.37×, and the catalogue body would then carry
a shop's entire photo library in one JSON document that has to succeed or fail as a
whole. Counting photos as `MAX_FILE_BYTES`-capped binary downloads also means an
8 MB guard per file instead of one unbounded response.

**Skipping is by size, and that is sound here.** Upload names are random per upload
(`p_<uuid>.<ext>`), so a given name always holds the same bytes — re-uploading a
photo produces a new name and a new row value. Equal size therefore implies equal
content, and no checksums are needed. Files land as `<name>.part` and are renamed
into place, so an interrupted download can never be mistaken for a cached copy. A
size mismatch counts as a miss and refetches.

It is non-destructive: files that drop out of the manifest stay on disk, because a
deactivated product still references its photo and reactivating it should not
blank the image. Progress is recorded in `edge_assets_synced_at` and
`edge_assets_pending` (settings), which `GET /api/edge/info` reports as
`assets: { files, synced_at, pending }` for the diagnostics panel.

The pull is a separate failure lane from bootstrap on purpose: a till that cannot
reach the cloud still gets its catalogue, and only loses photos. `pullAssetsOnce()`
in `server.js` also runs it at service start (quietly, and only when the till is
paired), which is what restores photos after someone clears the uploads folder.


* Node runtime available on `PATH` (or bundled next to the app).
* The backend is copied into the bundle via `tauri.conf.json` → `bundle.resources`.

## Android

Tauri Android cannot run a background Node sidecar cleanly. Mobile builds stay
thin clients against the cloud API; `lib.rs` gates the supervisor behind
`#[cfg(desktop)]` for exactly this reason.
