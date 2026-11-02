"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Mic, MicOff, Video, VideoOff } from "lucide-react";

import SelectControl from "../../../components/ui/SelectControl";
import { useCaptureState } from "../client/useMeetingState";
import { bindMediaTrack } from "../media/mediaTrackBinding.mjs";
import { forgetProfile, readProfiles } from "../client/profiles.mjs";
import ProfilePicker, { AvatarCircle } from "./ProfilePicker";
import styles from "./MeetingPrejoin.module.css";
import { t } from "../../../app/lang/index.js";

/** Accepted avatar image types and size (the server enforces the same). */
const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;

/** One device select bound to a capture preference, with an optional coupled-route explanation. */
function DeviceSelect({ label, devices, value, onChange, disabled = false, description }) {
  if (!devices?.length) return null;
  // No saved choice: show the browser default (or the first device) rather than a blank.
  value ||= devices.find((device) => device.value === "default")?.value || devices[0].value;
  return <div className={styles.select}>
    <span>{label}</span>
    {description && <small>{description}</small>}
    <SelectControl label={label} options={devices} value={value || ""} disabled={disabled}
      onChange={(event) => onChange(event.target.value)} />
  </div>;
}

/** Prejoin card: local preview, device choice, name and join. */
export default function MeetingPrejoin({ client, slug, busy = false, onJoin }) {
  const text = t("meeting.meetingPrejoin");
  const capture = useCaptureState(client);
  const video = useRef(null);
  const [profiles, setProfiles] = useState(() => readProfiles(globalThis.localStorage, globalThis.location));
  // Most recently used profile first; null opens the new-profile form.
  const [selected, setSelected] = useState(() => profiles[0]?.name ?? null);
  const profile = profiles.find((item) => item.name === selected) || null;
  const [name, setName] = useState("");
  const [audio, setAudio] = useState(true);
  const [camera, setCamera] = useState(false);
  const [cameraPending, setCameraPending] = useState(false);
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
  /** Forget a saved profile; removing the chosen one falls back to the next. */
  function removeProfile(profileName) {
    const next = forgetProfile(globalThis.localStorage, globalThis.location, profileName);
    setProfiles(next);
    if (profileName === selected) setSelected(next[0]?.name ?? null);
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
    // A saved profile joins as is; a new one reuses a same-name profile's picture unless replaced.
    const trimmed = profile ? profile.name : name.trim();
    if (!trimmed) return;
    const avatar = profile ? profile.avatar : avatarFile ? "" : profiles.find((item) => item.name === trimmed)?.avatar || "";
    onJoin({ name: trimmed, audio, video: camera, avatar, avatarFile: profile ? null : avatarFile });
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
          <DeviceSelect label={capture.coupledAudioRouting ? text.audioDevice : text.microphone} description={capture.coupledAudioRouting ? text.routeHint : undefined} devices={capture.inputDevices} value={capture.inputDevice || capture.activeInputDevice} onChange={(value) => choose("inputDevice", value)} />
          {capture.outputSelectionAvailable && <DeviceSelect label={text.speaker} devices={capture.outputDevices} value={capture.outputDevice} onChange={(value) => choose("outputDevice", value)} />}
        </div>
        <div className={styles.previewSlot} aria-hidden={!camera}>
          <div className={styles.preview}>
            {previewTrack ? <video ref={video} autoPlay playsInline muted /> : <div className={styles.placeholder} aria-hidden="true" />}
          </div>
        </div>
      </div>
      {profiles.length > 0 && <ProfilePicker profiles={profiles} selected={profile ? selected : null} text={text}
        onSelect={setSelected} onAdd={() => setSelected(null)} onRemove={removeProfile} />}
      {/* Stays mounted so choosing a profile or "+" can slide it closed or open; inert while closed. */}
      <div className={styles.newProfile} data-open={!profile} inert={!!profile}>
        <div className={styles.newProfileBody}>
          <input className={styles.name} aria-label={text.name} placeholder={text.name} value={name} maxLength={32} required={!profile}
            onChange={(event) => setName(event.target.value)} />
          <div className={styles.avatarRow}>
            <AvatarCircle name={name} src={avatarPreview} />
            <label className={styles.avatarButton}>
              <Camera size={16} aria-hidden="true" /> {text.avatar}
              <input type="file" accept={AVATAR_TYPES.join(",")} aria-label={text.avatar} onChange={pickAvatar} />
            </label>
          </div>
          {avatarError && <p className={styles.note} role="alert">{text.avatarInvalid}</p>}
        </div>
      </div>
      <button className={styles.join} type="submit" disabled={busy || cameraPending || (!profile && !name.trim())}>{text.join}</button>
    </form>
  </main>;
}
