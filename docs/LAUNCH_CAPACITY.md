# Launch capacity and budget

Reviewed October 10, 2026. The target is **5,000–10,000 simultaneous viewers for a few hours around launch**, with a **$1,000 monthly infrastructure budget**. This document records applied infrastructure and remaining release gates; it is not evidence that the deployed system supports that load. The authorized API scale operation completed on October 10 at 09:13 PDT. A separate recovery drill validated the copied records and checkpoints; production database connections remained unchanged.

## Applied launch topology

The API now has **three `2c-4g` instances**, retaining the existing collector, HA Postgres and Key Value. This brings fixed hosting from **$300 to $505/month** and leaves budget for a short launch spike. Autoscaling remains off for the initial controlled event. The shared stream/read-cache and retained house/liquidation release is deployed as `cd85c2b`. Ordering and proxy-identity fixes in `00e2bc6` are deployed to the API and collector. The API then advanced to `a4f5430`; all three replicas are live. Native edge caching is enabled with the verified one-second policy described below. Preserve the database and collector checkpoints. Neither a blockchain node nor additional upstream connections are needed merely because more people view the dashboard.

Three replicas provide a useful failure margin: the deployed application limit of 6,000 streams per process permits 18,000 admissions normally and 12,000 with one replica unavailable. Those are admission ceilings, **not measured throughput guarantees**. Two replicas would leave only 6,000 admissions during a restart, below the 10,000-viewer target. Measure actual distribution and hot-instance utilization; aggregate capacity alone is insufficient.

## Observed deployment and fixed cost

The authenticated Render console was inspected, and only the separately authorized API scaling and recovery-copy actions were applied. Backend resources are in Oregon, in the dedicated Paperdash Pro workspace. The static frontend is served globally. Service and Blueprint auto-deploy remain off.

| Resource | Previous configuration | Previous monthly cost | Applied launch configuration | Launch monthly cost |
| --- | --- | ---: | --- | ---: |
| Workspace | Pro | $25 | Keep Pro | $25 |
| Frontend | Render static CDN | $0 compute | Unchanged | $0 compute |
| API | 2 × `1c-2g` | $50 | 3 × `2c-4g` | $255 |
| Collector | 1 × `1c-2g` | $25 | Unchanged | $25 |
| Postgres 18 | `2c-4g` primary and HA standby | $150 | Unchanged initially | $150 |
| Postgres storage | 50 GB per copy | $30 | Unchanged | $30 |
| Valkey 8 | `1g`, `noeviction` | $20 | Unchanged initially | $20 |
| **Fixed total** | | **$300** | | **$505** |

Scaling first added a third `1c-2g` replica, verified live, then upgraded all three to `2c-4g`. Render reported successful deployment `dep-db56852d0e5s73ebmg4g` at 09:13:08 PDT, trigger **Compute plan updated**, code `fb243da`, and **3 of 3 instances**. All three instance logs returned readiness HTTP 200. No environment or other production resource changes accompanied it. This observation does not establish uninterrupted availability at every instant or tested launch capacity.

Compute prices above were visible in the account's plan selectors. The API selector also offers `2c-8g` at $135 and `4c-8g` at $175 per instance. Postgres `2c-8g` is $100 per copy, a $50/month increase with HA. Key Value `3g` is $60, a $40/month increase. Do not buy those upgrades without evidence of database/cache pressure. HA bills both compute and storage and does not expose its standby for read scaling. [Render pricing](https://render.com/pricing), [HA behavior and billing](https://render.com/docs/postgresql-high-availability).

The sampled API dashboard showed only 2,135 requests in its preceding 12-hour view and 40 MB of monthly outbound traffic. Memory was visually around 5% and CPU mostly near zero, with small spikes. These low-load observations cannot establish launch capacity. Postgres showed a memory graph, but its other metrics/table widgets returned no data; that is missing telemetry, not an empty database or proof of spare capacity. The console showed a 100-connection Postgres limit and a 1,000-connection Key Value limit.

## Monthly budget and traffic arithmetic

| Budget line | Monthly allowance |
| --- | ---: |
| Applied fixed hosting | $505 |
| External backups and temporary recovery-test compute | $25 |
| Capacity, storage, build and tax contingency | $100 |
| Remaining bandwidth allowance | $370 |
| **Planning ceiling** | **$1,000** |

The backup and contingency lines are allowances, not purchased services or guaranteed prices. Domain renewal is separate. Additional sustained use must be included in the monthly total, not just the launch hours.

Render Pro includes **25 GB/month**, then charges **$0.15/GB** for public outbound traffic, including HTTP/static responses and streaming data. Same-region private service traffic is not charged. A normal Cloudflare proxy does not erase Render's bill for bytes it sends to that proxy. [Outbound bandwidth pricing](https://render.com/docs/outbound-bandwidth).

A passive production check on October 10 sampled the current all-topic SSE stream at approximately **2,285 bytes/second per viewer**, excluding bootstrap. This is a short sample, not a peak or an invariant. The following calculations use decimal GB, one stream per viewer and a 30-day month; they exclude REST polling, headers, reconnect replay, initial pages/assets, backups and traffic variation:

`GB = viewers × bytes_per_second × seconds / 1,000,000,000`

| Scenario at the sampled all-topic rate | Stream GB | Egress if this were the month's only traffic, after 25 GB |
| --- | ---: | ---: |
| 10,000 viewers for 1 hour | 82.26 | $8.59 |
| 10,000 for 4 hours | 329.04 | $45.61 |
| 10,000 for 8 hours | 658.08 | $94.96 |
| 10,000 for 24 hours | 1,974.24 | $292.39 |
| 10,000 continuously for 30 days | 59,227.20 | $8,880.33 |

The 25 GB inclusion applies once per workspace per month. After it is consumed, a 10,000-viewer hour adds about **$12.34** of streaming egress. Halve the traffic and incremental cost for 5,000 viewers. A background 100 concurrent viewers all month plus 10,000 additional viewers for four hours produces roughly 921 GB and $134 of SSE overage: approximately **$764 including fixed hosting and the two reserves**, before omitted traffic. The $370 bandwidth allocation buys about 30 cumulative 10,000-viewer hours at this sample rate with no other traffic. This is why a short event is plausible within the budget while sustained 10,000-viewer usage is not.

Keep Pro. Scale costs $499/month versus Pro's $25; its 1 TB inclusion is not worth that $474 increase solely to replace at most $146.25 of Pro bandwidth overage. [Workspace plans](https://render.com/docs/new-workspace-plans).

## Application and connection gates

The shared-tail, bounded-read and admission changes below are deployed in `cd85c2b`. The first bounded public smoke stopped after nine bootstraps and twelve connection attempts because one connection received a duplicate overview event ID; it did not establish capacity. A separate ten-second passive check reproduced that defect. Release `00e2bc6` fixes cold/idle bootstrap ordering, retained-prefix races, PostgreSQL event commit ordering and the verified Render proxy chain; it passed full CI and is deployed. The collector acquired its lease and subscribed at 10:06 PDT. API deployment IDs are `dep-db56vkjrjlhs73cl2rn0` (`00e2bc6`) and `dep-db571atckfvc7396gtl0` (`a4f5430`); the collector is `dep-db5707flot8c73duhnjg` (`00e2bc6`). Frontend remains `cd85c2b`. Recheck exact commits and runtime settings for each subsequent release.

- **One shared tail per API process:** `EventHub` reads and encodes retained events once, maintains a bounded replay buffer, filters topics, and fans out to viewers. New sessions share a bounded bootstrap. Database work must scale with API replicas and event volume, rather than one database poll per viewer.
- **Admission and slow clients:** `MAX_SSE_CLIENTS` defaults to 6,000 per process; reject excess admissions with retry guidance. The implementation bounds buffered writes and yields during large fan-out. Test slow consumers and reconnect storms rather than just idle sockets. One Node process may still bottleneck on one busy JavaScript thread even on a two-CPU plan.
- **Database pools:** the inspected store caps each process at six Postgres connections. Three APIs plus one worker allow 24 normal pool connections; a conservative overlap of all those processes uses 48, before migrations/admin sessions. The worker's advisory lease consumes a pool connection. Keep substantial room below the observed limit of 100. Browsers must never allocate individual database or Redis connections.
- **Redis:** each process has its coordination client and shared notification clients. Keep `noeviction`; this instance holds coordination state, not a discardable general-purpose cache. A failure must continue to stop fresh upstream work safely. Monitor CPU, latency, reconnects and used memory before increasing the plan.
- **REST and stream payloads:** cache identical bounded reads, compress reusable responses, send only subscribed topics, stop hidden-tab polling, and retain accurate source timestamps. ETags save payload but still require requests. Measure the new mixed-view traffic rate after deployment; do not budget hypothetical topic savings as if measured.

Render automatically balances replicated services, but long-lived connections stay with the instance accepting them until reconnect. Its WebSocket documentation explicitly says new/reconnected connections are randomly assigned and have no affinity guarantee. Paperdash uses **HTTP SSE**, so that WebSocket statement does not establish SSE's exact routing algorithm. Do not depend on sticky sessions, exact even distribution, or existing sockets migrating after scale-out. Validate per-instance counts and reconnect across instances through the real service URL. [Render WebSockets](https://render.com/docs/websocket).

## Shared IPs and edge options

There are two different shared-IP risks:

1. **Visitors behind one NAT.** A campus, conference, VPN or carrier may put many viewers behind one public IP. The deployed launch release defaults to 12,000 general requests/minute/IP, 3,000 profile requests/minute/IP per protected route, and 2,000 SSE connection requests/minute/IP, alongside 6,000 active streams/process. Those request counters are in memory and are not shared across replicas. Large shared-NAT populations can still exhaust them; an active-stream ceiling and a connection-attempt rate are different limits. Validate the trusted proxy chain; never trust an arbitrary client-supplied forwarding header. Use route-specific limits, capacity admission, reconnect jitter and bounded expensive queries; test shared-NAT access explicitly before choosing final thresholds. Removing all limits is not the remedy.
2. **Collector egress through Render's shared IP ranges.** These ranges are shared with other services in the region, so upstream IP-based throttling or reputation can affect the collector. Retain the shared upstream budget and obey `Retry-After`. Dedicated outbound IPs cost $100/month for three reserved IPv4 addresses per region; consider them only with an upstream allowlisting/reputation need. They do not solve browser NAT limits or grant permission to increase upstream requests. [Outbound IP ranges](https://render.com/docs/outbound-ip-addresses), [dedicated IP pricing](https://render.com/changelog/add-dedicated-outbound-ips-to-your-workspace).

Render already provides Cloudflare-backed DDoS mitigation. Official documentation does not publish a numeric web-service per-IP ceiling; Render management REST API rate limits are unrelated. Application-level abuse and expensive requests remain our responsibility. [Render DDoS protection](https://render.com/docs/ddos-protection), [application defenses](https://render.com/articles/how-render-handles-ddos-attacks).

Use Render's existing CDN for static assets. Native API edge caching is now **All files (advanced)**, with the deployed `a4f5430` header policy. The policy opts only exact, query-free public snapshot URLs into `CDN-Cache-Control: public, s-maxage=1, must-revalidate`; browser revalidation, ETags and origin/encoding variation remain. All other responses default to CDN `no-store`, and SSE explicitly uses `no-store` in both cache headers. Requests with Authorization/Cookie, responses with Set-Cookie, denied origins and non-200/304 responses cannot populate the cache through this origin policy. The setting was enabled only after deployed success, readiness and error headers were checked. A bounded live matrix then passed 36 requests: eight HITs, three EXPIRED responses, exact CORS across three allowed origins plus absent/denied Origin, matching identity/gzip content, ETag 304, changed content after expiry, and no-store exclusions including retained wallet history and SSE. Both five-origin sweeps finished within one second. [Raw validation evidence](evidence/2026-10-10-production-edge-cache.json). The current [Blueprint reference](https://render.com/docs/blueprint-spec) and [Render-hosted schema](https://render.com/schema/render.yaml.json) expose no supported cache-profile field; record this UI setting separately and recheck it after Blueprint syncs rather than inventing a YAML key. [Edge caching and header precedence](https://render.com/docs/web-service-caching).

A response-header guard cannot guarantee that credential-bearing requests bypass a previously cached anonymous object: a cache hit never reaches the origin, and Cloudflare permits Authorization caching with directives including `public`, `s-maxage` or `must-revalidate`. These allowlisted snapshots have no personalized response content, and the live test observed both Authorization and Cookie requests receiving that same cached public overview with no Set-Cookie. Guaranteed bypass would require additional verified edge request rules; it is not provided by this configuration. Never add personalized content to these allowlisted URLs without changing the edge policy first. Do not cache account searches, wallet/profile history or older liquidation pages. [Cloudflare authorization behavior](https://developers.cloudflare.com/cache/concepts/cache-control/#conditions). Cloudflare's NAT-aware WAF characteristic uses a visitor cookie and has plan constraints; it would change our current privacy assumptions and needs a separate review. [NAT-aware rate limits](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/#use-cases-of-ip-with-nat-support).

If traffic later becomes sustained, investigate **actual edge fan-out**: a small number of upstream connections feeding shared Cloudflare Durable Object shards, rather than one Render-origin stream per viewer. Workers have no egress surcharge, but request/CPU and Durable Object duration/storage charges remain. Continuous market updates prevent assuming hibernation savings. That architecture requires development, replay/ordering and failure tests; simply proxying every current stream through a Worker would retain the Render egress bill. It is not required for the specified few-hour launch and is not deployed. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Recovery and backup readiness

The existing database's Recovery page visibly offers **Point-in-Time Recovery for the past seven days**, **Restore database**, and **Create export**. A logical export was created and completed at **October 10, 2026, 09:13 PDT (16:13 UTC)**. Its archive is `2026-10-10T16:13Z.dir.tar.gz`; the UI exposes the timestamp/file rather than a separate visible export ID. The completed row and API deployment were saved as verification screenshots. No export was downloaded or shared externally. Actual history cannot precede database creation.

The isolated PITR drill used temporary database `dpg-db56a3h42hec73fsbcu0-a` (`paperdash-restore-drill-20261010`), restored to **16:08:20 UTC**. It inherited the production inbound IP restrictions; the console confirmed external traffic blocked. Its temporary `2c-4g`, 50 GB, non-HA plan cost $90/month prorated by the second (about $0.125/hour). No API or collector was pointed at it.

A raw `pg` client in the existing private worker shell used read-only transactions, five-second query/connection limits and the existing credential without printing it. Only the destination hostname/database name changed for the copy. Immutable counts at the same cutoff exactly matched production: **28,692 trade observations, 21,640 raw history pages and 11,214 portfolio batches**. The restored database had **10,521 wallets, 31,563 jobs, 22,223 normalized history records and 18,476 chart points**. Completed cashflow/portfolio/trade checkpoints were 9,777/9,776/9,776. Latest trade checkpoint success was 16:08:19.741 UTC; the collector heartbeat was 16:08:19.871, 129 ms before the restore target. A known wallet's retained cashflow rows were present. The copy became Available in about two minutes; data validation completed within about four minutes of initiation. These are observed drill timings, not a guaranteed recovery SLA or a production cutover test. The disposable copy was deleted after validation; the workspace returned to its original five production services. The production export was retained. The drill lasted only a few minutes, with estimated prorated compute/storage cost below $0.02 (invoice not yet available).

Paid Postgres on Pro has seven-day PITR. Restore creates a new database; the selected point must be at least ten minutes behind the present. Logical exports are retained for seven days and must be downloaded/copied for longer retention. The completed isolated drill above validates this restore sample, not a production cutover or recovery SLA. Repeat the count/checkpoint/history checks after material schema or data-volume changes, and preserve production throughout. [Recovery documentation](https://render.com/docs/postgresql-backups).

Keep HA enabled, but do not treat it as a backup: asynchronous failover can lose recent writes, and the standby cannot serve read traffic. Add encrypted external logical exports with tested retention and restricted credentials. The $25 allowance requires validation against real compressed database size and restore duration; no external bucket or scheduler is currently configured. Follow the coordinated cutover procedure in [Operations](OPERATIONS.md#freshness-incidents-and-recovery) when a real restore is needed.

## Local test evidence and remaining production gates

The release owner reported a clean **local** 10,000-client run: all clients connected in 1.25 seconds, zero failures, 1,269/1,269 REST requests succeeded, REST p99 17 ms, SSE p99 67 ms, API memory 416 MiB and about 30% of one local CPU core. These results validate that local test workload only. They exclude Render ingress, regional latency, public NAT/rate behavior, production database distribution, long-duration traffic and real-world failure modes. The synthetic mixed-view run and its workload limits are retained in [the local evidence report](evidence/2026-10-10-local-capacity-10000-mixed.json). It measured about 803 response-body bytes/viewer/second; the earlier production all-topic sample is a different workload, so neither should be substituted for a measured production mixed-view plateau.

### Evidence required before announcing capacity

1. Build and run integration/browser tests on the exact release; preserve source-backed stale/coverage behavior under failures.
2. Use a separate load environment with representative retained histories and continuing ingestion. Test 500, 2,000, 5,000 and 10,000 clients, a realistic overview/asset/wallet mix, paginated reads and cache misses. Retain test commands, commit, event rates, dataset sizes and timings.
3. After local/staging success, pre-scale the approved production topology and perform a controlled, bounded distributed validation through the real Render URL. Include many users behind a shared IP, synchronized reconnects, one API instance draining, and deliberately slow clients. Do not mistake rate-limiter rejection for a server capacity result.
4. Proposed acceptance targets: normal read p95 below 500 ms and p99 below 1 s from the chosen test regions; source-to-browser p95 below 2 s; unintended errors below 0.1%; no missing replay within the supported window, unbounded memory growth or increasing collector lag. Keep CPU under roughly 70%, memory below 75%, and database pool waits bounded during the steady plateau. Targets must be reported as goals until measured.
5. Measure per-instance sockets, event-loop delay, queue/pool waits, reconnects, HTTP errors and total bytes/viewer-second. A brief synthetic test cannot establish several-hour stability; run a soak and a one-instance-loss drill. Measure incoming event bursts as well as idle clients.
6. Wire alert delivery for readiness/source lag, queue failures, disk 70%/85%, and projected monthly cost at $700/$850, escalating at $950. These are proposed alerts, not currently installed automation. Reduce payload/cadence gracefully before spending exceeds the ceiling; retain records and display stale state honestly.

Both Blueprint files now describe the authorized three-instance API plan. Service and Blueprint auto-deploy remain disabled, so code rollout still requires the separately tested release. Retain the old compatible release for rollback. Plan inspection, scaling and a successful feature release are not production launch load tests.
