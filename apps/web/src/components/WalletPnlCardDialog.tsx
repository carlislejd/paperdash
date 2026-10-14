import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  PNL_CARD_LAYOUTS,
  PNL_CARD_PNL_LABEL,
  PNL_CARD_PNL_NOTE,
  walletPnlCardModel,
  type PnlCardLayout,
  type PnlCardSnapshot,
} from "../lib/wallet-pnl-card";
import { useImageActions } from "../lib/use-image-actions";
import "./wallet-pnl-card.css";

export function WalletPnlCardDialog({
  snapshot,
  onClose,
  onRefresh,
}: {
  snapshot: PnlCardSnapshot;
  onClose: () => void;
  onRefresh?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null),
    closeRef = useRef<HTMLButtonElement>(null),
    id = useId();
  const openerRef = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const [layout, setLayout] = useState<PnlCardLayout>("split");
  const [hideWallet, setHideWallet] = useState(true);
  const [preview, setPreview] = useState<{
    model: ReturnType<typeof walletPnlCardModel>;
    url: string;
    blob: Blob;
  } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [retry, setRetry] = useState(0);
  const model = useMemo(
    () => walletPnlCardModel(snapshot, { layout, hideWallet }),
    [snapshot, layout, hideWallet],
  );
  const ready = preview?.model === model ? preview : null;
  const actions = useImageActions({
    getLink: () => model.link,
    linkLabel: hideWallet ? "paperclub" : "wallet",
    imageLabel: "P&L card",
    capture: () => {
      const frozen = structuredClone(model),
        blob = ready?.blob;
      return {
        filename: frozen.filename,
        title: "P&L card · paperclub",
        text: frozen.shareText,
        url: frozen.link,
        render: async () =>
          blob ??
          (
            await import("../lib/wallet-pnl-card-export")
          ).renderWalletPnlCardPng(frozen),
      };
    },
  });
  useEffect(() => {
    const previous = openerRef.current;
    const dialog = dialogRef.current;
    dialog?.showModal();
    closeRef.current?.focus();
    return () => {
      dialog?.close();
      queueMicrotask(() => {
        if (previous?.isConnected && !document.querySelector("dialog[open]"))
          previous.focus({ preventScroll: true });
      });
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false,
      url: string | null = null;
    setPreviewError("");
    import("../lib/wallet-pnl-card-export")
      .then((module) =>
        module.renderWalletPnlCardPng(model, { signal: controller.signal }),
      )
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreview({ model, blob, url });
      })
      .catch((cause) => {
        if (!cancelled)
          setPreviewError(
            cause instanceof Error
              ? cause.message
              : "Could not create this card.",
          );
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [model, retry]);
  function chooseLayout(next: PnlCardLayout) {
    actions.reset();
    setLayout(next);
  }
  function choosePrivacy(next: boolean) {
    actions.reset();
    setHideWallet(next);
  }
  return (
    <dialog
      ref={dialogRef}
      className="pnl-dialog"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <header className="pnl-dialog-heading">
        <div>
          <span className="pnl-dialog-kicker">PAPERCLUB / SHARE</span>
          <h2 id={id}>Your P&amp;L card</h2>
        </div>
        <button
          type="button"
          ref={closeRef}
          onClick={onClose}
          aria-label="Close P&L card"
        >
          ×
        </button>
      </header>
      <div className="pnl-dialog-controls">
        <div className="pnl-layouts" role="group" aria-label="Card layout">
          {PNL_CARD_LAYOUTS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={layout === item.id}
              onClick={() => chooseLayout(item.id)}
            >
              <strong>{item.name}</strong>
              <span>
                {item.width} × {item.height}
              </span>
            </button>
          ))}
        </div>
        <label className="pnl-privacy">
          <input
            type="checkbox"
            checked={hideWallet}
            onChange={(event) => choosePrivacy(event.target.checked)}
          />
          <span>
            Hide wallet<small>Address + name</small>
          </span>
        </label>
      </div>
      <div
        className={`pnl-preview pnl-preview-${layout}`}
        aria-busy={!ready && !previewError}
      >
        {ready ? (
          <img
            src={ready.url}
            width={model.width}
            height={model.height}
            alt={`${model.identity} · ${model.pnl} lifetime realized trading P&L · ${model.paper} PAPER owned`}
          />
        ) : previewError ? (
          <div role="alert">
            <p>{previewError}</p>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : (
          <p role="status">Preparing your card…</p>
        )}
      </div>
      <dl className="pnl-accessible-summary" aria-label="Card statistics">
        <dt>{PNL_CARD_PNL_LABEL}</dt>
        <dd>
          {model.pnl} · {PNL_CARD_PNL_NOTE}
        </dd>
        <dt>PAPER owned, staked and unstaked</dt>
        <dd>{model.paper}</dd>
        {model.stats.map((stat) => (
          <div key={stat.label}>
            <dt>{stat.label}</dt>
            <dd>{stat.value}</dd>
          </div>
        ))}
      </dl>
      <footer className="pnl-dialog-footer">
        <div className="pnl-actions">
          {onRefresh && (
            <button
              type="button"
              disabled={actions.busy}
              title="Use the latest wallet data already loaded"
              onClick={() => {
                actions.reset();
                onRefresh();
              }}
            >
              Update card
            </button>
          )}
          <button
            type="button"
            disabled={!ready || actions.busy}
            onClick={actions.download}
          >
            {actions.busy ? "Preparing…" : "Download PNG"}
          </button>
          <button
            type="button"
            disabled={!ready || actions.busy}
            onClick={actions.share}
          >
            Share card ↗
          </button>
          <button
            type="button"
            disabled={actions.busy}
            onClick={actions.copyLink}
          >
            Copy {hideWallet ? "site" : "wallet"} link
          </button>
        </div>
        <p className="pnl-action-status" role="status">
          {actions.message}
        </p>
        {actions.manualLink && (
          <input
            aria-label="Share link"
            className="pnl-manual-link"
            readOnly
            value={actions.manualLink}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
        <p className="pnl-source-note">
          Snapshot captured · {model.captured}. Trade highlights use recorded
          closed positions, including liquidations.
        </p>
      </footer>
    </dialog>
  );
}
