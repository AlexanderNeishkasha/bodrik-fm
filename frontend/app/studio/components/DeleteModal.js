import { useEffect, useRef } from "react";
import { ui } from "../../lang/ru";

/** Render a keyboard-safe confirmation dialog and restore prior focus on close. */
export default function DeleteModal({
  deleteTarget,
  onCancel,
  onConfirm,
  isBusy,
}) {
  const lastActiveRef = useRef(null);
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!deleteTarget) {
      return undefined;
    }
    lastActiveRef.current = document.activeElement;
    const handler = (event) => {
      if (event.defaultPrevented || isBusy) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter" && !isBusy) {
        event.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", handler);
    const frameId = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("keydown", handler);
      lastActiveRef.current?.focus?.();
    };
  }, [deleteTarget, isBusy, onCancel, onConfirm]);

  if (!deleteTarget) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-modal-title"
        className="panel-shadow-modal w-full max-w-md space-y-4 rounded-3xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-6"
      >
        <h3 id="delete-modal-title" className="text-lg font-semibold font-display tracking-[0.08em]">
          {ui.studio.deleteTitle}
        </h3>
        <p className="text-sm text-[var(--theme-muted)]">
          {ui.studio.deleteHintPrefix}
          <span className="font-semibold text-[var(--theme-text)]">
            {deleteTarget.filename}
          </span>
          .
        </p>
        <div className="flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={isBusy}
            className="btn-ghost rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] transition disabled:opacity-60"
          >
            {ui.studio.cancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isBusy}
            className="btn-accent rounded-full border border-[var(--theme-accent)] bg-[var(--theme-accent)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)] disabled:opacity-60"
          >
            {ui.studio.delete}
          </button>
        </div>
      </div>
    </div>
  );
}
