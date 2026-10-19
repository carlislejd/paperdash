# Local HTTP and stream capacity harness

Run from the repository root:

```sh
node --import tsx scripts/load/local-rest-capacity.ts \
  --clients=10000 --seconds=20 --rest-rps=2500 > /tmp/paperdash-load.json
```

This starts a private API process on an ephemeral `127.0.0.1` port. There is no remote-target option. It uses in-memory SQLite, a synthetic materialized position rollup, and populated snapshot caches; the collector is disabled and provider `fetch` calls fail. It neither reads nor writes production. Viewer IP headers are synthetic and sent only over loopback to exercise independent local admissions. Do not reuse that technique against production.

The workload keeps the requested number of SSE connections open while offering REST traffic across house, global position metrics, liquidation stats/feed, assets, BTC/ETH market charts, overview, and the first account page. The fixtures include 300-point histories, 720-point price charts, 200 execution bubbles, 50 feed rows, realistic high-entropy wallet/event IDs, and large monetary values. Snapshots change every five seconds. Viewers rotate three panels, and conditional requests use real per-viewer/route ETags seeded by a warmup representing already-loaded views. The API's actual gzip, ETag, routing, shared-read cache, stream filtering, and rate limiter remain active. The local API's stream admission ceiling is explicitly raised to 12,000 for this single-process test.

Limits are 10,000 clients, 5,000 REST requests/second, 60 seconds, and 512 in-flight requests; the default in-flight cap is 256. The scheduler records offered, completed, and dropped work instead of building an unbounded queue. Requests have four-second deadlines. Memory, sustained event-loop delay, HTTP errors, dropped work, stream-order failures, and an overall deadline can abort the run. Any request/stream failure yields a nonzero exit. JSON output includes per-route status, gzip/304 counts, actual HTTP body/header bytes, bootstrap and steady latency, API and generator CPU/RSS/event-loop statistics, source hashes, and stream failure reasons.

HTTP byte counts exclude TCP/TLS overhead; SSE bytes count response bodies. SSE latency samples the first 64 connected viewers. Cache hits do not test expensive cold wallet loads or full database aggregates. CPU percentages are relative to one CPU core; generator and API share the same machine. These are short, local cache/socket results, **not Render, PostgreSQL, Redis, CDN, TLS, geographic, cold-wallet, or multi-hour capacity guarantees**.

Run increasing stages only while the host is otherwise quiet. Repeated 10,000-connection runs can exhaust the generator's ephemeral ports while old sockets remain in `TIME_WAIT`; allow them to expire between runs and retain any failed setup result. Do not change OS limits to hide setup failures. A setup abort before REST begins is not a REST capacity measurement. Preserve the exact fixture/source hashes when comparing results.

## Bounded production checks

`production-smoke.mjs` and `edge-cache-validation.mjs` default to an offline plan with **zero network requests**. Both use only the fixed Paperdash API origin. Neither accepts arbitrary targets, sends source-provider requests, spoofs forwarding headers, or retries failed load. They require `--execute-approved` for an authorized, monitored release check.

The stream smoke ramps at at most 20 new connections/second and stops on stream ordering errors, unhealthy/stale data, throttles, transport failures, generator suspension, a 2 GiB generator RSS cap, deadlines or its body-byte budget. Its shared REST probes are deliberately low volume; this is a connection/transport test, not a representative thousands-of-reads-per-second workload. The `mixed` profile subscribes 40% to global trades, 15% to each asset, 10% to liquidations and 20% to overview only, with overview metrics included in every stream. It does not issue independent wallet-profile requests for that final cohort. Request and plateau limits are printed before execution. Choose the traffic cap from measured body rates, the integral of the connection ramp and plateau duration; preserve a byte-budget abort as incomplete evidence, not a server-capacity failure.

The edge validator checks allowed/absent/denied origins, content encodings, ETags, expiry and no-store exclusions. Optional wallet checks use retained history and metrics only. It is bounded to 65 requests, 60 seconds and 16 MiB, and includes one three-second SSE connection. A public cached object may be served to an Authorization/Cookie request without reaching origin; the report records that behavior and never equates an origin response-header guard with guaranteed edge bypass.

```sh
# Offline plans; inspect these before an authorized production run.
node scripts/load/production-smoke.mjs --profile=mixed --max-mib=512
node scripts/load/edge-cache-validation.mjs
```

Keep infrastructure stable during a run, observe all API replicas and database activity, and retain exact release IDs plus JSON evidence. Public validation is not an instruction to run traffic continuously.

## Staggered Assets viewers

```sh
node --import tsx scripts/load/local-assets-capacity.ts \
  --clients=250 --seconds=45 --ramp-seconds=20 \
  --output=/tmp/assets-250-local.json
```

This localhost-only harness starts separate generator, synthetic publisher, and real API processes. The publisher and API share a disposable SQLite WAL database; IPC notifications trigger the API's normal shared EventHub. The source collector and all external requests are disabled. Normal API read-cache, gzip, ETag, stream admission and shared-IP rate limits remain enabled, without a CDN.

The publisher seeds 720 prices per asset, 1,200 mixed entry/close/liquidation observations, 100 classified wallets, and 300-point asset histories. It saves actual market variants through `refreshMarkets` every five seconds while publishing ten trades/second and BTC/ETH quotes each second. Viewers join over the ramp, independently select assets, windows, activities and profit floors, poll profitable snapshots every five seconds or all-trader snapshots every fifteen seconds, and read asset summaries every fifteen seconds. A fifth of viewers (up to fifty) reconnect during the final ten seconds. Bootstrap latency measures the first SSE overview; live-event latency excludes pre-join replay.

The report checks stream ordering, asset identity, snapshot age, response/sample bounds, HTTP status, final advancing price clocks, and all planned reconnects. It records API and publisher CPU, RSS and event-loop delay separately, plus shared store reads, traffic and REST latency. At most 128 REST requests are in flight; reaching that bound is a reported failure, not a hidden queue. Limits are 500 viewers, ninety seconds, and a ramp no longer than half the run. Temporary storage is removed afterward. Run in a quiet window: other local tests materially distort latency.

This tests socket fanout and current saved-view serving on one machine. PostgreSQL, Redis, provider ingest, Render instance failover, regional latency, browser rendering and long-duration memory stability need their separate checks. A passing local run is not a production capacity certification.

## Assets browser responsiveness

```sh
npx playwright test --config=scripts/load/asset-exits-browser.config.ts
```

This builds the production frontend into ignored `.private/asset-exits-browser-build`, then serves it on localhost port 4188. All API responses and SSE messages are mocked. Each of two sequential runs delivers 100 mixed BTC/ETH trades per second plus ten price updates per asset per second for twenty seconds, switching activities and assets eight times. The initial snapshots contain 720 price points, up to 200 recent trades, and bounded chart samples.

The first run uses desktop Chromium. The second uses Pixel 7 viewport/device emulation with an explicit fourfold CPU slowdown; it does not run on physical mobile hardware. Real animation remains enabled. JSON metrics and CPU profiles are written under `.private/asset-exit-browser-load`. The harness records actual delivery rate, long tasks, animation-frame gaps, quote-to-DOM latency, automation-observed click-to-next-frame latency, displayed row/marker bounds, active SSE connections, and JavaScript heap before and after explicit garbage collection.

Collect comparison runs only while the host is otherwise idle; simultaneous backend load or browser suites can materially change CPU measurements. Save the result files before rerunning a baseline. These are single-viewer rendering measurements with profiling overhead and a short, synthetic workload. They do not measure network latency, real-device performance, concurrent-viewer server capacity, or long-duration memory leaks. Use the separate staggered-viewer harness for API/stream fanout.
