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
  const market = useAssetMarket(instrument);
  return (
    <>
      <AnalyticsNotice error={market.error} hasData={Boolean(market.data)} />
      <AssetTradeGraph
        instrument={instrument}
        symbol={instrument === 1 ? "ETH" : "BTC"}
        points={market.points}
        trades={market.trades}
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
