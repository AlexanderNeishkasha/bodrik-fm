import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ui } from "../../lang/ru";
import Icon from "../../components/Icon";
import styles from "./AuthPanel.module.css";

/** Render controlled login/registration fields without treating cache as authority. */
export default function AuthPanel({
  loginName,
  password,
  confirmPassword,
  isRegisterMode,
  onLoginNameChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onToggleMode,
  onSubmit,
  isBusy,
}) {
  return (
    <section className={`${styles.panel} panel-shadow-card-soft mx-auto w-full min-w-0 max-w-xl rounded-[28px] border border-[var(--theme-border)] bg-[var(--theme-card)] p-8`}>
      <div className={`${styles.content} space-y-4`}>
        <div className={`${styles.heading} flex items-center gap-3`}>
          <Link
            href="/"
            aria-label={ui.main.backToRooms}
            title={ui.main.backToRooms}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--theme-accent)] transition hover:-translate-y-[1px] hover:text-[var(--theme-accent-bright)] active:scale-95"
          >
            <ArrowLeft aria-hidden="true" className="h-6 w-6" strokeWidth={2.4} />
          </Link>
          <h2 className="text-xl font-semibold font-display tracking-[0.08em]">
            {isRegisterMode ? "Регистрация" : ui.studio.authTitle}
          </h2>
        </div>
        <div className={`${styles.formBlock} space-y-4`}>
          <p className="text-sm text-[var(--theme-muted)]">
            {isRegisterMode
              ? "Создайте аккаунт для своей комнаты."
              : "Войдите в студию своей комнаты."}
          </p>
          <form
            className="w-full space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <input
              type="text"
              value={loginName}
              onChange={(event) => onLoginNameChange(event.target.value)}
              className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)]"
              placeholder="Логин"
              aria-label="Логин"
              autoComplete="username"
              required
            />
            <input
              type="password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)]"
              placeholder={ui.studio.passwordPlaceholder}
              aria-label={ui.studio.passwordPlaceholder}
              autoComplete={isRegisterMode ? "new-password" : "current-password"}
              required
            />
            {isRegisterMode ? (
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => onConfirmPasswordChange(event.target.value)}
                className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)]"
                placeholder="Повторите пароль"
                aria-label="Повторите пароль"
                autoComplete="new-password"
                required
              />
            ) : null}
            {isRegisterMode ? (
              <p className="text-xs leading-relaxed text-[var(--theme-muted)]">
                Регистрируясь, вы соглашаетесь с{" "}
                <Link
                  href="/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4 transition hover:text-[var(--theme-accent)]"
                >
                  Условиями использования
                </Link>{" "}
                и{" "}
                <Link
                  href="/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4 transition hover:text-[var(--theme-accent)]"
                >
                  Политикой конфиденциальности
                </Link>
                .
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={onToggleMode}
                disabled={isBusy}
                className="btn-ghost rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] disabled:opacity-60"
              >
                {isRegisterMode ? "Уже есть аккаунт" : "Регистрация"}
              </button>
              <button
                type="submit"
                disabled={isBusy}
                className="btn-accent inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)] disabled:opacity-60"
                aria-label={isRegisterMode ? "Зарегистрироваться" : ui.studio.login}
              >
                <Icon name="arrow-right" className="h-4 w-4" />
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
