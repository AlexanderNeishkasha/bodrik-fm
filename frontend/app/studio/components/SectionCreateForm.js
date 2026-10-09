import { ui } from "../../lang/ru";
import Icon from "../../components/Icon";

export default function SectionCreateForm({
  name,
  isBusy,
  autoFocus,
  onNameChange,
  onCancel,
  onCreate,
}) {
  return (
    <form
      className="space-y-2 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <input
          autoFocus={autoFocus}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          className="min-w-0 flex-1 rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-3 py-1 text-sm text-[var(--theme-text)]"
          placeholder={ui.studio.sectionNamePlaceholder}
          disabled={isBusy}
        />
        <div className="flex shrink-0 gap-2">
          <button
            type="submit"
            className="btn-accent inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)] disabled:opacity-60"
            disabled={isBusy}
            aria-label={ui.studio.save}
          >
            <Icon name="check" className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="btn-ghost inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition disabled:opacity-60"
            disabled={isBusy}
            aria-label={ui.studio.cancel}
          >
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </form>
  );
}
