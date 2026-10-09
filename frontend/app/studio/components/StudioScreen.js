import { useCallback } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import AuthPanel from "./AuthPanel";
import ConferenceControls from "./ConferenceControls";
import LibraryPanel from "./LibraryPanel";
import NowPlayingPanel from "./NowPlayingPanel";
import QueuePanel from "./QueuePanel";
import ThemeToggle from "./ThemeToggle";
import { ui } from "../../lang/ru";
import HotkeysPanel from "../../components/HotkeysPanel";
import BodrickFlyby from "../../components/BodrickFlyby";
import Icon from "../../components/Icon";
import { ROOM_SLUG_MAX_LENGTH } from "../lib/roomSlugLimit";
import styles from "./StudioScreen.module.css";

/** Arrange Studio playback, library and queue with a separate optional meeting card. */
export default function StudioScreen({ auth, playback, queue, library, theme, hotkeys, easter, isDndActive = false }) {
  const handleCopyRoomLink = useCallback(async () => {
    if (!auth.publicRoomLink || typeof window === "undefined") {
      return;
    }
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(auth.publicRoomLink);
        if (typeof auth.showNotice === "function") {
          auth.showNotice(ui.messages.roomLinkCopied);
        }
        return;
      } catch {}
    }
    window.prompt(ui.studio.copyRoomLinkPrompt, auth.publicRoomLink);
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
                  aria-label={auth.showAdminBack ? ui.studio.backToAdmin : ui.main.backToRooms}
                  title={auth.showAdminBack ? ui.studio.backToAdmin : ui.main.backToRooms}
                  className={`${styles.homeButton} inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--theme-accent)] transition hover:-translate-y-[1px] hover:text-[var(--theme-accent-bright)] active:scale-95`}
                >
                  <ArrowLeft aria-hidden="true" className="h-6 w-6" strokeWidth={2.4} />
                </Link>
                <div className={`${styles.roomControls} flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 text-xs text-[var(--theme-muted)]`}>
                  <button
                    onClick={handleCopyRoomLink}
                    type="button"
                    title={ui.studio.copyRoomLink}
                    className={`${styles.copyLink} btn-ghost inline-flex min-w-0 items-center gap-2 rounded-full px-3 py-1`}
                  >
                    <span className={`${styles.copyUrl} truncate`}>{auth.publicRoomLink}</span>
                    <span className={styles.copyLabel}>Ссылка</span>
                    <Icon name="copy" className="h-4 w-4 shrink-0" />
                  </button>
                  <input
                    type="text"
                    value={auth.roomSlugInput}
                    maxLength={ROOM_SLUG_MAX_LENGTH}
                    onChange={(event) => auth.onRoomSlugInputChange(event.target.value.slice(0, ROOM_SLUG_MAX_LENGTH))}
                    className={`${styles.roomInput} rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-3 py-1 text-xs text-[var(--theme-text)]`}
                    placeholder="комната"
                  />
                  <label className={`${styles.listedToggle} inline-flex items-center gap-2 rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-3 py-1 text-xs text-[var(--theme-text)]`}>
                    <input
                      type="checkbox"
                      checked={Boolean(auth.roomListedInput)}
                      onChange={(event) => auth.onRoomListedInputChange(event.target.checked)}
                    />
                    В списке комнат
                  </label>
                </div>
                <div className={`${styles.sessionActions} ml-auto flex items-center gap-2`}>
                  {auth.canManageAccount ? (
                    <button
                      type="button"
                      onClick={auth.account?.open}
                      disabled={auth.isBusy}
                      className={`${styles.headerButton} btn-ghost rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] transition disabled:opacity-60`}
                    >
                      {ui.studio.account}
                    </button>
                  ) : null}
                  <button
                    onClick={auth.onLogout}
                    disabled={auth.isBusy}
                    className={`${styles.headerButton} rounded-full bg-[var(--theme-accent)] px-5 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)] disabled:opacity-60`}
                  >
                    {ui.studio.logout}
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
                <QueuePanel
                  queueEntries={queue.entries}
                  queueIds={queue.ids}
                  onForcePlay={queue.onForcePlay}
                  onRemove={queue.onRemove}
                  displayName={queue.displayName}
                />
                {auth.conference?.allowed ? (
                  <div className={styles.meetingPlacement}>
                    <ConferenceControls conference={auth.conference} musicOutput={playback.musicOutput} />
                  </div>
                ) : null}
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
          title={ui.studio.hotkeys.title}
          hideLabel={ui.studio.hotkeys.hide}
          onHide={() => hotkeys.show && hotkeys.onToggle()}
          className="hotkeys-studio"
          entries={[
            {
              key: "Space",
              label: !playback.isPlaying ? ui.studio.hotkeys.play : ui.studio.hotkeys.playPause,
            },
            {
              key: "M",
              label: playback.localMuted ? ui.studio.hotkeys.muteOn : ui.studio.hotkeys.muteOff,
            },
            { key: "← →", label: ui.studio.hotkeys.seek },
            { key: "↑ ↓", label: ui.studio.hotkeys.volume },
            { key: "E", label: ui.studio.hotkeys.edit },
            { key: "H", label: ui.studio.hotkeys.hint, isHint: true },
          ]}
        />
      ) : null}
    </div>
  );
}
