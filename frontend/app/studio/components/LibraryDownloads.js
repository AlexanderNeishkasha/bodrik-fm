import Icon from "../../components/Icon";
import { youtubeStageLabel } from "../lib/youtube";

export default function LibraryDownloads({ downloads, displayName, onDismiss }) {
  if (!downloads?.length) {
    return null;
  }
  return (
    <div className="space-y-2">
      {downloads.map((download) => {
        const progress = Math.max(0, Math.min(1, download.progress ?? 0));
        const isError = download.status === "error";
        return (
          <div
            key={download.id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] px-4 py-3 opacity-80"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[var(--theme-text)]">
                {displayName(download.title)}
              </div>
              <div className="mt-2 h-1 w-full rounded-full bg-[var(--theme-panel-hover)]">
                <div
                  className={`h-1 rounded-full ${
                    isError ? "bg-[var(--theme-red)]" : "bg-[var(--theme-accent)]"
                  }`}
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs uppercase tracking-[0.2em] text-[var(--theme-muted)]">
                {isError ? youtubeStageLabel("error") : youtubeStageLabel(download.stage)}
              </span>
              {isError ? (
                <button
                  type="button"
                  onClick={() => onDismiss?.(download.id)}
                  className="btn-ghost inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--theme-muted)] hover:text-[var(--theme-text)]"
                  aria-label="Убрать ошибку загрузки"
                  title="Убрать"
                >
                  <Icon name="close" className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
