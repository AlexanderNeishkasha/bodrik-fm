import { useId } from "react";
import { ui } from "../../lang/ru";
import Icon from "../../components/Icon";
import SwitchControl from "../../../components/ui/SwitchControl";
import { useMeetingOutputPresence } from "../hooks/useMeetingPresence";
import styles from "./ConferenceControls.module.css";

/** Render optional meeting controls in their own card at every viewport size. */
export default function ConferenceControls({ conference, musicOutput }) {
  const musicId = useId();
  const destinationId = useId();
  const actions = useMeetingOutputPresence(Boolean(conference?.enabled));
  if (!conference?.allowed) return null;
  return (
    <aside className={styles.card} aria-label={ui.studio.meeting}>
      <div className={styles.header}>
        <h2 className="text-lg font-semibold font-display tracking-[0.08em]">{ui.studio.meeting}</h2>
        <SwitchControl label={ui.studio.meetingEnabled} checked={Boolean(conference.enabled)} disabled={conference.busy}
          onChange={event => conference.setEnabled(event.target.checked)} />
      </div>
      <div className={`${styles.actionsRegion} ${actions.expanded ? styles.actionsExpanded : ""}`} aria-hidden={!actions.visible}>
        <div className={styles.actionsInner}>
          {actions.mounted ? <div className={`${styles.actions} ${actions.visible ? styles.actionsVisible : ""}`} inert={!actions.visible}>
            <div className={`${styles.setting} ${styles.musicSetting}`}>
              <div className={styles.musicDescription}>
                <label htmlFor={musicId}>{ui.studio.meetingMusicOutput}</label>
                <p id={destinationId} className={styles.destination}>{musicOutput === "conference" ? ui.studio.meetingDestination : ui.studio.studioDestination}</p>
              </div>
              <SwitchControl id={musicId} label={ui.studio.meetingMusicOutput} aria-describedby={destinationId}
                checked={musicOutput === "conference"} disabled={conference.busy || !actions.visible}
                onChange={event => conference.setMusicOutput(event.target.checked ? "conference" : "studio")} />
            </div>
            <div className={styles.links}>
              <button type="button" disabled={conference.busy || !actions.visible} onClick={conference.join}
                className={`${styles.openButton} btn-ghost`}>
                {ui.studio.meetingOpen}<Icon name="external-link" />
              </button>
              <div className={styles.guestInvitation}>
                <span className={styles.destination}>{ui.studio.meetingGuestLink}</span>
                <button type="button" disabled={conference.busy || !actions.visible || !conference.inviteUrl} onClick={conference.copyGuestLink}
                  aria-label={ui.studio.meetingCopyLink} title={ui.studio.meetingCopyLink}
                  className={`${styles.guestLink} btn-ghost`}>
                  <span className={styles.guestUrl}>{conference.inviteUrl || ui.studio.meetingGuestLink}</span>
                  <Icon name="copy" />
                </button>
              </div>
            </div>
          </div> : null}
        </div>
      </div>
    </aside>
  );
}
