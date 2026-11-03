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

## Prerequisites on the till

* Node runtime available on `PATH` (or bundled next to the app).
* The backend is copied into the bundle via `tauri.conf.json` → `bundle.resources`.

## Android

Tauri Android cannot run a background Node sidecar cleanly. Mobile builds stay
thin clients against the cloud API; `lib.rs` gates the supervisor behind
`#[cfg(desktop)]` for exactly this reason.
