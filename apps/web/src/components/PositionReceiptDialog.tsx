import { useEffect, useId, useRef } from "react";
import {
  positionReceiptFilename,
  positionReceiptModel,
  positionWalletLink,
  type PositionReceiptSnapshot,
} from "../lib/position-receipt";
import { useImageActions } from "../lib/use-image-actions";
import "./position-receipt.css";

export function PositionReceiptDialog({
  snapshot,
  onClose,
}: {
  snapshot: PositionReceiptSnapshot;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    closeRef = useRef<HTMLButtonElement>(null),
    id = useId();
  const model = positionReceiptModel(snapshot),
    link = () => positionWalletLink(model.wallet, window.location.href);
  const actions = useImageActions({
    getLink: link,
    linkLabel: "wallet",
    imageLabel: "Receipt",
    capture: () => {
      const frozen = structuredClone(snapshot);
      return {
        filename: positionReceiptFilename(frozen.position),
        title: `${model.title} · paperclub`,
        text: `${model.status} · ${model.coverage}`,
        url: link(),
        render: async () =>
          (
            await import("../lib/position-receipt-export")
          ).renderPositionReceiptPng(frozen),
      };
    },
  });
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = ref.current;
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
  return (
    <dialog
      className="position-receipt"
      ref={ref}
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
      <header className="receipt-top">
        <span className="receipt-brand">
          paperclub <small>POSITION RECEIPT</small>
        </span>
        <button
          type="button"
          ref={closeRef}
          onClick={onClose}
          aria-label="Close position receipt"
        >
          ×
        </button>
      </header>
      <div className="receipt-body">
        <div className="receipt-title">
          <div>
            <span className="receipt-eyebrow">{model.status}</span>
            <h2 id={id}>{model.title}</h2>
            <p>{model.identity}</p>
          </div>
          <span className="receipt-symbol" aria-hidden="true">
            ✳
          </span>
        </div>
        <section
          className={`receipt-hero ${snapshot.position.adjustedPnlRaw?.startsWith("-") ? "receipt-negative" : ""}`}
          aria-label={model.headline.label}
        >
          <span>{model.headline.label}</span>
          <strong title={model.headline.exact}>{model.headline.value}</strong>
        </section>
        <dl className="receipt-fields">
          {model.fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd title={field.exact}>{field.value}</dd>
            </div>
          ))}
        </dl>
        <div className="receipt-provenance">
          <p>{model.clock}</p>
          <p>{model.coverage}</p>
          <p>
            Recorded values, not a settlement statement. Entry notional is
            initial margin × entry leverage.
          </p>
        </div>
        {model.warnings.length > 0 && (
          <details className="receipt-warnings">
            <summary>
              {model.warnings.length} source field
              {model.warnings.length === 1 ? "" : "s"} unavailable or uncertain
            </summary>
            <ul>
              {model.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </details>
        )}
        <details className="receipt-exact">
          <summary>Exact values</summary>
          <dl>
            {[model.headline, ...model.fields].map((field, index) => (
              <div key={index}>
                <dt>{field.label}</dt>
                <dd>{field.exact}</dd>
              </div>
            ))}
          </dl>
        </details>
        {model.owner && <p className="receipt-owner">{model.owner}</p>}
        <p className="receipt-wallet" title={model.wallet}>
          {model.wallet}
        </p>
        {snapshot.position.txHash && (
          <a
            className="receipt-tx"
            href={`https://hyperevmscan.io/tx/${snapshot.position.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View outcome transaction ↗
          </a>
        )}
        <div className="receipt-actions">
          <button
            type="button"
            disabled={actions.busy}
            onClick={actions.download}
          >
            Download PNG
          </button>
          <button type="button" disabled={actions.busy} onClick={actions.share}>
            {actions.readyFile ? "Share image" : "Share"}
          </button>
          <button type="button" onClick={actions.copyLink}>
            Copy wallet link
          </button>
        </div>
        <p className="receipt-action-status" role="status">
          {actions.busy ? "Preparing image…" : actions.message}
        </p>
        {actions.manualLink && (
          <input
            className="receipt-link"
            readOnly
            aria-label="Wallet link"
            value={actions.manualLink}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
        <p className="receipt-footnote">
          This receipt is frozen when opened. The link opens the wallet, not
          this individual position.
        </p>
      </div>
    </dialog>
  );
}
