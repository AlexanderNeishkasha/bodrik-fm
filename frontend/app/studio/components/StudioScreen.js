import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";
import AuthPanel from "./AuthPanel";
import ConferenceControls from "./ConferenceControls";
import LibraryPanel from "./LibraryPanel";
import NowPlayingPanel from "./NowPlayingPanel";
import QueuePanel from "./QueuePanel";
import ThemeToggle from "./ThemeToggle";
import { t } from "../../lang/index.js";
import HotkeysPanel from "../../components/HotkeysPanel";
import BodrickFlyby from "../../components/BodrickFlyby";
import Icon from "../../components/Icon";
import styles from "./StudioScreen.module.css";
import { copyText } from "../lib/copyText.mjs";

/** Arrange Studio playback, library and queue with a separate optional meeting card. */
export default function StudioScreen({ auth, playback, queue, library, theme, hotkeys, easter, isDndActive = false }) {
  const [roomLinkCopied, setRoomLinkCopied] = useState(false);
  const roomLinkTimerRef = useRef(null);

  useEffect(() => () => window.clearTimeout(roomLinkTimerRef.current), []);

  const handleCopyRoomLink = useCallback(async () => {
    if (!auth.publicRoomLink || typeof window === "undefined") return;
    if (!await copyText(auth.publicRoomLink)) {
      window.prompt(t("studio.copyRoomLinkPrompt"), auth.publicRoomLink);
      return;
    }
    auth.showNotice?.(t("messages.roomLinkCopied"));
    setRoomLinkCopied(true);
    window.clearTimeout(roomLinkTimerRef.current);
    roomLinkTimerRef.current = window.setTimeout(() => setRoomLinkCopied(false), 1000);
  }, [auth]);

  return (
    <div
      className={`${auth.isAuthed ? "" : styles.authScreen} ${
        isDndActive ? styles.dndActive : ""
      } hero-bg min-h-screen text-[var(--theme-text)]`}
      onClick={easter?.onInteract}
    >
      <BodrickFlyby interactionToken={easter?.interactionToken} storageKey="bodrick_misses" />
      <div className={`${auth.isAuthed ? styles.shell : styles.authShell} mx-auto flex min-h-screen max-w-5xl flex-col gap-10 px-6 py-14`}>
        <header className={`${auth.isAuthed ? styles.header : styles.authEmptyHeader} flex w-full flex-col gap-3`}>
          {auth.isAuthed ? (
            <>
              <div className={`${styles.headerTop} flex w-full flex-wrap items-center gap-3`}>
                <Link
                  href={auth.showAdminBack ? "/puppet_master" : "/"}
                  aria-label={auth.showAdminBack ? t("studio.backToAdmin") : t("main.backToRooms")}
                  title={auth.showAdminBack ? t("studio.backToAdmin") : t("main.backToRooms")}
                  className={`${styles.homeButton} inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--theme-accent)] transition hover:-translate-y-[1px] hover:text-[var(--theme-accent-bright)] active:scale-95`}
                >
                  <ArrowLeft aria-hidden="true" className="h-6 w-6" strokeWidth={2.4} />
                </Link>
                <div className={`${styles.sessionActions} ml-auto flex items-center gap-2`}>
                  <button
                    onClick={handleCopyRoomLink}
                    type="button"
                    title={t("studio.copyRoomLink")}
                    className={`${styles.headerButton} btn-ghost inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] transition`}
                  >
                    {t("studio.roomLink")}
                    <Icon name={roomLinkCopied ? "check" : "copy"} className="h-4 w-4 shrink-0" />
                  </button>
                  <button
                    type="button"
                    onClick={auth.account?.open}
                    disabled={auth.isBusy}
                    className={`${styles.headerButton} btn-ghost inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] transition disabled:opacity-60`}
                  >
                    <Settings aria-hidden="true" className="h-4 w-4" strokeWidth={2.4} />
                    {t("studio.settings")}
                  </button>
                  <button
                    onClick={auth.onLogout}
                    disabled={auth.isBusy}
                    className={`${styles.headerButton} btn-ghost rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] transition disabled:opacity-60`}
                  >
                    {t("studio.logout")}
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </header>

        {!auth.isChecked ? (
          <div className="h-[420px]" />
        ) : !auth.isAuthed ? (
          <AuthPanel
            loginName={auth.loginName}
            password={auth.password}
            confirmPassword={auth.confirmPassword}
            isRegisterMode={auth.isRegisterMode}
            onLoginNameChange={auth.onLoginNameChange}
            onPasswordChange={auth.onPasswordChange}
            onConfirmPasswordChange={auth.onConfirmPasswordChange}
            onToggleMode={auth.onToggleMode}
            onSubmit={auth.onSubmit}
            isBusy={auth.isBusy}
          />
        ) : (
          <div className="space-y-8">
            <NowPlayingPanel
              audioRef={playback.audioRef}
              currentLabel={playback.currentLabel}
              listeners={playback.listeners}
              isPlaying={playback.isPlaying}
              positionLabel={playback.positionLabel}
              seekValue={playback.seekValue}
              seekMax={playback.seekMax}
              onSeekChange={playback.onSeekChange}
              onSeekCommit={playback.onSeekCommit}
              onPause={playback.onPause}
              onResume={playback.onResume}
              onSkip={playback.onSkip}
              isRepeatOn={playback.isRepeatOn}
              onToggleRepeat={playback.onToggleRepeat}
              localVolume={playback.localVolume}
              localMuted={playback.localMuted}
              onToggleMute={playback.onToggleMute}
              onVolumeChange={playback.onVolumeChange}
              outputForcedMuted={playback.outputForcedMuted}
              musicOutput={playback.musicOutput}
              dropId="now-playing"
            />

            <div className="relative z-10 grid items-start gap-8 lg:grid-cols-2 lg:items-stretch">
              <div className={styles.queueColumn}>
                {auth.conference?.allowed && auth.conference?.enabled ? (
                  <div className={styles.meetingPlacement}>
                    <ConferenceControls conference={auth.conference} musicOutput={playback.musicOutput} />
                  </div>
                ) : null}
                <QueuePanel
                  queueEntries={queue.entries}
                  queueIds={queue.ids}
                  onForcePlay={queue.onForcePlay}
                  onRemove={queue.onRemove}
                  displayName={queue.displayName}
                />
              </div>
              <LibraryPanel
                sections={library.sections}
                tracks={library.tracks}
                uploads={library.uploads}
                youtubeDownloads={library.youtubeDownloads}
                onDismissYoutubeDownload={library.onDismissYoutubeDownload}
                youtubeModal={library.youtubeModal}
                isEditingLibrary={library.isEditing}
                isDragging={library.isDragging}
                fileInputRef={library.fileInputRef}
                onUpload={library.onUpload}
                onTriggerUpload={library.onTriggerUpload}
                onTriggerYoutube={library.onTriggerYoutube}
                onToggleEdit={library.onToggleEdit}
                onDragOver={library.onDragOver}
                onDragLeave={library.onDragLeave}
                onDrop={library.onDrop}
                isBusy={library.isBusy}
                editingTrackId={library.editingTrackId}
                editingValue={library.editingValue}
                onEditValueChange={library.onEditValueChange}
                onStartRename={library.onStartRename}
                onCancelRename={library.onCancelRename}
                onConfirmRename={library.onConfirmRename}
                onRequestDelete={library.onRequestDelete}
                newSectionName={library.newSectionName}
                onNewSectionNameChange={library.onNewSectionNameChange}
                isAddingSection={library.isAddingSection}
                onStartAddSection={library.onStartAddSection}
                onCancelAddSection={library.onCancelAddSection}
                onCreateSection={library.onCreateSection}
                editingSectionId={library.editingSectionId}
                editingSectionName={library.editingSectionName}
                onEditingSectionNameChange={library.onEditingSectionNameChange}
                onStartRenameSection={library.onStartRenameSection}
                onCancelRenameSection={library.onCancelRenameSection}
                onConfirmRenameSection={library.onConfirmRenameSection}
                onDeleteSection={library.onDeleteSection}
                collapsedSectionIds={library.collapsedSectionIds}
                onToggleSectionCollapsed={library.onToggleSectionCollapsed}
                onPlay={library.onPlay}
                onQueue={library.onQueue}
                displayName={library.displayName}
              />
            </div>

            <ThemeToggle currentTheme={theme.current} onThemeChange={theme.onChange} isBusy={theme.isBusy} />
          </div>
        )}
      </div>
      {hotkeys.isHydrated ? (
        <HotkeysPanel
          title={t("studio.hotkeys.title")}
          hideLabel={t("studio.hotkeys.hide")}
          onHide={() => hotkeys.show && hotkeys.onToggle()}
          className="hotkeys-studio"
          entries={[
            {
              key: "Space",
              label: !playback.isPlaying ? t("studio.hotkeys.play") : t("studio.hotkeys.playPause"),
            },
            {
              key: "M",
              label: playback.localMuted ? t("studio.hotkeys.muteOn") : t("studio.hotkeys.muteOff"),
            },
            { key: "← →", label: t("studio.hotkeys.seek") },
            { key: "↑ ↓", label: t("studio.hotkeys.volume") },
            { key: "E", label: t("studio.editLibrary") },
            { key: "H", label: t("studio.hotkeys.hint"), isHint: true },
          ]}
        />
      ) : null}
    </div>
  );
}
