/** One semantic section table; feature sources remain caller-owned session authorities. */
const sections = Object.freeze({
  tabAudioDevices: [{ view: "audio", source: "audio" }],
  tabVideoDevices: [{ view: "video", source: "video" }],
  tabProfile: [{ view: "profile", source: "profile" }],
  tabRoom: [{ view: "roomInfo", source: "roomInfo" }, { view: "policy", source: "policy", kind: "room" }],
  tabModerator: [{ view: "policy", source: "policy", kind: "moderator" }],
  tabShortcuts: [{ view: "personal", source: "personal", kind: "shortcuts" }],
  tabLanguages: [{ view: "personal", source: "personal", kind: "language" }],
});

/** Resolve authorized shell sections to existing feature sources; missing owners fail closed, never create fallbacks. */
export function resolveSettingsSection(section, sources) {
  const bindings = Object.hasOwn(sections, section) ? sections[section] : null;
  if (!bindings) throw new Error("Unsupported settings section");
  return Object.freeze(bindings.map((binding) => {
    const source = sources?.[binding.source];
    if (typeof source?.getSnapshot !== "function" || typeof source?.subscribe !== "function" ||
      typeof source?.execute !== "function") throw new Error(`Settings source unavailable: ${binding.source}`);
    return Object.freeze({ view: binding.view, source, kind: binding.kind });
  }));
}
