import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../lang/index.js";
import Icon from "../../components/Icon";
import styles from "./ConferenceControls.module.css";

/** Render live meeting output and invitation controls above the queue. */
export default function ConferenceControls({ conference, musicOutput }) {
  const [linkCopied, setLinkCopied] = useState(false);
  const copiedTimerRef = useRef(null);

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), []);

  const handleCopyGuestLink = useCallback(async () => {
    if (!await conference?.copyGuestLink?.()) return;
    setLinkCopied(true);
    window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setLinkCopied(false), 1000);
  }, [conference]);

  if (!conference?.allowed || !conference.enabled) return null;
  return (
    <aside className={styles.card} aria-label={t("studio.meeting")}>
      <h2 className="text-lg font-semibold font-display tracking-[0.08em]">{t("studio.meeting")}</h2>
      <fieldset className={styles.output} disabled={conference.busy}>
        <legend>{t("studio.musicDestination")}</legend>
        <div className={styles.outputOptions}>
          <button type="button" aria-pressed={musicOutput === "studio"}
            onClick={() => conference.setMusicOutput("studio")}
            className={`${styles.outputOption} ${musicOutput === "studio" ? styles.outputOptionActive : ""}`}>
            {t("studio.outputStudio")}
          </button>
          <button type="button" aria-pressed={musicOutput === "conference"}
            onClick={() => conference.setMusicOutput("conference")}
            className={`${styles.outputOption} ${musicOutput === "conference" ? styles.outputOptionActive : ""}`}>
            {t("studio.outputMeeting")}
          </button>
        </div>
      </fieldset>
      <div className={styles.actions}>
        {conference.inviteUrl && (
          <a href={conference.inviteUrl} target="_blank" rel="noopener noreferrer"
            className={`${styles.actionButton} btn-ghost`}>
            <span>{t("studio.meetingOpen")}</span><Icon name="external-link" />
          </a>
        )}
        <button type="button" disabled={conference.busy || !conference.inviteUrl} onClick={handleCopyGuestLink}
          aria-label={t("studio.meetingCopyLink")} title={t("studio.meetingCopyLink")}
          className={`${styles.actionButton} btn-ghost`}>
          <span>{t("studio.meetingCopyGuestLink")}</span><Icon name={linkCopied ? "check" : "copy"} />
        </button>
      </div>
    </aside>
  );
}
