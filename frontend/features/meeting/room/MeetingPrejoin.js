"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Mic, MicOff, Video, VideoOff } from "lucide-react";

import { profileAvatarPath } from "../client/protocol.mjs";
import SelectControl from "../../../components/ui/SelectControl";
import { useCaptureState } from "../client/useMeetingState";
import { bindMediaTrack } from "../media/mediaTrackBinding.mjs";
import styles from "./MeetingPrejoin.module.css";

/** localStorage key for the remembered display name. */
const NAME_KEY = "meeting.name";
/** localStorage key for the last uploaded avatar path. */
const AVATAR_KEY = "meeting.avatar";
/** Accepted avatar image types and size (the server enforces the same). */
const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;

/** RU/EN copy. */
const COPY = {
  ru: { title: "Встреча Бодрик FM", name: "Введите имя", join: "Присоединиться к встрече", micOn: "Микрофон включён", micOff: "Микрофон выключен", camOn: "Камера включена", camOff: "Камера выключена", camera: "Камера", microphone: "Микрофон", speaker: "Динамик", avatar: "Загрузить аватар", avatarInvalid: "Нужно изображение PNG, JPEG или WebP до 10 МБ." },
  en: { title: "Bodrik FM meeting", name: "Enter your name", join: "Join meeting", micOn: "Microphone on", micOff: "Microphone off", camOn: "Camera on", camOff: "Camera off", camera: "Camera", microphone: "Microphone", speaker: "Speaker", avatar: "Upload avatar", avatarInvalid: "Use a PNG, JPEG or WebP image up to 10 MB." },
};

/** Remembered name, if storage is available. */
function storedName() {
  try {
    return globalThis.localStorage?.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}

/** Remember a value for next time, ignoring blocked storage. */
function remember(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Private mode: nothing to remember.
  }
}

/** Remembered uploaded avatar path, if any. */
function storedAvatar() {
  try {
    const value = globalThis.localStorage?.getItem(AVATAR_KEY) || "";
    return profileAvatarPath(value, window.location);
  } catch {
    return "";
  }
}

/** Initials for the avatar placeholder. */
function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

/** One device select bound to a capture preference. */
function DeviceSelect({ label, devices, value, onChange, disabled = false }) {
  if (!devices?.length) return null;
  // No saved choice: show the browser default (or the first device) rather than a blank.
  value ||= devices.find((device) => device.value === "default")?.value || devices[0].value;
  return <div className={styles.select}>
    <span>{label}</span>
    <SelectControl label={label} options={devices} value={value || ""} disabled={disabled}
      onChange={(event) => onChange(event.target.value)} />
  </div>;
}

/** Prejoin card: local preview, device choice, name and join. */
export default function MeetingPrejoin({ client, slug, language = "ru", busy = false, onJoin }) {
  const text = COPY[language === "en" ? "en" : "ru"];
  const capture = useCaptureState(client);
  const video = useRef(null);
  const [name, setName] = useState(storedName);
  const [audio, setAudio] = useState(true);
  const [camera, setCamera] = useState(false);
  const [cameraPending, setCameraPending] = useState(false);
  const [avatar] = useState(storedAvatar);
  const [avatarFile, setAvatarFile] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState("");
  const [avatarError, setAvatarError] = useState(false);
  const previewUrl = useRef("");

  // Release the local avatar preview URL when leaving the prejoin.
  useEffect(() => () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
  }, []);

  /** Pick an avatar image; it uploads right after joining. */
  function pickAvatar(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!AVATAR_TYPES.includes(file.type) || file.size > AVATAR_MAX_BYTES) {
      setAvatarError(true);
      return;
    }
    setAvatarError(false);
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = URL.createObjectURL(file);
    setAvatarPreview(previewUrl.current);
    setAvatarFile(file);
  }
  const previewTrack = capture.cameraOn ? client.capture.track("camera") : null;

  // Start microphone preview only; camera acquisition requires an explicit toggle.
  useEffect(() => {
    let cancelled = false;
    client.preview("audio", true).catch(() => {
      if (!cancelled) setAudio(false);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Show the preview track; the capture owner keeps its lifetime.
  useEffect(() => {
    if (!video.current || !previewTrack || typeof MediaStream === "undefined") return undefined;
    return bindMediaTrack(video.current, previewTrack);
  }, [previewTrack]);

  /** Commit the camera choice only after capture succeeds, keeping denied requests collapsed. */
  async function toggleCamera() {
    if (cameraPending) return;
    const next = !camera;
    setCameraPending(true);
    try {
      await client.preview("camera", next);
      setCamera(next);
    } catch {
      setCamera(false);
    } finally {
      setCameraPending(false);
    }
  }

  /** Retry a missing microphone when enabled; preserve a captured track for muted joining. */
  function toggleAudio() {
    const next = !audio;
    setAudio(next);
    if (next && !capture.microphone) client.preview("audio", true).catch(() => setAudio(false));
  }

  /** Change one device preference (restarts the preview). */
  function choose(key, value) {
    client.setCapturePreference(key, value).catch((error) => console.warn("Prejoin device selection failed", key, error));
  }

  /** Join with the current choices. */
  function submit(event) {
    event.preventDefault();
    if (cameraPending) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    remember(NAME_KEY, trimmed);
    onJoin({ name: trimmed, audio, video: camera, avatar, avatarFile });
  }

  return <main className={styles.page}>
    <form className={styles.card} onSubmit={submit}>
      <h1>{text.title} - {slug}</h1>
      <div className={styles.body} data-camera-on={camera}>
        <div className={styles.controls}>
          <div className={styles.toggles}>
            <button type="button" aria-pressed={camera} aria-label={camera ? text.camOn : text.camOff} title={camera ? text.camOn : text.camOff}
              className={camera ? undefined : styles.off} disabled={cameraPending} aria-busy={cameraPending} onClick={toggleCamera}>{camera ? <Video size={22} /> : <VideoOff size={22} />}</button>
            <button type="button" aria-pressed={audio} aria-label={audio ? text.micOn : text.micOff} title={audio ? text.micOn : text.micOff}
              className={audio ? undefined : styles.off} onClick={toggleAudio}>{audio ? <Mic size={22} /> : <MicOff size={22} />}</button>
          </div>
          <DeviceSelect label={text.camera} devices={capture.cameras} value={capture.camera || capture.activeCamera} disabled={!camera} onChange={(value) => choose("camera", value)} />
          <DeviceSelect label={text.microphone} devices={capture.inputDevices} value={capture.inputDevice || capture.activeInputDevice} onChange={(value) => choose("inputDevice", value)} />
          <DeviceSelect label={text.speaker} devices={capture.outputDevices} value={capture.outputDevice} onChange={(value) => choose("outputDevice", value)} />
        </div>
        <div className={styles.previewSlot} aria-hidden={!camera}>
          <div className={styles.preview}>
            {previewTrack ? <video ref={video} autoPlay playsInline muted /> : <div className={styles.placeholder} aria-hidden="true" />}
          </div>
        </div>
      </div>
      <input className={styles.name} aria-label={text.name} placeholder={text.name} value={name} maxLength={32} required
        onChange={(event) => setName(event.target.value)} />
      <div className={styles.avatarRow}>
        <span className={styles.avatar} aria-hidden="true"
          style={avatarPreview || avatar ? { backgroundImage: `url("${avatarPreview || avatar}")` } : undefined}>
          {!avatarPreview && !avatar && initials(name)}
        </span>
        <label className={styles.avatarButton}>
          <Camera size={16} aria-hidden="true" /> {text.avatar}
          <input type="file" accept={AVATAR_TYPES.join(",")} aria-label={text.avatar} onChange={pickAvatar} />
        </label>
      </div>
      {avatarError && <p className={styles.note} role="alert">{text.avatarInvalid}</p>}
      <button className={styles.join} type="submit" disabled={busy || cameraPending || !name.trim()}>{text.join}</button>
    </form>
  </main>;
}
