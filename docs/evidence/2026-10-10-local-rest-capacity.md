# Local shared-cache REST capacity evidence — October 10, 2026

These short runs kept **10,000 SSE clients** connected while offering increasing REST traffic to the real local API routes. The clean measured lower bound was **1,000 REST requests/second for 20 seconds on the earlier, more compressible fixture**. The final, higher-entropy fixture completed about 4,901 requests/second, but dropped 1.96% of offered requests in the generator. **That is not a clean 5,000-RPS pass or evidence of production capacity.**

## Results

All measured stages lasted approximately 20 seconds. CPU is a percentage of one core. Each successful connection stage had 10,000 streams and zero stream failures, duplicate/regressing IDs, started-request transport errors, or HTTP responses outside 200/304.

| Offered RPS | In-flight cap | Offered / completed | Generator drops | Completed RPS | REST p99 | SSE p99 | API peak RSS / CPU | Evidence                                      |
| ----------: | ------------: | ------------------: | --------------: | ------------: | -------: | ------: | -----------------: | --------------------------------------------- |
|         500 |           256 |       9,997 / 9,997 |               0 |         499.8 |   9.4 ms |   65 ms |      420 MiB / 29% | [JSON](2026-10-10-local-rest-500.json)        |
|       1,000 |           256 |     19,997 / 19,997 |               0 |         999.7 |  12.2 ms |   67 ms |      432 MiB / 35% | [JSON](2026-10-10-local-rest-1000-retry.json) |
|       2,500 |           256 |     49,996 / 49,862 |    134 (0.268%) |       2,492.6 |   9.7 ms |   84 ms |      518 MiB / 40% | [JSON](2026-10-10-local-rest-2500.json)       |
|       2,500 |           512 |     49,989 / 49,952 |     37 (0.074%) |       2,497.3 |  34.6 ms |  100 ms |      498 MiB / 40% | [JSON](2026-10-10-local-rest-2500-512.json)   |
|       5,000 |           512 |     99,985 / 98,024 |  1,961 (1.961%) |       4,900.5 |  18.7 ms |  165 ms |      567 MiB / 51% | [JSON](2026-10-10-local-rest-5000.json)       |

At 5,000 offered RPS, 1,307 drops came from the bounded catch-up scheduler and 654 from the in-flight cap. The generator's maximum observed event-loop delay was 462 ms, versus the API's 231 ms; both processes shared the laptop. At 2,500 RPS all drops came from the in-flight cap. These results establish neither API saturation nor a clean high-rate admission pass. Latencies describe requests that started, and do not include dropped work.

The final stage delivered 814.6 MB of REST response bodies, 51.3 MB of REST response headers, and 247.4 MB of steady SSE bodies in roughly 20 seconds. It recorded 58,481 gzip responses and 20,046 HTTP 304 responses. These are synthetic workload byte counts, excluding TCP/TLS overhead, and must not be treated as a production traffic estimate. Shared API reads stayed bounded: 520 snapshot reads, 20 fixture aggregate reads, and 20 account-source loads over each measured 20-second stage, rather than one database/source query per viewer request.

## Setup failure retained

The first 1,000-RPS attempt stopped during stream connection setup: 8,209 clients connected, 101 stream failures, and **zero REST requests offered**. Its [unaltered result](2026-10-10-local-rest-1000.json) remains separate. This version did not capture failure codes, so the precise cause is unknown. A read-only OS check found a 16,384-port ephemeral range; transient port pressure from the immediately preceding 10,000-connection run was plausible. No OS limits were changed. Later runs waited for prior sockets to expire and recorded detailed stream failure reasons. The successful retry does not erase the failed setup.

## Workload and changes between stages

The harness is [local-rest-capacity.ts](../../scripts/load/local-rest-capacity.ts), with [synthetic cache fixtures](../../scripts/load/cache-fixtures.ts) and a [usage/limits guide](../../scripts/load/README.md). It only starts a private loopback server. The collector is disabled; external provider fetches fail. Storage is in-memory SQLite, including an explicitly synthetic materialized position rollup. Synthetic viewer IPs apply only to this loopback test; production rate limits and identity were not bypassed.

Routes are house, global position metrics, liquidation stats/feed, assets, BTC/ETH market charts, overview, and an account page. Payloads contain 300-point histories, 720-point price lines, 200 execution bubbles, and 50 feed rows. Snapshots change every five seconds. Real warmup ETags seed already-loaded viewers; subsequent ETags are kept per viewer/route. From the successful 1,000-RPS retry onward, each viewer rotates through three panel routes, so the 5,000-RPS workload revisits a given panel approximately every six seconds. The initial 500-RPS run and failed setup used fixed viewer routes.

The 500/1,000-RPS fixtures used sequential, mostly-zero wallet addresses and short event IDs. Before 2,500 RPS these were replaced by deterministic SHA-256-derived addresses and event IDs, increasing realistic payload entropy and compressed size. Consequently the early clean 1,000-RPS result is a lower bound **for that earlier workload**, not an unmeasured guarantee for the final fixture. The 2,500/5,000 stages use the same higher-entropy fixture. The final harness also returns a nonzero exit for any dropped work; the first 2,500-RPS result predates that exit-code correction, so use its counters rather than its shell exit code to judge success.

The application checkout ended at `a4f5430`; the runs occurred while the already-tested stream ordering and explicit edge-cache-header work was being finalized. The early stages did not capture an application source hash. No Render ingress, PostgreSQL/Redis load, CDN cache, TLS, multi-region latency, cold wallet/history cache miss, continuing provider ingestion, failure drill, or multi-hour stability was measured. A separate generator or distributed staging test is needed to separate generator pressure from API admission capacity before claiming the launch target.

## Exact harness versions

The successful 1,000-RPS retry and all higher stages embed SHA-256 `sourceHashes` in their JSON. Exact pre-format source text is retained in [local-rest-sources](local-rest-sources/); each filename is its SHA-256 digest. The final checked-in files have only been formatted after the runs. The 500-RPS and failed 1,000-RPS versions did not capture hashes; no retrospective hash is invented for them.

| Stage                | Harness SHA-256                                                    | Fixture SHA-256                                                    |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 1,000 retry          | `b77eb4ff66e910ada45101693b60f056535b36e849acacc1cc9fd8388194d7cc` | `2fa781d208de4db44ce9cf1825a306382c83dbacd0ea604320d6155c3160830c` |
| 2,500 cap 256        | `b77eb4ff66e910ada45101693b60f056535b36e849acacc1cc9fd8388194d7cc` | `d2e270c040e71b16586d0bc2ae6db6eec944c0e6d3861cf472f6684355fbef35` |
| 2,500 cap 512; 5,000 | `e3debb69d606a75285d5b7924ea45681942ba52f5511fae888be238c2bb1554a` | `d2e270c040e71b16586d0bc2ae6db6eec944c0e6d3861cf472f6684355fbef35` |

Commands used `node --import tsx scripts/load/local-rest-capacity.ts --clients=10000 --seconds=20 --rest-rps=RATE`, with `--max-inflight=512` for the two final stages. The harness enforces request and overall deadlines, bounded buffers/concurrency, and pressure aborts. No further local high-load stages were run after the final 5,000-RPS result.
