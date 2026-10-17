import { useState } from "react";
import type {
  MarketSegment,
  MarketWindow,
} from "../../../../packages/shared/src/types";
import { useAssetMarket } from "../lib/use-asset-market";
import { AssetTradeGraph } from "./AssetTradeGraph";
import { AnalyticsNotice } from "./AnalyticsShared";

export function AssetLivePanel({
  instrument,
  connected,
  onWallet,
}: {
  instrument: number;
  connected: boolean;
  onWallet: (address: string) => void;
}) {
  const [window, setWindow] = useState<MarketWindow>("15m");
  const [segment, setSegment] = useState<MarketSegment>("all");
  const [minPnlUsd, setMinPnlUsd] = useState(1_000);
  const market = useAssetMarket(instrument, window, segment, minPnlUsd);
  return (
    <>
      <AnalyticsNotice error={market.error} hasData={Boolean(market.data)} />
      <AssetTradeGraph
        instrument={instrument}
        symbol={instrument === 1 ? "ETH" : "BTC"}
        points={market.points}
        trades={market.trades}
        chartSample={market.chartSample}
        window={window}
        onWindowChange={setWindow}
        segment={segment}
        onSegmentChange={setSegment}
        minPnlUsd={minPnlUsd}
        onMinPnlChange={setMinPnlUsd}
        segmentCoverage={market.segmentCoverage}
        segmentUnavailable={market.segmentUnavailable}
        price={market.price}
        receivedAt={market.data?.receivedAt ?? null}
        stale={market.stale}
        connected={connected}
        tradesCapped={market.data?.coverage.tradesCapped ?? false}
        onWallet={onWallet}
      />
      {market.error && (
        <button
          type="button"
          className="text-button"
          disabled={market.loading}
          onClick={market.refresh}
        >
          Retry live chart
        </button>
      )}
    </>
  );
}
