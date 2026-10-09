import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { ui } from "../../lang/ru";

/** Render account mutations in a focus-trapped modal with focus restoration. */
export default function AccountModal({ account, login }) {
  const lastActiveRef = useRef(null);
  const modalRef = useRef(null);
  const firstFieldRef = useRef(null);
  const isOpen = Boolean(account?.isOpen);
  const isBusy = Boolean(account?.isBusy);
  const close = account?.close;

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    lastActiveRef.current = document.activeElement;
    const handler = (event) => {
      if (event.defaultPrevented || isBusy) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close?.();
      } else if (event.key === "Tab") {
        trapFocus(event, modalRef.current);
      }
    };
    window.addEventListener("keydown", handler);
    const frameId = window.requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("keydown", handler);
      lastActiveRef.current?.focus?.();
    };
  }, [close, isBusy, isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-modal-title"
        className="panel-shadow-modal relative w-full max-w-md space-y-5 rounded-3xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-6"
      >
        <button
          type="button"
          onClick={account.close}
          disabled={account.isBusy}
          aria-label="Закрыть"
          className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--theme-text)] transition hover:bg-[var(--theme-card-2)] disabled:opacity-60"
        >
          <X aria-hidden="true" className="h-5 w-5" strokeWidth={2.4} />
        </button>

        <div className="pr-10">
          <div>
            <h3
              id="account-modal-title"
              className="font-display text-lg font-semibold tracking-[0.08em]"
            >
              {ui.studio.accountTitle}
            </h3>
            <p className="mt-1 text-sm text-[var(--theme-muted)]">{login}</p>
          </div>
        </div>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!account.isBusy) {
              account.changePassword();
            }
          }}
        >
          <h4 className="text-sm font-semibold">{ui.studio.changePassword}</h4>
          <input
            ref={firstFieldRef}
            type="password"
            value={account.currentPassword}
            onChange={(event) => account.setCurrentPassword(event.target.value)}
            className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)]"
            placeholder={ui.studio.currentPassword}
            aria-label={ui.studio.currentPassword}
            autoComplete="current-password"
            required
          />
          <input
            type="password"
            value={account.newPassword}
            onChange={(event) => account.setNewPassword(event.target.value)}
            className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)]"
            placeholder={ui.studio.newPassword}
            aria-label={ui.studio.newPassword}
            autoComplete="new-password"
            required
          />
          <input
            type="password"
            value={account.confirmPassword}
            onChange={(event) => account.setConfirmPassword(event.target.value)}
            className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)]"
            placeholder={ui.studio.confirmPassword}
            aria-label={ui.studio.confirmPassword}
            autoComplete="new-password"
            required
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={account.isBusy}
              className="btn-accent rounded-full border border-[var(--theme-accent)] bg-[var(--theme-accent)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)] disabled:opacity-60"
            >
              {ui.studio.save}
            </button>
          </div>
        </form>

        <form
          className="space-y-3 border-t border-[var(--theme-border)] pt-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!account.isBusy) {
              account.deleteAccount();
            }
          }}
        >
          <div>
            <h4 className="text-sm font-semibold text-[var(--theme-accent)]">
              {ui.studio.deleteAccount}
            </h4>
            <p className="mt-1 text-sm text-[var(--theme-muted)]">
              {ui.studio.deleteAccountHint}
            </p>
          </div>
          <input
            type="password"
            value={account.deletePassword}
            onChange={(event) => account.setDeletePassword(event.target.value)}
            className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)]"
            placeholder={ui.studio.currentPassword}
            aria-label={`${ui.studio.currentPassword}: ${ui.studio.deleteAccount}`}
            autoComplete="current-password"
            required
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={account.isBusy}
              className="btn-ghost rounded-full border border-[var(--theme-accent)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] transition hover:bg-[var(--theme-accent)] hover:text-[var(--theme-text-dark)] disabled:opacity-60"
            >
              {ui.studio.deleteAccount}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Cycle Tab focus within the active account dialog. */
function trapFocus(event, root) {
  if (!root) {
    return;
  }
  const focusable = Array.from(
    root.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((node) => node.offsetParent !== null);
  if (focusable.length === 0) {
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
