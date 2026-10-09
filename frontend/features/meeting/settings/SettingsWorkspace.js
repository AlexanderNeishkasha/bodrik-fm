"use client";

import AudioSettings from "./AudioSettings";
import VideoSettings from "./VideoSettings";
import ProfileSettings from "./ProfileSettings";
import PolicySettings from "./PolicySettings";
import PersonalSettings from "./PersonalSettings";
import RoomInfo from "./RoomInfo";
import SettingsShell from "./SettingsShell";
import { resolveSettingsSection } from "./settingsWorkspaceBindings.mjs";

/** Ordinary React view constructors, not mounts or owners of capture/signaling resources. */
const views = Object.freeze({
  audio: AudioSettings, video: VideoSettings,
  profile: ProfileSettings, policy: PolicySettings, personal: PersonalSettings,
  roomInfo: RoomInfo,
});

/** Compose every settings section in one React tree using the session's existing sources, without slots or islands. */
export default function SettingsWorkspace({ source, sources, onReady, overlayDocument }) {
  /** Rendering only resolves feature authorities; mount, close and navigation never create or dispose a source. */
  function renderSection(section) {
    return resolveSettingsSection(section, sources).map((binding) => {
      const View = views[binding.view];
      return <View key={`${section}-${binding.view}`} source={binding.source} kind={binding.kind} />;
    });
  }
  return <SettingsShell source={source} renderSection={renderSection} onReady={onReady} overlayDocument={overlayDocument} />;
}
