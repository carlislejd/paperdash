import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { DataStatus } from "../../../../packages/shared/src/types";
import "./data-info.css";

interface DataInfoDialogProps {
  open: boolean;
  onClose: () => void;
  status: DataStatus | null;
}

export function DataInfoDialog({ open, onClose, status }: DataInfoDialogProps) {
  const titleId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeAction = useRef(onClose);
  closeAction.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const background = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== backdropRef.current,
    );
    const inertBefore = background.map((element) => element.inert);
    background.forEach((element) => {
      element.inert = true;
    });
    closeRef.current?.focus({ preventScroll: true });

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAction.current();
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = buttons[0],
        last = buttons[buttons.length - 1];
      if (!first) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
    function onFocus(event: FocusEvent) {
      if (
        event.target instanceof Node &&
        !dialogRef.current?.contains(event.target)
      )
        closeRef.current?.focus({ preventScroll: true });
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      document.body.style.overflow = previousOverflow;
      background.forEach((element, index) => {
        element.inert = inertBefore[index];
      });
      previousFocus?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  const updated = status?.sourceAt;
  const updatedLabel =
    updated && Number.isFinite(updated)
      ? new Date(updated).toLocaleString()
      : "Waiting for data";
  return createPortal(
    <div
      ref={backdropRef}
      className="info-backdrop data-info-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="info-modal data-info-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <button
          ref={closeRef}
          type="button"
          className="info-close"
          aria-label="Close data information"
          onClick={onClose}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
        <h2 id={titleId}>Data &amp; sources</h2>
        <dl className="source-details data-info-details">
          <dt>Last protocol update</dt>
          <dd>{updatedLabel}</dd>
          <dt>Indexed block</dt>
          <dd>{status?.indexedBlock ?? "—"}</dd>
          <dt>Trade connection</dt>
          <dd>{status?.stream ?? "Connecting"}</dd>
        </dl>
      </section>
    </div>,
    document.body,
  );
}

export default DataInfoDialog;
