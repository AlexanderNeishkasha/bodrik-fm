import { t } from "../../lang/index.js";
import Icon from "../../components/Icon";
import styles from "./LibraryHeader.module.css";

export default function LibraryHeader({
  isEditingLibrary,
  isAddingSection,
  isYoutubeOpen,
  isBusy,
  onTriggerUpload,
  onTriggerYoutube,
  onToggleEdit,
  onStartAddSection,
}) {
  return (
    <div className={`${styles.root} flex items-center justify-between gap-3`}>
      <h2 className="text-lg font-semibold font-display tracking-[0.08em]">
        {t("studio.library")}
      </h2>
      <div className={`${styles.actions} flex items-center gap-2`}>
        <button
          onClick={onStartAddSection}
          disabled={isBusy}
          className={`inline-flex h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold uppercase tracking-[0.16em] transition disabled:opacity-60 ${
            isAddingSection
              ? "btn-accent bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
          aria-label={t("studio.addSection")}
          title={t("studio.addSection")}
        >
          <Icon name="plus" className="h-4 w-4" />
          <span>{t("studio.section")}</span>
        </button>
        <button
          onClick={onTriggerUpload}
          disabled={isBusy}
          className="btn-accent inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)] disabled:opacity-60"
          aria-label={t("studio.upload")}
          title={t("studio.upload")}
        >
          <Icon name="plus" className="h-4 w-4" />
        </button>
        <button
          onClick={onTriggerYoutube}
          disabled={isBusy}
          title={t("studio.youtubeDownload")}
          className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition disabled:opacity-60 ${
            isYoutubeOpen
              ? "btn-accent bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
          aria-label={t("studio.youtubeDownload")}
        >
          <Icon name="youtube" className="h-4 w-4" />
        </button>
        <button
          onClick={onToggleEdit}
          data-edit-toggle="true"
          className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition ${
            isEditingLibrary
              ? "btn-accent bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
          aria-label={t("studio.editLibrary")}
          title={t("studio.editLibrary")}
        >
          <Icon name="edit" className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
