"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EyeOff, Maximize2, MessageSquare, Minimize2, MoreVertical, PictureInPicture2, Volume2 } from "lucide-react";

import styles from "./MeetingGrid.module.css";
import CardMenu from "./CardMenu";

/** RU/EN card action labels. */
export const CARD_COPY = {
  ru: { focus: "В фокус", unfocus: "Вернуть сетку", fullscreen: "Во весь экран", exitFullscreen: "Выйти из полноэкранного режима", pip: "Картинка в картинке", more: "Действия", volume: "Громкость", privateChat: "Личное сообщение", hide: "Скрыть из сетки", mute: "Выключить микрофон", hideCamera: "Выключить камеру", stopScreen: "Остановить демонстрацию", makePresenter: "Назначить ведущим", removePresenter: "Снять роль ведущего", eject: "Выгнать", ban: "Забанить на 24 часа" },
  en: { focus: "Focus", unfocus: "Back to grid", fullscreen: "Full screen", exitFullscreen: "Exit full screen", pip: "Picture in picture", more: "Actions", volume: "Volume", privateChat: "Private message", hide: "Hide from grid", mute: "Mute microphone", hideCamera: "Turn off camera", stopScreen: "Stop screen share", makePresenter: "Make presenter", removePresenter: "Remove presenter role", eject: "Kick", ban: "Ban for 24 hours" },
};

/** Current fullscreen element, kept in sync with the document. */
function subscribeFullscreen(listener) {
  document.addEventListener("fullscreenchange", listener);
  return () => document.removeEventListener("fullscreenchange", listener);
}

/** Hover actions and the context menu for one card. */
export default function CardActions({ card, layout, participants, selfId, presenter, text }) {
  const { participant } = card;
  const ref = useRef(null);
  const menuRef = useRef(null);
  const [menu, setMenu] = useState(false);
  const fullscreenKey = useSyncExternalStore(subscribeFullscreen, () => document.fullscreenElement?.getAttribute("data-card-key") ?? "", () => "");
  const volumes = useSyncExternalStore(layout.subscribe, () => layout.getSnapshot().volumes, () => layout.getSnapshot().volumes);
  const article = () => ref.current?.closest("article");
  const isFullscreen = fullscreenKey === card.key;
  const remote = participant.id !== selfId;
  const human = remote && !participant.bot && !card.screen;

  // Close the menu on outside click or Escape.
  useEffect(() => {
    if (!menu) return undefined;
    const outside = (event) => {
      if (!ref.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setMenu(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);

  /** Enter or leave fullscreen for this card. */
  function toggleFullscreen() {
    if (isFullscreen) document.exitFullscreen?.().catch(() => {});
    else article()?.requestFullscreen?.().catch(() => {});
  }

  /** Picture-in-picture for the card's video. */
  function pip() {
    article()?.querySelector("video")?.requestPictureInPicture?.().catch(() => {});
  }

  /** Run one participants command and close the menu. */
  function run(command) {
    setMenu(false);
    participants?.execute(command).catch((error) => console.warn("Card action not confirmed:", error?.code || error?.message));
  }

  return <div ref={ref} className={`${styles.actions} ${menu || isFullscreen ? styles.actionsOpen : ""}`}>
    {(card.screen || participant.video || isFullscreen) && <button type="button" aria-label={isFullscreen ? text.exitFullscreen : text.fullscreen} title={isFullscreen ? text.exitFullscreen : text.fullscreen}
      onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>}
    {(card.screen || participant.video) && <button type="button" aria-label={text.pip} title={text.pip} onClick={pip}><PictureInPicture2 size={18} /></button>}
    {remote && !card.screen && <button type="button" aria-haspopup="menu" aria-expanded={menu} aria-label={text.more} title={text.more}
      onClick={() => setMenu(!menu)}><MoreVertical size={18} /></button>}
    {menu && <CardMenu anchor={ref} menuRef={menuRef} text={text.more}>
      <label className={styles.volume}>
        <Volume2 size={16} aria-hidden="true" />
        <span className={styles.srOnly}>{text.volume}</span>
        <input type="range" min={0} max={100} step={1} aria-label={text.volume} value={volumes[participant.id] ?? 100}
          onChange={(event) => layout.setVolume(participant.id, Number(event.target.value))} />
        <span>{volumes[participant.id] ?? 100}%</span>
      </label>
      {human && <button type="button" role="menuitem" onClick={() => run({ type: "chat", targetId: participant.id })}><MessageSquare size={16} /> {text.privateChat}</button>}
      <button type="button" role="menuitem" onClick={() => run({ type: "visibility", targetId: participant.id, hidden: true })}><EyeOff size={16} /> {text.hide}</button>
      {human && presenter && <>
        <hr />
        {participant.audio && <button type="button" role="menuitem" onClick={() => run({ type: "moderate", targetId: participant.id, action: "mute" })}>{text.mute}</button>}
        {participant.video && <button type="button" role="menuitem" onClick={() => run({ type: "moderate", targetId: participant.id, action: "hide" })}>{text.hideCamera}</button>}
        {participant.screen && <button type="button" role="menuitem" onClick={() => run({ type: "moderate", targetId: participant.id, action: "stop" })}>{text.stopScreen}</button>}
        <button type="button" role="menuitem" onClick={() => run({ type: "role", targetId: participant.id, presenter: !participant.presenter })}>
          {participant.presenter ? text.removePresenter : text.makePresenter}</button>
        <button type="button" role="menuitem" className={styles.danger} onClick={() => run({ type: "moderate", targetId: participant.id, action: "eject" })}>{text.eject}</button>
        <button type="button" role="menuitem" className={styles.danger} onClick={() => run({ type: "moderate", targetId: participant.id, action: "ban" })}>{text.ban}</button>
      </>}
    </CardMenu>}
  </div>;
}
