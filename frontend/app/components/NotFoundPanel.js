import Link from "next/link";

export default function NotFoundPanel() {
  return (
    <div className="mobile-surface-screen hero-bg min-h-screen text-[var(--theme-text)]">
      <div className="mobile-surface-shell mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
        <main className="mobile-surface-panel mobile-surface-center panel-shadow-hero space-y-5 rounded-[32px] border border-[var(--theme-border)] bg-[var(--theme-card)] p-10">
          <h1 className="text-2xl font-semibold font-display">404</h1>
          <p className="text-sm text-[var(--theme-muted)]">
            Страница не найдена.
          </p>
          <Link
            href="/"
            className="btn-accent inline-flex rounded-full bg-[var(--theme-accent)] px-5 py-2 text-sm font-semibold text-[var(--theme-text-dark)]"
          >
            К списку комнат
          </Link>
        </main>
      </div>
    </div>
  );
}
