import { useEffect, useId, useMemo, useState } from "react";
import type { WalletResponse } from "../../../../packages/shared/src/types";
import type { MarginRiskTotals } from "../../../../packages/shared/src/margin-risk";
import {
  normalizeOpenPosition,
  type PositionDetails,
} from "../../../../packages/shared/src/position-details";
import { formatChartTime, validChartTime } from "../lib/chart-data";
import { formatRawUsd, formatUsd } from "../lib/format";
import { exactScaledValue } from "../lib/position-receipt";
import {
  riskBandLabels,
  riskBarMaximum,
  riskBarWidths,
  riskMatchesSnapshot,
  riskMoney,
  riskDistanceText,
  type MarginRiskExportSnapshot,
} from "../lib/margin-risk-display";
import { useImageActions } from "../lib/use-image-actions";
import "./wallet-margin-risk.css";

function MarginBar({
  totals,
  maximum,
  pattern,
  side,
}: {
  totals: MarginRiskTotals;
  maximum: bigint;
  pattern: string;
  side: "long" | "short";
}) {
  const widths = riskBarWidths(totals, maximum);
  return (
    <div
      className="wmr-band-value"
      title={`Cash ${formatRawUsd(totals.cashMarginRaw)} · Queued balance ${formatRawUsd(totals.queuedMarginRaw)} · ${totals.positionCount} positions`}
    >
      <svg
        viewBox="0 0 100 12"
        preserveAspectRatio="none"
        aria-hidden="true"
        className={side === "long" ? "wmr-bar--long" : ""}
      >
        <rect width="100" height="12" className="wmr-bar-track" />
        <rect width={widths.cash} height="12" className="wmr-bar-cash" />
        <rect
          x={widths.cash}
          width={widths.queued}
          height="12"
          fill={`url(#${pattern})`}
        />
      </svg>
      <span>{riskMoney(totals.initialMarginRaw)}</span>
    </div>
  );
}

export function WalletMarginRisk({
  wallet,
  displayName,
  onPosition,
  refreshError = false,
}: {
  wallet: WalletResponse;
  displayName?: string | null;
  onPosition: (position: PositionDetails, stale?: boolean) => void;
  refreshError?: boolean;
}) {
  const [selectedInstrument, setInstrument] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const pattern = `risk-${useId().replace(/:/g, "")}`;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const risk = riskMatchesSnapshot(
    wallet.marginRisk,
    wallet.snapshot,
    wallet.address,
  )
    ? wallet.marginRisk
    : undefined;
  const instrument = selectedInstrument ?? risk?.assets[0]?.instrumentId ?? 0;
  const asset = risk?.assets.find((item) => item.instrumentId === instrument);
  const snapshotAt = risk?.snapshot?.sourceAt;
  const quote = asset?.reference;
  const aged = (at: number | null | undefined) =>
    !validChartTime(at) || at > now + 30000 || now - at > 30000;
  const stale = Boolean(
    refreshError ||
      risk?.stale ||
      risk?.snapshot?.stale ||
      aged(snapshotAt) ||
      aged(risk?.snapshot?.receivedAt) ||
      (quote &&
        (quote.stale || aged(quote.sourceAt) || aged(quote.receivedAt))),
  );
  const maximum = asset ? riskBarMaximum(asset) : 0n;
  const positions = useMemo(() => {
    const byId = new Map<string, unknown>();
    for (const tuple of wallet.snapshot?.openPositions ?? [])
      if (Array.isArray(tuple) && typeof tuple[0] === "string")
        byId.set(tuple[0], tuple);
    return new Map(
      (asset?.nearest ?? []).map((position) => [
        position.positionId,
        validChartTime(snapshotAt)
          ? normalizeOpenPosition(byId.get(position.positionId), {
              walletAddress: wallet.address,
              receivedAt: risk?.snapshot?.receivedAt ?? null,
              asOf: snapshotAt,
            })
          : null,
      ]),
    );
  }, [
    asset?.nearest,
    wallet.snapshot,
    wallet.address,
    snapshotAt,
    risk?.snapshot?.receivedAt,
  ]);
  const walletLink = () => {
    const url = new URL(window.location.origin);
    url.searchParams.set("wallet", wallet.address);
    return url.href;
  };
  const actions = useImageActions({
    getLink: walletLink,
    linkLabel: "wallet",
    imageLabel: "Margin view",
    capture: () => {
      if (!asset?.bands || !validChartTime(snapshotAt) || !risk)
        throw new Error("Margin bands are unavailable.");
      const frozen: MarginRiskExportSnapshot = structuredClone({
        asset,
        address: wallet.address,
        name: displayName ?? null,
        snapshotAt,
        stale,
        includedCount: risk.coverage.includedCount,
        excludedCount: risk.coverage.excludedCount,
      });
      return {
        filename: `paperclub-${asset.symbol.toLowerCase()}-margin.png`,
        title: `${asset.symbol} margin · paperclub`,
        text: "Initial margin by recorded bust distance · hypothetical reference comparison",
        url: walletLink(),
        render: async () =>
          (await import("../lib/margin-risk-export")).renderMarginRiskPng(
            frozen,
          ),
      };
    },
  });
  return (
    <section className="wmr-panel" aria-label="Wallet margin at risk">
      <div className="wmr-heading">
        <h3>Margin at risk</h3>
        <div className="wmr-tabs" aria-label="Margin asset">
          {["BTC", "ETH"].map((symbol, id) => (
            <button
              key={symbol}
              type="button"
              aria-pressed={instrument === id}
              onClick={() => {
                setInstrument(id);
                actions.reset();
              }}
            >
              {symbol}
            </button>
          ))}
        </div>
      </div>
      <p className="wmr-note">
        Initial margin by recorded bust distance · not predicted loss.
      </p>
      {!risk ? (
        <p className="wmr-empty">Margin view unavailable for this snapshot.</p>
      ) : (
        <>
          <p className={`wmr-clock ${stale ? "position-delayed" : ""}`}>
            {stale ? "Last available" : "At snapshot"} ·{" "}
            {formatChartTime(snapshotAt)}
          </p>
          {!asset ? (
            <p className="wmr-empty">
              {risk.coverage.excludedCount > 0
                ? `No usable ${instrument === 0 ? "BTC" : "ETH"} positions in this snapshot.`
                : `No ${instrument === 0 ? "BTC" : "ETH"} open positions in this snapshot. Initial margin $0.`}
            </p>
          ) : (
            <>
              <dl className="wmr-totals">
                {[
                  ["Initial margin", asset.totals.initialMarginRaw],
                  ["Cash", asset.totals.cashMarginRaw],
                  ["Queued balance", asset.totals.queuedMarginRaw],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd title={`${formatRawUsd(value)} USDC`}>
                      {riskMoney(value)}
                    </dd>
                  </div>
                ))}
              </dl>
              {quote ? (
                <p className="wmr-reference">
                  Hyperliquid midpoint{" "}
                  <strong>{formatUsd(quote.priceUsd)}</strong> · approximate
                  reference
                  <br />
                  <time dateTime={new Date(quote.sourceAt).toISOString()}>
                    {formatChartTime(quote.sourceAt)}
                  </time>
                  {quote.stale || aged(quote.sourceAt)
                    ? " · Last available reference"
                    : ""}
                </p>
              ) : (
                <p className="wmr-empty">
                  Price reference unavailable. Margin totals remain available;
                  distance bands are unknown.
                </p>
              )}
              {asset.bands && (
                <>
                  <svg
                    width="0"
                    height="0"
                    className="wmr-defs"
                    aria-hidden="true"
                  >
                    <defs>
                      <pattern
                        id={pattern}
                        patternUnits="userSpaceOnUse"
                        width="4"
                        height="4"
                      >
                        <rect width="4" height="4" fill="#d8cde4" />
                        <path
                          d="M-1 1 1-1M0 4 4 0M3 5 5 3"
                          stroke="#9078ad"
                          strokeWidth="0.8"
                        />
                      </pattern>
                    </defs>
                  </svg>
                  <div className="wmr-band-head" aria-hidden="true">
                    <span>
                      Longs ↓<small>lower price</small>
                    </span>
                    <span>Distance</span>
                    <span>
                      Shorts ↑<small>higher price</small>
                    </span>
                  </div>
                  <div
                    className="wmr-bands"
                    role="list"
                    aria-label="Nonoverlapping initial margin bands"
                  >
                    {asset.bands.map((band) => (
                      <div
                        className="wmr-band"
                        key={band.key}
                        role="listitem"
                        tabIndex={0}
                        aria-label={`${riskBandLabels[band.key]}: long ${formatRawUsd(band.long.initialMarginRaw)}, cash ${formatRawUsd(band.long.cashMarginRaw)}, queued balance ${formatRawUsd(band.long.queuedMarginRaw)}; short ${formatRawUsd(band.short.initialMarginRaw)}, cash ${formatRawUsd(band.short.cashMarginRaw)}, queued balance ${formatRawUsd(band.short.queuedMarginRaw)}`}
                      >
                        <MarginBar
                          totals={band.long}
                          maximum={maximum}
                          pattern={pattern}
                          side="long"
                        />
                        <span className="wmr-band-label">
                          {riskBandLabels[band.key]}
                        </span>
                        <MarginBar
                          totals={band.short}
                          maximum={maximum}
                          pattern={pattern}
                          side="short"
                        />
                      </div>
                    ))}
                  </div>
                  <p className="wmr-legend">
                    <span>
                      <i />
                      Cash
                    </span>
                    <span>
                      <i className="wmr-queued" />
                      Queued balance
                    </span>
                    <span>USDC · each position counted once</span>
                  </p>
                  <p className="wmr-note">
                    At / beyond means at or beyond the recorded bust threshold
                    at this reference. It does not establish current liquidation
                    eligibility.
                  </p>
                </>
              )}
              {!!asset.nearest.length && (
                <div className="wmr-nearest">
                  <h4>Nearest recorded thresholds</h4>
                  {asset.nearest.map((position) => {
                    const details = positions.get(position.positionId);
                    return (
                      <button
                        type="button"
                        key={position.positionId}
                        disabled={!details}
                        onClick={() => {
                          if (details) onPosition(details, stale);
                        }}
                        aria-label={`View ${asset.symbol} ${position.side} position ${position.positionId} from margin view`}
                      >
                        <span>
                          {position.side === "long" ? "Long" : "Short"}{" "}
                          <small>
                            {position.funding === "cash"
                              ? "Cash"
                              : "Queued balance"}
                          </small>
                        </span>
                        <span
                          title={`Recorded bust price: ${exactScaledValue(position.bustPriceRaw, position.priceScaleRaw)} USD`}
                        >
                          $
                          {exactScaledValue(
                            position.bustPriceRaw,
                            position.priceScaleRaw,
                          )}
                        </span>
                        <span>{riskDistanceText(position)} ↗</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {asset.bands && (
                <div className="wmr-actions">
                  <button
                    type="button"
                    disabled={actions.busy}
                    onClick={() => void actions.download()}
                  >
                    Download PNG
                  </button>
                  <button
                    type="button"
                    disabled={actions.busy}
                    onClick={() => void actions.share()}
                  >
                    {actions.readyFile ? "Share image" : "Share"}
                  </button>
                  <button type="button" onClick={() => void actions.copyLink()}>
                    Copy wallet link
                  </button>
                </div>
              )}
            </>
          )}
          <p className="wmr-note">
            Wallet: {risk.coverage.includedCount.toLocaleString()} included ·{" "}
            {risk.coverage.excludedCount.toLocaleString()} excluded
            {risk.coverage.duplicateCount > 0
              ? ` (${risk.coverage.duplicateCount} duplicate rows)`
              : ""}{" "}
            · wallet snapshot only. Snapshot and reference have separate
            timestamps.
          </p>
          {risk.error && (
            <p className="wmr-note position-delayed">{risk.error}</p>
          )}
        </>
      )}
      {actions.message && (
        <p className="wmr-note" role="status">
          {actions.message}
        </p>
      )}
      {actions.manualLink && (
        <input
          className="wmr-link"
          readOnly
          aria-label="Wallet link"
          value={actions.manualLink}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
    </section>
  );
}
