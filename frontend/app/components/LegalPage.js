import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function LegalPage({ title, updatedAt, children }) {
  return (
    <div className="mobile-surface-screen hero-bg min-h-screen text-[var(--theme-text)]">
      <div className="mobile-surface-shell mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
        <main className="mobile-surface-panel panel-shadow-hero space-y-6 rounded-[32px] border border-[var(--theme-border)] bg-[var(--theme-card)] p-10">
          <header className="space-y-3">
            <div className="flex items-center gap-4">
              <Link
                href="/"
                aria-label="К списку комнат"
                title="К списку комнат"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--theme-accent)] transition hover:-translate-y-[1px] hover:text-[var(--theme-accent-bright)] active:scale-95"
              >
                <ArrowLeft aria-hidden="true" className="h-6 w-6" strokeWidth={2.4} />
              </Link>
              <h1 className="font-display text-2xl font-semibold tracking-[0.08em]">
                {title}
              </h1>
            </div>
            <p className="text-sm text-[var(--theme-muted)]">
              Обновлено: {updatedAt}
            </p>
          </header>
          <div className="space-y-5 text-sm leading-relaxed text-[var(--theme-muted)]">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
