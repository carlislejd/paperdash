import { useState } from "react";
import type { LiquidationsResponse } from "../../../../packages/shared/src/types";
import { ChartCard } from "./ChartCard";
import { HOUR_MS, type ChartColor } from "../lib/chart-data";

export function LiquidationChart({
  data,
  instrument,
  stale,
  loading,
}: {
  data: LiquidationsResponse | null;
  instrument: string;
  stale: boolean;
  loading: boolean;
}) {
  const [metric, setMetric] = useState<"notionalUsd" | "count">(() =>
    new URLSearchParams(window.location.search).get("chart") ===
    "liquidations-count"
      ? "count"
      : "notionalUsd",
  );
  const hourly = data?.receivedAt ? data.hourly : undefined;
  const assets = [
    ...new Set(
      hourly?.buckets.flatMap((bucket) =>
        bucket.assets.map((asset) => asset.instrument),
      ) ?? [],
    ),
  ].sort((a, b) => a - b);
  const points =
    hourly?.buckets.map((bucket) => ({
      time: bucket.time,
      value: bucket.assets.reduce((sum, asset) => sum + asset[metric], 0),
      partial: bucket.partial,
    })) ?? [];
  const segments = assets.map((asset, index) => ({
    id: String(asset),
    label: asset === 0 ? "BTC" : asset === 1 ? "ETH" : `Asset ${asset}`,
    color: (asset === 0 || (asset !== 1 && index % 2 === 0)
      ? "lavender"
      : "green") as ChartColor,
    points: hourly!.buckets.map((bucket) => ({
      time: bucket.time,
      value:
        bucket.assets.find((entry) => entry.instrument === asset)?.[metric] ??
        0,
      partial: bucket.partial,
    })),
  }));
  const id =
    metric === "count" ? "liquidations-count" : "liquidations-notional";
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("view", "liquidations");
  url.searchParams.set("chart", id);
  if (instrument === "0" || instrument === "1")
    url.searchParams.set("instrument", instrument);
  const to = hourly?.to ?? data?.windowTo ?? Date.now();
  const from = hourly?.from ?? to - 24 * HOUR_MS;
  return (
    <section
      className="liquidation-chart"
      aria-label="Hourly liquidations by asset"
    >
      <div className="liquidation-chart-controls">
        <span>By asset · rolling 24h</span>
        <div className="range-control" aria-label="Liquidation chart metric">
          <button
            type="button"
            aria-pressed={metric === "notionalUsd"}
            onClick={() => setMetric("notionalUsd")}
          >
            Notional
          </button>
          <button
            type="button"
            aria-pressed={metric === "count"}
            onClick={() => setMetric("count")}
          >
            Count
          </button>
        </div>
      </div>
      <ChartCard
        key={`${id}:${instrument}`}
        id={id}
        title={
          metric === "count"
            ? "Liquidations / hour"
            : "Liquidated notional / hour"
        }
        unit={metric === "count" ? "liquidations" : "USDC"}
        kind="bar"
        aggregate="sum"
        totalLabel="Recorded total"
        points={points}
        segments={segments}
        range={{
          from: Math.floor(from / HOUR_MS) * HOUR_MS,
          to: Math.floor(to / HOUR_MS) * HOUR_MS + HOUR_MS,
          label: "Rolling 24h · UTC hour buckets",
        }}
        sourceAt={hourly ? (data?.receivedAt ?? null) : null}
        coverage={
          hourly
            ? `Observed liquidations · coverage may be incomplete${metric === "notionalUsd" ? "; notional is position size, not lost collateral" : ""}`
            : "Hourly history is not yet available"
        }
        stale={stale || !hourly}
        loading={loading && !hourly}
        shareUrl={url.toString()}
      />
    </section>
  );
}
