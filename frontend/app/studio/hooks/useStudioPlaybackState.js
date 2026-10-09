import useStudioAudio from "./useStudioAudio";
import useStudioState from "./useStudioState";
import { isConferenceMusicActive } from "../lib/meetingVolumeControls.mjs";

/** Keep room playback authoritative while controlling this Studio's local audio. */
export default function useStudioPlaybackState({ apiBase, asUserId, mediaBase, isAuthed, roomKey }) {
  const { state } = useStudioState({ apiBase, asUserId, isAuthed, roomKey });
  const forceMuted = isConferenceMusicActive(state);
  const audio = useStudioAudio({ apiBase, mediaBase, isAuthed, state, forceMuted });
  return { ...audio, state };
}
