import Link from "next/link";
import styles from "./AdminUserCard.module.css";
import { t } from "../../lang/index.js";

/** Render one admin row with controlled drafts and mutation busy states. */
export default function AdminUserCard({
  user,
  password,
  room,
  listed,
  conferenceAllowed,
  conferenceBusy,
  passwordBusy,
  deleteBusy,
  onPasswordChange,
  onResetPassword,
  onRoomChange,
  onListedChange,
  onConferenceAccessChange,
  onDelete,
}) {
  return (
    <article className={`${styles.card} panel-shadow-card-soft rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card)]`}>
      <div className={styles.heading}>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{user.login}</h2>
          <div className="text-xs text-[var(--theme-muted)]">role: {user.role}</div>
        </div>
        <a
          href={`/${encodeURIComponent(user.room_slug)}`}
          target="_blank"
          rel="noreferrer"
          className={`${styles.roomLink} truncate text-xs text-[var(--theme-muted)] underline decoration-dotted hover:no-underline`}
        >
          /{user.room_slug}
        </a>
      </div>

      <div className={styles.fields}>
        <div className={styles.controlRow}>
          <input
            type="text"
            value={room}
            onChange={(event) => onRoomChange(event.target.value)}
            className={`${styles.input} rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-3 py-1 text-sm`}
            placeholder={t("admin.roomPlaceholder")}
            aria-label={t("admin.roomLabel", { login: user.login })}
          />
          <div className={styles.toggles}>
            <label className={`${styles.listedToggle} text-xs text-[var(--theme-muted)]`}>
              <input
                type="checkbox"
                checked={listed}
                onChange={(event) => onListedChange(event.target.checked)}
                className={styles.listedCheckbox}
              />
              <span>{t("admin.listed")}</span>
            </label>
            <label className={`${styles.listedToggle} text-xs text-[var(--theme-muted)]`}>
              <input
                type="checkbox"
                checked={conferenceAllowed}
                disabled={conferenceBusy}
                onChange={(event) => onConferenceAccessChange(event.target.checked)}
                className={styles.listedCheckbox}
              />
              <span>{t("admin.conferenceAccess")}</span>
            </label>
          </div>
        </div>

        <div className={styles.controlRow}>
          <input
            type="password"
            value={password}
            disabled={passwordBusy}
            onChange={(event) => onPasswordChange(event.target.value)}
            className={`${styles.input} rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-3 py-1 text-sm`}
            placeholder={t("admin.newPassword")}
            aria-label={t("admin.newPasswordLabel", { login: user.login })}
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={onResetPassword}
            disabled={passwordBusy}
            className={`${styles.button} btn-accent rounded-full bg-[var(--theme-accent)] text-xs font-semibold uppercase tracking-[0.2em] text-[var(--theme-text-dark)] disabled:opacity-60`}
          >
            {t("admin.resetPassword")}
          </button>
        </div>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleteBusy}
          className={`${styles.button} rounded-full border border-[var(--theme-accent)] text-xs font-semibold uppercase tracking-[0.2em] text-[var(--theme-accent)] transition hover:bg-[var(--theme-ghost)] active:scale-95 disabled:opacity-60`}
        >
          {t("admin.deleteUser")}
        </button>
        <Link
          href={`/studio?as=${user.id}`}
          className={`${styles.button} btn-ghost rounded-full text-xs font-semibold uppercase tracking-[0.2em]`}
        >
          {t("admin.openStudio")}
        </Link>
      </div>
    </article>
  );
}
