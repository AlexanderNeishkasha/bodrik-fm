/** Shared text-only notification presentation; event producers own duration and optional sounds. */
export default function Toast({ notice, severity = "info", className = "" }) {
  if (!notice) return null;
  return <div className={`fixed left-1/2 top-6 z-50 w-full max-w-sm -translate-x-1/2 px-6 ${className}`}>
    <div role={severity === "error" ? "alert" : "status"} aria-atomic="true"
      className="panel-shadow-toast rounded-full border border-[var(--theme-border)] bg-[var(--theme-accent)] px-4 py-3 text-center text-sm font-semibold text-[var(--theme-text-dark)]">
      {notice}
    </div>
  </div>;
}
