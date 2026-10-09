import { ui } from "../../lang/ru";
import Icon from "../../components/Icon";
import CollapsibleLibraryBlock from "./CollapsibleLibraryBlock";

export default function YoutubeDownloadForm({
  isOpen,
  url,
  error,
  isBusy,
  onUrlChange,
  onSubmit,
}) {
  return (
    <CollapsibleLibraryBlock isOpen={isOpen}>
      <form
        className="space-y-2 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <input
            autoFocus={isOpen}
            type="url"
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder={ui.studio.youtubeUrlPlaceholder}
            className="min-w-0 flex-1 rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-3 py-1 text-sm text-[var(--theme-text)]"
            disabled={isBusy}
          />
          <button
            type="submit"
            className="btn-accent inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)] disabled:opacity-60"
            disabled={isBusy}
            aria-label={ui.studio.download}
          >
            <Icon name="download" className="h-4 w-4" />
          </button>
        </div>
        {error ? <p className="text-sm text-[var(--theme-red)]">{error}</p> : null}
      </form>
    </CollapsibleLibraryBlock>
  );
}
