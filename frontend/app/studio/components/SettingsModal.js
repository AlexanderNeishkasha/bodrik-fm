import { useEffect, useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { t } from "../../lang/index.js";
import SwitchControl from "../../../components/ui/SwitchControl";
import Icon from "../../../components/ui/Icon";
import { ROOM_SLUG_MAX_LENGTH } from "../lib/roomSlugLimit";

/** Render account, room and meeting configuration in one focus-trapped dialog. */
export default function SettingsModal({ auth }) {
  const lastActiveRef = useRef(null);
  const modalRef = useRef(null);
  const firstTabRef = useRef(null);
  const account = auth?.account;
  const isOpen = Boolean(account?.isOpen);
  const isBusy = Boolean(account?.isBusy || auth?.isSlugBusy || auth?.conference?.busy);
  const close = account?.close;
  const sections = useMemo(() => [
    ...(auth?.canManageAccount ? [{ id: "account", label: t("studio.settingsAccount"), icon: "profile" }] : []),
    { id: "room", label: t("studio.settingsRoom"), icon: "room" },
    ...(auth?.conference?.allowed ? [{ id: "meeting", label: t("studio.settingsMeeting"), icon: "video" }] : []),
  ], [auth?.canManageAccount, auth?.conference?.allowed]);
  const [activeSection, setActiveSection] = useState(sections[0]?.id ?? "room");
  const resolvedSection = sections.some((section) => section.id === activeSection)
    ? activeSection
    : sections[0]?.id ?? "room";

  useEffect(() => {
    if (!isOpen) return undefined;
    lastActiveRef.current = document.activeElement;
    const handler = (event) => {
      if (event.defaultPrevented || isBusy) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close?.();
      } else if (event.key === "Tab") {
        trapFocus(event, modalRef.current);
      }
    };
    window.addEventListener("keydown", handler);
    const frameId = window.requestAnimationFrame(() => firstTabRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("keydown", handler);
      lastActiveRef.current?.focus?.();
    };
  }, [close, isBusy, isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-0 md:px-4 md:py-6">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-settings-title"
        className="panel-shadow-modal relative flex h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-0 bg-[var(--theme-card)] md:h-[min(42rem,calc(100dvh-3rem))] md:max-w-3xl md:rounded-3xl md:border md:border-[var(--theme-border)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--theme-border)] px-6 py-5">
          <h2 id="studio-settings-title" className="font-display text-xl font-semibold tracking-[0.08em]">
            {t("studio.settings")}
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={isBusy}
            aria-label={t("studio.closeSettings")}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--theme-text)] transition hover:bg-[var(--theme-card-2)] disabled:opacity-60"
          >
            <X aria-hidden="true" className="h-5 w-5" strokeWidth={2.4} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav aria-label={t("studio.settingsSections")} className="flex shrink-0 gap-2 overflow-x-auto border-b border-[var(--theme-border)] p-4 md:w-48 md:flex-col md:border-b-0 md:border-r">
            {sections.map((section, index) => (
              <button
                key={section.id}
                ref={index === 0 ? firstTabRef : undefined}
                type="button"
                onClick={() => setActiveSection(section.id)}
                aria-current={resolvedSection === section.id ? "page" : undefined}
                className={`inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-left text-sm font-semibold transition ${
                  resolvedSection === section.id
                    ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
                    : "text-[var(--theme-muted)] hover:bg-[var(--theme-card-2)] hover:text-[var(--theme-text)]"
                }`}
              >
                <Icon name={section.icon} className="h-4 w-4 shrink-0" />
                <span>{section.label}</span>
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {resolvedSection === "account" ? <AccountSettings account={account} login={auth.login} /> : null}
            {resolvedSection === "room" ? <RoomSettings auth={auth} /> : null}
            {resolvedSection === "meeting" ? <MeetingSettings conference={auth.conference} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Render the existing password and account-deletion controls. */
function AccountSettings({ account, login }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">{t("studio.accountTitle")}</h3>
        <p className="mt-1 text-sm text-[var(--theme-muted)]">{login}</p>
      </div>
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (!account.isBusy) account.changePassword();
      }}>
        <h4 className="text-sm font-semibold">{t("studio.changePassword")}</h4>
        <input type="password" value={account.currentPassword} onChange={(event) => account.setCurrentPassword(event.target.value)}
          className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)]"
          placeholder={t("studio.currentPassword")} aria-label={t("studio.currentPassword")} autoComplete="current-password" required />
        <input type="password" value={account.newPassword} onChange={(event) => account.setNewPassword(event.target.value)}
          className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)]"
          placeholder={t("studio.newPassword")} aria-label={t("studio.newPassword")} autoComplete="new-password" required />
        <input type="password" value={account.confirmPassword} onChange={(event) => account.setConfirmPassword(event.target.value)}
          className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)]"
          placeholder={t("studio.confirmPassword")} aria-label={t("studio.confirmPassword")} autoComplete="new-password" required />
        <div className="flex justify-end">
          <button type="submit" disabled={account.isBusy}
            className="btn-accent rounded-full border border-[var(--theme-accent)] bg-[var(--theme-accent)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)] disabled:opacity-60">
            {t("studio.save")}
          </button>
        </div>
      </form>
      <form className="space-y-3 border-t border-[var(--theme-border)] pt-5" onSubmit={(event) => {
        event.preventDefault();
        if (!account.isBusy) account.deleteAccount();
      }}>
        <div>
          <h4 className="text-sm font-semibold text-[var(--theme-accent)]">{t("studio.deleteAccount")}</h4>
          <p className="mt-1 text-sm text-[var(--theme-muted)]">{t("studio.deleteAccountHint")}</p>
        </div>
        <input type="password" value={account.deletePassword} onChange={(event) => account.setDeletePassword(event.target.value)}
          className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)]"
          placeholder={t("studio.currentPassword")} aria-label={`${t("studio.currentPassword")}: ${t("studio.deleteAccount")}`}
          autoComplete="current-password" required />
        <div className="flex justify-end">
          <button type="submit" disabled={account.isBusy}
            className="btn-ghost rounded-full border border-[var(--theme-accent)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] transition hover:bg-[var(--theme-accent)] hover:text-[var(--theme-text-dark)] disabled:opacity-60">
            {t("studio.deleteAccount")}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Render automatically persisted room identity and directory visibility. */
function RoomSettings({ auth }) {
  const listedId = useId();
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">{t("studio.settingsRoom")}</h3>
        <p className="mt-1 text-sm text-[var(--theme-muted)]">{t("studio.roomSettingsHint")}</p>
      </div>
      <label className="block space-y-2 text-sm font-semibold">
        <span>{t("studio.roomAddress")}</span>
        <input type="text" value={auth.roomSlugInput} maxLength={ROOM_SLUG_MAX_LENGTH}
          onChange={(event) => auth.onRoomSlugInputChange(event.target.value.slice(0, ROOM_SLUG_MAX_LENGTH))}
          disabled={auth.isSlugBusy}
          className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm font-normal text-[var(--theme-text)] disabled:opacity-60" />
      </label>
      <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] px-4 py-3">
        <div>
          <label htmlFor={listedId} className="text-sm font-semibold">{t("studio.roomListed")}</label>
          <p className="mt-1 text-xs text-[var(--theme-muted)]">{t("studio.roomListedHint")}</p>
        </div>
        <SwitchControl id={listedId} label={t("studio.roomListed")} checked={Boolean(auth.roomListedInput)} disabled={auth.isSlugBusy}
          onChange={(event) => auth.onRoomListedInputChange(event.target.checked)} />
      </div>
      <p className="text-xs text-[var(--theme-muted)]">{t("studio.settingsAutosave")}</p>
    </div>
  );
}

/** Render meeting availability while operational controls remain in the Studio. */
function MeetingSettings({ conference }) {
  const enabledId = useId();
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">{t("studio.settingsMeeting")}</h3>
        <p className="mt-1 text-sm text-[var(--theme-muted)]">{t("studio.meetingSettingsHint")}</p>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] px-4 py-3">
        <div>
          <label htmlFor={enabledId} className="text-sm font-semibold">{t("studio.meetingEnabled")}</label>
          <p className="mt-1 text-xs text-[var(--theme-muted)]">{t("studio.meetingEnabledHint")}</p>
        </div>
        <SwitchControl id={enabledId} label={t("studio.meetingEnabled")} checked={Boolean(conference.enabled)} disabled={conference.busy}
          onChange={(event) => conference.setEnabled(event.target.checked)} />
      </div>
    </div>
  );
}

/** Cycle Tab focus within the active settings dialog. */
function trapFocus(event, root) {
  if (!root) return;
  const focusable = Array.from(root.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  )).filter((node) => node.offsetParent !== null);
  if (focusable.length === 0) return;
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
