import { ui } from "../../lang/ru";

export default function LibraryUploads({ uploads, displayName }) {
  if (uploads.length === 0) {
    return null;
  }
  const pending = uploads.filter((upload) => upload.status !== "done");
  if (pending.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2">
      {pending.map((upload) => (
        <div
          key={upload.id}
          className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-[var(--theme-text)]">
              {displayName(upload.name)}
            </div>
            <div className="mt-2 h-1 w-full rounded-full bg-[var(--theme-panel-hover)]">
              <div
                className={`h-1 rounded-full ${
                  upload.status === "error"
                    ? "bg-[var(--theme-red)]"
                    : "bg-[var(--theme-accent)]"
                }`}
                style={{
                  width: `${Math.round((upload.progress ?? 0) * 100)}%`,
                }}
              />
            </div>
          </div>
          <span className="text-xs uppercase tracking-[0.2em] text-[var(--theme-muted)]">
            {upload.status === "error"
              ? ui.studio.errorLabel
              : `${Math.round((upload.progress ?? 0) * 100)}%`}
          </span>
        </div>
      ))}
    </div>
  );
}
