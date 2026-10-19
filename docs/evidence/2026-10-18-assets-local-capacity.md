# Assets viewer capacity — local verification, October 18, 2026

The isolated run passed with **250 concurrent viewers joining over 20 seconds**, followed by sustained selected-asset streaming and 50 planned reconnects. All 300 SSE bootstraps completed. No HTTP, transport, ordering, selection, snapshot-age or bounded-work failures occurred. This is local evidence for saved-view serving and stream fanout, not a production capacity certification.

| Measurement | Result |
| --- | ---: |
| Test duration | 45 seconds |
| Final concurrent viewers | 250 / 250 |
| Planned reconnects | 50 / 50 |
| SSE bootstrap latency p95 / p99 | 3.1 / 7.1 ms |
| Live publication-to-client latency p95 / p99 / max | 6 / 9 / 13 ms |
| REST latency p95 / p99 | 11.0 / 14.1 ms |
| REST responses | 1,978 HTTP 200; 10 HTTP 304 |
| REST request rate over ramp and plateau | 44.2 requests/second |
| Stream messages delivered | 55,078 |
| Oldest returned market snapshot | 6.1 seconds |
| Oldest final price at any viewer | 743 ms |
| API peak RSS | 310.6 MiB |
| API CPU | 12.3% of one core |
| API event-loop p99 / max | 13.4 / 17.6 ms |
| Response bodies received | 39.3 MiB |
| External requests / publication failures | 0 / 0 |

The generator, publisher and real API ran in separate processes on one machine. API and publisher shared a disposable SQLite WAL database. The normal API routing, gzip, ETags, one-second public read cache, shared EventHub, admission limits and shared-IP rate limits remained enabled. No CDN was involved. IPC notifications substituted for Redis notifications; the actual EventHub tail, topic filtering and snapshot replay were used.

The workload started with 720 prices per asset, 1,200 mixed entry/close/liquidation observations, 100 classified wallets and 300-point asset histories. `refreshMarkets` published the real bounded activity/profit/window variants every five seconds. During the run the publisher added 433 trades (9.6/second) and 88 BTC/ETH quotes (2.0/second combined). Half the viewers used profitable snapshots, refreshing about every five seconds; the remainder used all-trader snapshots, refreshing about every fifteen seconds. Asset summaries refreshed about every fifteen seconds. Different viewers selected BTC/ETH, all three windows, all three activity modes and the $1K/$10K/$100K floors. Their independently timed requests exercised 72 market URLs and `/api/assets`.

All market responses remained bounded to 200 feed observations and 62 sampled markers. Quote clocks advanced for every viewer, including the reconnect cohort. Snapshot source/receipt clocks were checked independently from successful HTTP delivery. The API made 1,120 saved-market reads for 1,305 market HTTP requests; cache reuse depends on overlapping selections and join timing. The stream used 542 shared tail reads for all viewers. The `bootstraps` counter in raw output counts every `overview` store read, including activity-health checks; it is not a count of separate SSE initialization queries.

The configured deployment has three API instances and a 6,000-stream admission limit per process. These are configuration bounds, not measured production throughput. The run does not establish PostgreSQL query capacity, Redis outage behavior, Render restart/failover, geographically distributed latency, source completeness or long-duration memory stability. Backend PostgreSQL stress tests and browser responsiveness measurements are separate checks. No deployment sizing change is justified by this test alone.

An earlier run was retained as incomplete evidence: it ran the synchronous SQLite publisher inside the API process while the full test suite was also active. All streams and reconnects survived, but API pauses reached 3.5 seconds and the generator hit its 128-request pending bound. Its REST latency is not an isolated production-topology measurement. The passing rerun separated API/publisher responsibilities and used a coordinated quiet window; this is not a controlled before/after measurement of an application performance change.

Reproduce with:

```sh
node --import tsx scripts/load/local-assets-capacity.ts \
  --clients=250 --seconds=45 --ramp-seconds=20 \
  --output=/tmp/assets-250-local.json
```

- [Passing raw evidence](2026-10-18-assets-250-local.json)
- [Earlier confounded run, including its failures](2026-10-18-assets-250-local-confounded.json)
- [Harness and limits](../../scripts/load/README.md#staggered-assets-viewers)
