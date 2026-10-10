# Production capacity and continuity audit — 2026-10-10

The API now has a measured **synthetic localhost run with 10,000 simultaneous SSE connections**, zero transport failures, and 1,269 successful concurrent REST requests over 20 seconds. This is evidence for the fanout implementation, **not a certification of 10,000 viewers on Render**, a database capacity test, or a guarantee that 1,000 different wallets can all receive fresh upstream snapshots.

## Applied topology and recovery evidence

The production API was scaled on October 10 at 09:13 PDT to **three `2c-4g` instances**, with the existing collector, HA PostgreSQL and Key Value retained. Fixed hosting is now **$505/month**, leaving a planning allowance of $25 for backups/recovery tests, $100 contingency and $370 for bandwidth within the $1,000 budget. The scale operation retained API code `fb243da`; the shared-fanout release is a separate deployment gate. The release candidate's 342 unit/integration checks, including PostgreSQL and Redis, passed CI; its browser overflow fixes remain a release gate. Do not confuse a larger plan with a verified production throughput result. [Applied capacity and cost record](LAUNCH_CAPACITY.md#applied-launch-topology).

An **isolated PostgreSQL PITR restore drill passed**. The copy restored the 16:08:20 UTC cutoff and matched production's immutable records at that cutoff: 28,692 trade observations, 21,640 raw pages and 11,214 portfolio batches. It also verified 10,521 wallets, 31,563 jobs, retained history and chart points; the restored heartbeat was 129 ms before the target. The copy became available in about two minutes and validation completed within about four minutes. It was deleted after validation; production connections and checkpoints were unchanged, and the completed logical export remains available. These are observed recovery-copy timings, not a cutover or regional-outage SLA. [Recovery drill evidence and limitations](OPERATIONS.md#freshness-incidents-and-recovery).

## Changes made

- Replaced the fixed 500-connection limit with an explicit `MAX_SSE_CLIENTS` admission ceiling, default 6,000 per API instance. With the applied three-instance topology, the release can admit 18,000 sockets normally and 12,000 with one instance unavailable; these are admission ceilings, not measured throughput guarantees. The running release must be checked before assuming the new limits are active.
- One encoded event, one database notification tail and one heartbeat timer serve all clients in each process. Concurrent bootstrap requests share the overview and replay reads. Fanout yields every 500 clients so socket drains, REST and shutdown can run.
- Slow connections are disconnected once queued bytes exceed 64 KiB, plus at most the current frame. They recover through the saved snapshot and bounded replay instead of retaining unbounded application buffers.
- `/api/events?topics=...` accepts `overview`, `trades`, `asset:0`, `asset:1`, `liquidations`. `overview` carries summary/status/history; asset topics carry that asset's quotes and trades. The liquidation topic carries liquidation trades. Omission preserves the original complete feed. Suppressed records still advance each client's server cursor. Bootstrap trades are filtered to the selected topics.
- Public reads share a one-second, bounded, coalescing cache. Common dashboard reads and high-cardinality profile/query reads have separate pools. Each pool retains at most 2,048 entries and 64 MiB of serialized data; expensive/profile reads admit at most 32 distinct pending keys. Failed admission returns 503 with a two-second `Retry-After`.
- Snapshot responses share JSON, ETag and gzip work. Source times remain unchanged; stale state is recalculated on the next cache load. The cache can delay a health transition by up to one second; it cannot renew the source's observation time.
- Source cache refreshes admit at most 32 distinct pending keys per process. Redis still coordinates the existing shared 4 requests/second, 3 concurrent upstream requests, single-key refresh locks and Retry-After cooldown across instances. No provider quota was increased.
- A cold wallet response reads retained history immediately and returns a null snapshot with an explicit collecting message while a bounded background refresh runs. It never invents a zero balance or waits for the upstream wallet bootstrap. Cached wallet snapshots are refreshed after 30 seconds. Global capacity may delay them longer, with stale/partial status.
- Analytics polling uses jitter and backoff. The browser also suppresses repeat requests to a path during 429/503 cooldowns, honoring Retry-After without blocking unrelated panels.
- API and worker shutdown share one cleanup promise, wait for pending startup, and keep signal handlers installed through repeated SIGTERM/SIGINT. Cleanup cannot be skipped by a second signal.

## Production validation findings and corrections

The first bounded production connection ramp on October 10 stopped automatically after 12 attempts and 9 ready connections: the same overview event ID was delivered twice. All HTTP responses were 200; this was a stream correctness failure, not a successful capacity test. A separate passive connection reproduced overview ID `79012` twice before normal metrics continued ([minimal event evidence](evidence/2026-10-10-production-replay-before-fix.json)).

The corrective release initializes each process's stream cursor from its first valid saved snapshot. Fresh clients no longer receive an unnecessary second bootstrap. If notification retention overtakes a client, it gets an explicit recovery status and reconnects; existing connection IDs never reset backward. Retention changes between bounds and batch reads are checked without treating legitimate rolled-back sequence holes as lost events. Buffered events are preserved.

PostgreSQL sequence allocation alone also did not guarantee commit order across concurrent status, trade and price writers. All PostgreSQL stream appends now share a transaction-scoped advisory lock from allocation through commit, taken after domain writes. A deterministic PostgreSQL test holds the first allocated event uncommitted, verifies later producers cannot become visible ahead of it, and verifies rollback releases the lock. This corrects notification delivery; retained financial records remain independent of the bounded notification log.

Production logs showed all nine test requests identified Cloudflare edges as their rate-limit address; the actual direct socket peer was private. Proxy trust now follows only the verified private Render hop followed by one published Cloudflare edge. It stops before any visitor-supplied prefix and fails closed for other topologies. Tests cover forged prefixes, two visitors sharing an edge, direct public connections, and IPv4-mapped/IPv6 addresses. Recheck this assumption when adding proxies or changing hosting. [Cloudflare ranges](https://www.cloudflare.com/ips/), [forwarded-header behavior](https://developers.cloudflare.com/fundamentals/reference/http-headers/#x-forwarded-for).

The browser request cadence also matters: 10,000 visible overview pages can offer roughly 5,790 REST requests/second, while a representative view mix with some wallet drawers can offer about 4,150–4,300/second before latency. The original local stream test's 63 REST requests/second does not establish capacity for that workload. High-rate shared-read tests and production edge-cache validation are separate gates. Production has not yet passed the repeated ramp or a representative 10,000-viewer mixed workload.

## Configuration and overload behavior

| Setting                             | Default | Scope                                                             |
| ----------------------------------- | ------: | ----------------------------------------------------------------- |
| `MAX_SSE_CLIENTS`                   |   6,000 | Active streams per API process; 503 + Retry-After 15 when full    |
| `API_READ_CACHE_MS`                 |   1,000 | Public read freshness/coalescing window; 0 disables caching       |
| `API_RATE_LIMIT_PER_MINUTE`         |  12,000 | General requests per IP per API process                           |
| `API_PROFILE_RATE_LIMIT_PER_MINUTE` |   3,000 | Requests per IP per profile/query route per API process           |
| `SSE_CONNECT_RATE_LIMIT_PER_MINUTE` |   2,000 | New connections per IP per API process, accommodating shared NATs |
| `WALLET_SNAPSHOT_TTL_MS`            |  30,000 | Shared upstream wallet snapshot refresh interval                  |

Rate limits are abuse/overload boundaries, not allocations of provider capacity. API profile admission and source refresh admission remain bounded even for unique addresses/queries. Rate-limit state is process-local; the source request budget is shared through Redis. Raising the stream ceiling requires measurement and enough memory for sockets and slow-reader buffers.

A focused test issues **1,000 distinct cold-wallet HTTP requests concurrently while the fake source hangs**. At most 32 receive immediate partial history responses; the rest receive explicit 503/Retry-After responses. At most three fake fetches run concurrently, and shutdown waits for admitted background work. This is a controlled-overload test, not evidence that all 1,000 cold profiles are fully live at once.

## Reproducible local load test

```sh
node --import tsx scripts/load/local-capacity.ts --clients=10000 --seconds=20 --profile=mixed
```

The script binds only `127.0.0.1`, starts an API child process with an in-memory SQLite store, and supplies fake upstream responses. It never starts a collector or contacts Papertrade, Hyperliquid, Render or another provider. `--profile=all` tests the unfiltered feed; `overview` tests only global dashboard updates. The client and API run as separate processes on the same host. The harness sends distinct synthetic forwarded IPs to represent viewers behind a trusted proxy and overrides only the per-process stream admission ceiling to 12,000 for the 10,000-socket test.

The mixed profile uses 20% overview plus global trades, 20% overview plus a selected asset, and 60% overview only. It emits approximately 5.56 trades/second, two quotes/second and one metrics update every two seconds. It adds approximately 67 REST requests/second, alternating profile requests and shared overview/market/directory reads. Profiles contain bounded synthetic history pages. The 1,000-distinct cold-profile overload test is separate from this steady load run.

[Raw clean-run evidence](evidence/2026-10-10-local-capacity-10000-mixed.json):

| Measurement                              |                                          Result |
| ---------------------------------------- | ----------------------------------------------: |
| Simultaneous SSE connections             |                                 10,000 / 10,000 |
| Connection ramp                          |                                    1.25 seconds |
| Measured steady interval                 |                                      20 seconds |
| REST responses                           |                        1,269 × 200; no failures |
| Source-to-client latency p99             |                                           67 ms |
| REST latency p99                         |                                        16.97 ms |
| API peak sampled RSS                     |                                         416 MiB |
| API CPU                                  |                    30.49% of one local CPU core |
| Event-loop delay p99 / max               |                                13.33 / 72.09 ms |
| Encoded bootstrap response bytes         |                                 176.78 MB total |
| Steady response bytes, including REST    |                                 160.63 MB total |
| Steady bytes per viewer per second       |                                          803.17 |
| Snapshot reads / notification-tail reads | 62 / 170, including REST/source fixture updates |

Latency samples come from 20 client streams. Byte counts are response bodies, not TLS/TCP/header overhead, static assets or mobile retransmissions. The API memory figure excludes the load-generator process. This run does not measure Postgres round trips, Redis notification latency, Render CPU variability, a reverse proxy, TLS, deployment handover or mobile networks. An earlier attempt experienced a roughly six-minute host/process stall and timed-out connections; it was discarded rather than reported as a successful capacity measurement.

## Bandwidth and the $1,000/month budget

Render's published public-internet outbound rate is **$0.15/GB beyond the workspace allowance**. Its current allowances are Hobby 5 GB, Pro 25 GB and Scale 1 TB. Same-region private Render traffic is not counted. The inspected production workspace is Pro, with a 25 GB monthly allowance. [Render outbound bandwidth documentation](https://render.com/docs/outbound-bandwidth), checked 2026-10-10.

Using the measured mixed-profile body rate of 803.17 bytes/viewer/second and decimal GB:

| 10,000-viewer usage pattern | Response-body traffic | Overage-equivalent cost before plan allowance |
| --------------------------- | --------------------: | --------------------------------------------: |
| One hour                    |              28.91 GB |                                         $4.34 |
| Four hours/day for 30 days  |              3,470 GB |                                          $521 |
| Six hours/day for 30 days   |              5,205 GB |                                          $781 |
| Continuous for 30 days      |             20,818 GB |                                        $3,123 |

These are traffic scenarios, not invoices or promised production rates. Add compute, database, Redis, disk, workspace fees, static assets, headers and transport overhead; subtract the applicable included bandwidth. More viewers on the global trade feed, or a higher trade rate, increases the bill. The original unfiltered production sample measured about 2,285 bytes/viewer/second before these topic changes, equivalent to about 82 GB/hour for 10,000 viewers.

With $505 fixed hosting and the $125 backup/contingency reserve, the $370 traffic allowance supports approximately 86 cumulative 10,000-viewer hours at the synthetic mixed-profile body rate, including the Pro allowance and assuming no other traffic. Actual overhead, baseline traffic and a larger all-trades audience reduce that allowance. A $1,000 budget can support meaningful 10,000-viewer bursts, depending on actual duty cycle. It does **not** fund a continuously connected 10,000-viewer full firehose at the measured rates. Topic selection, closing hidden-tab streams, avoiding redundant overview polling and ETag/gzip REST reduce traffic without altering retained financial records. Set bandwidth alerts and track the actual page/topic mix after a controlled rollout. A strict spend cap would require an explicit lower update cadence or a separate delivery/pricing design, with an honest product change.

## Continuity and source limits

- PostgreSQL remains the durable record/checkpoint store. Worker restarts do not reset history backfill. Raw page revisions, projection facts, job cursors, leases and portfolio observations survive process restarts.
- Collector ownership uses a dedicated PostgreSQL advisory-lock session. Loss of that connection terminates the collector rather than permitting a second owner. History job checkpoints are fenced; an expired worker cannot commit progress after a new worker claims the job.
- Redis disruption pauses new coordinated upstream reads. Existing saved REST data can still be served. SSE notification polling retries the durable database log if pub/sub is unavailable. Stale/partial status stays visible.
- A usable database and previously saved overview remain readiness-successful when Papertrade is down. Cached source outages do not deliberately restart the API. An unavailable database still makes readiness fail.
- Public SSE replay retains only 1,000 notifications. Reconnection receives a saved snapshot plus available deltas; an expired replay window is disclosed. Durable financial/history tables are separate from this notification retention.
- The upstream execution feed and recent-trade endpoint do not promise a complete canonical ledger. A worker outage longer than the available source window can miss global executions. Wallet history backfill can recover available closed records, but cannot prove every open/close event was observed. Cashflow IDs remain provisional where the source supplies no log index. These gaps cannot be fixed by claiming a larger SSE capacity.
- Price quotes are retained as actual source observations, with explicit reconnect gaps; downtime does not generate synthetic points. Revisions and source timestamps are guarded against regression. Portfolio source coverage can remain incomplete independently of our local backfill progress.
- At the deliberate global 4-request/second source budget, one refresh of 1,000 different uncached wallet snapshots takes **at least 250 seconds before other source work**. The actual history/summary workload makes this longer. More API replicas do not remove this source limit. Continuously fresh snapshots for all those wallets require a source-approved bulk/change stream or a different ingestion agreement.
- The separate managed-database PITR drill described above **passed**; it validated a recovery copy without changing production. A real API/worker cutover, provider-level regional outage and sustained external backup/retention schedule remain untested or unconfigured. Verify RPO/RTO, backup age and disk-growth alerts operationally. The local storage cap fails visibly instead of deleting ledger data.

## Numeric and regression checks

Dedicated tests cover $10 billion positions at 1,000× leverage, 100 such positions summing to $1 trillion, deduplication, exact raw decimal-string balances/deposits and exact raw aggregate notional conversion. These magnitudes remain valid; no 32-bit truncation or leverage multiplication is introduced. Raw monetary amounts are preserved as strings/BigInt. Public USD execution prices/notional and observed-volume projections are source floating-point observations, not a replacement for exact accounting.

Focused checks also cover 2,000 coalesced bootstrap clients, event encoding once per publication, selected topics, bootstrap races, slow readers, database-tail retry without duplicate events, one-second stale-state recalculation, cache eviction/admission, shared-NAT connection bursts, 429/503 browser cooldown and repeated-signal API/worker cleanup. Existing PostgreSQL/Redis integration, persistence restart, projection correction, lease-fencing and source validation suites remain part of the final combined release gate.
