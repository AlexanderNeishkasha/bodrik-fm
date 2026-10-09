import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** Compile the actual settings component with real React SSR; effects/commands remain browser concerns. */
async function renderer(component = "MicProcessingSettings", viewProps = {}) {
  const result = await build({
    stdin: {
      contents: `import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import View from "./features/meeting/settings/${component}.js"; const command = () => { throw new Error("Commands must not run during render"); }; export const render = snapshot => renderToStaticMarkup(React.createElement(View, { ...${JSON.stringify(viewProps)}, source: { getSnapshot: () => snapshot, subscribe: () => () => {}, subscribeLevel: () => () => {}, getInputLevel: () => 0, getImage: () => "/images/test-background.jpg", execute: command, setVolume: command }, renderSection: section => React.createElement("p", null, section) }));`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    },
    bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
    outdir: "unused-mic-settings-test-output", loader: { ".js": "jsx" },
    define: { "process.env.NEXT_PUBLIC_ASSET_PREFIX": JSON.stringify("") },
    external: ["react", "react/*", "react-dom", "react-dom/*", "next/image"],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find(file => file.path.endsWith(".js")).text, { module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url) });
  return evaluated.exports.render;
}

for (const [name, language, fields] of [["RU peer statuses", "ru", {}], ["EN unavailable", "en", { available: false }],
  ["refresh pending", "en", { pending: true }], ["snapshot failure", "en", { error: "unavailable" }]]) {
  test(`participants render read-only escaped observations without requests: ${name}`, async () => {
    const render = await renderer("../participants/ParticipantsPanel");
    const html = render({ language, available: true, pending: false, hidden: [], volumes: {}, peers: [
      { id: "peer-1", name: '<img src=x onerror="unsafe">', presenter: true, audio: false },
    ], ...fields });
    assert.ok(html.includes("&lt;img"));
    assert.equal(html.includes('<img src="x"'), false);
    assert.equal(html.includes('role="alert"'), !!fields.error);
    assert.equal(html.includes('disabled=""'), !!fields.pending || fields.available === false);
    assert.equal(html.includes("never-expose"), false);
  });
}

for (const [name, language, available, selected] of [
  ["RU settings", "ru", ["tabProfile", "tabVideoDevices"], "tabProfile"],
  ["EN selected video", "en", ["tabProfile", "tabVideoDevices"], "tabVideoDevices"],
  ["empty capabilities", "en", [], null],
]) {
  test(`settings shell renders accessible retained navigation without domain commands: ${name}`, async () => {
    const render = await renderer("SettingsShell");
    const html = render({ open: false, language, available, selected });
    assert.ok(html.includes("<dialog"));
    assert.ok(html.includes('role="tablist"'));
    assert.equal((html.match(/role="tab"/g) || []).length, available.length);
    assert.equal((html.match(/role="tabpanel"/g) || []).length, available.length);
    assert.equal((html.match(/aria-selected="true"/g) || []).length, selected ? 1 : 0);
    assert.equal((html.match(/tabindex="0"/g) || []).length, selected ? 1 : 0);
    assert.equal((html.match(/hidden=""/g) || []).length, available.length - (selected ? 1 : 0));
  });
}

for (const [name, kind, language, fields] of [
  ["room RU", "room", "ru", {}], ["moderator EN", "moderator", "en", {}],
  ["pending receipt", "room", "en", { pending: "lobby" }],
  ["guest", "moderator", "en", { capabilities: { presenter: false, moderator: true } }],
  ["unknown result", "room", "en", { error: "unknown_outcome" }],
  ["persistence failed", "room", "en", { error: "storage" }],
]) {
  test(`policy view is controlled and side-effect-free: ${name}`, async () => {
    const render = await renderer("PolicySettings", { kind });
    const snapshot = { language, available: true, state: {
      config: { isLocked: false, isLobbyEnabled: false, isJoinLocked: false },
      moderator: { video_start_privacy: true, audio_start_muted: false, video_start_hidden: false },
    }, capabilities: { presenter: true, lobby: true, joinLock: true, password: true, moderator: true }, ...fields };
    const html = render(snapshot);
    // Presenter-only settings are hidden entirely for other participants.
    if (!snapshot.capabilities.presenter) {
      assert.equal(html, "");
      return;
    }
    assert.equal(html.includes('role="alert"'), !!snapshot.error);
    const switches = html.match(/<input[^>]*role="switch"[^>]*>/g) || [];
    assert.ok(switches.length > 0);
    assert.equal(switches.every((input) => input.includes('disabled=""')), !!snapshot.pending || !snapshot.capabilities.presenter);
    assert.equal(html.includes('type="password"'), kind === "room");
    assert.equal(html.includes("Start recording"), false);
    assert.equal(html.includes("privacy mode"), false);
    assert.equal(html.includes("режиме приватности"), false);
    if (snapshot.error === "unknown_outcome") assert.ok(html.includes("Check room state"));
  });
}

for (const [name, language, fields] of [
  ["Russian identity", "ru", {}],
  ["English identity", "en", {}],
  ["pending upload", "en", { pending: "avatar" }],
  ["upload rejection", "en", { error: true }],
  ["default avatar", "en", { customAvatar: false }],
  ["presenter role", "en", { presenter: true }],
]) {
  test(`profile settings render safely without browser I/O: ${name}`, async () => {
    const render = await renderer("ProfileSettings");
    const snapshot = { language, name: "<Player>", avatar: "/uploads/avatars/test.webp", customAvatar: true,
      presenter: false, details: [{ key: "browser", values: ["<Browser>"] }], ...fields };
    const html = render(snapshot);
    assert.ok(html.includes(language === "ru" ? "Ваш профиль" : "Your profile"));
    assert.ok(html.includes("&lt;Player&gt;"));
    assert.match(html, /<button[^>]+type="submit"/);
    assert.ok(html.includes("&lt;Browser&gt;"));
    assert.equal(html.includes("<Player>"), false);
    assert.equal(html.includes("Remove avatar"), snapshot.customAvatar && language === "en");
    assert.ok(html.includes(snapshot.presenter ? (language === "ru" ? "Ведущий" : "Presenter") : (language === "ru" ? "Участник" : "Participant")));
    assert.equal(html.includes('role="alert"'), !!snapshot.error);
    if (snapshot.pending) assert.equal((html.match(/disabled=""/g) || []).length, 4);
  });
}

for (const kind of ["shortcuts", "language"]) {
  for (const language of ["ru", "en"]) {
    test(`personal settings render safely without commands: ${kind}/${language}`, async () => {
      const render = await renderer("PersonalSettings", { kind });
      const html = render({ language, shortcuts: true, pending: "language", error: true, entries: [
        { key: "participantView", value: "grid", options: [{ value: "grid", label: "<Grid>" }] },
      ] });
      assert.ok(html.includes('disabled=""'));
      assert.ok(html.includes('role="alert"'));
      assert.equal(html.includes("<Grid>"), false);
      if (kind === "shortcuts") {
        assert.equal((html.match(/<kbd>/g) || []).length, 5);
        assert.equal(html.includes("<kbd>K</kbd>"), false);
        assert.equal(html.includes("<kbd>R</kbd>"), false);
        assert.equal(html.includes("Captions") || html.includes("Субтитры"), false);
        assert.ok(!html.includes("<kbd>F</kbd>"));
        assert.ok(!html.includes("<kbd>H</kbd>"));
      }
      if (kind === "language") assert.ok(html.includes('role="combobox"'));
    });
  }
}

for (const [name, language, fields] of [
  ["Russian camera controls", "ru", {}],
  ["English camera controls", "en", {}],
  ["permission recovery", "en", { cameras: [], camera: "", accessStatus: "No cameras found" }],
  ["screen controls", "en", { screenAvailable: true, screenHintAvailable: true }],
  ["camera restricted", "en", { cameraAllowed: false }],
]) {
  test(`video tab renders safely: ${name}`, async () => {
    const render = await renderer("VideoSettings");
    const options = [{ value: "default", label: "Default" }];
    const snapshot = { language, cameras: [{ value: "camera0", label: "<Camera>" }], camera: "camera0", qualities: options, quality: "default", frameRates: options, frameRate: "default", screenQualities: options, screenQuality: "default", screenFrameRates: options, screenFrameRate: "default", screenHints: options, screenHint: "default", cameraAllowed: true,
      effects: [{ value: "off" }, { value: "low" }, { value: "high" }], effect: "low", effectSupported: true, ...fields };
    const html = render(snapshot);
    assert.ok(html.includes(language === "ru" ? "FPS камеры" : "Camera FPS"));
    // Camera effects: only none, light and strong blur, localized.
    assert.ok(html.includes(language === "ru" ? "Небольшое размытие" : "Light blur"));
    assert.equal((html.match(/role="combobox"/g) || []).length >= 3, true);
    assert.equal(html.includes('<Camera>'), false);
    assert.equal(html.includes('aria-label="Screen FPS"'), !!snapshot.screenAvailable && language === "en");
    assert.equal(html.includes('Request camera access'), !snapshot.cameras.length || !!snapshot.accessStatus);
    // Camera, effect, quality and FPS are disabled when the camera is restricted.
    if (!snapshot.cameraAllowed) assert.equal((html.match(/disabled=""/g) || []).length, 4);
  });
}

for (const [name, language, options] of [
  ["Russian full tab", "ru", {}],
  ["English full tab", "en", {}],
  ["busy controls", "en", { pending: "noiseMode" }],
  ["no enhanced capability", "en", { enhancedAvailable: false }],
  ["no output selection", "en", { outputSelectionAvailable: false }],
  ["no PTT/focus", "en", { pttAvailable: false, focusAvailable: false }],
  ["missing microphone", "en", { inputDevices: [], inputDevice: "" }],
]) {
  test(`complete shared audio tab renders safely: ${name}`, async () => {
    const render = await renderer("AudioSettings");
    const snapshot = { language, inputDevices: [{ value: "mic", label: "<Mic>" }], outputDevices: [{ value: "speaker", label: "Speakers" }], inputDevice: "mic", outputDevice: "speaker", enhancedAvailable: true, microphoneAvailable: true, processingAvailable: true, noiseMode: "browser", pttAvailable: true, focusAvailable: true, pushToTalk: false, speakerFocus: false, speakerVolume: 50, volumeAvailable: true, outputSelectionAvailable: true, ...options };
    const html = render(snapshot);
    assert.ok(html.includes(language === "ru" ? "Шумоподавление" : "Noise suppression"));
    assert.ok(html.includes('role="meter"'));
    assert.ok(html.includes(language === "ru" ? "Базовое" : "Basic"));
    assert.equal(html.includes('aria-label="Speaker"'), language === "en" && snapshot.outputSelectionAvailable);
    assert.equal((html.match(/role="switch"/g) || []).length, 2 + Number(snapshot.pttAvailable) + Number(snapshot.focusAvailable));
    assert.equal(html.includes('<Mic>'), false);
    assert.ok(html.includes('type="range"'));
    assert.equal(html.includes('role="status"'), false);
    if (snapshot.pending) assert.equal((html.match(/disabled=""/g) || []).length, 8);
    assert.ok(html.includes(language === "ru" ? "Проверить" : "Test"));
  });
}

for (const [name, language, value, available, error] of [
  ["Russian minimum", "ru", 0, true, false],
  ["English maximum", "en", 100, true, false],
  ["unavailable capability", "en", 50, false, false],
  ["persistence error", "en", 80, true, true],
]) {
  test(`shared output slider renders without touching audio: ${name}`, async () => {
    const render = await renderer("SpeakerVolumeSettings");
    const html = render({ language, speakerVolume: value, volumeAvailable: available, volumeError: error });
    assert.ok(html.includes(language === "ru" ? "Громкость динамика" : "Speaker volume"));
    assert.ok(html.includes(`value="${value}"`));
    assert.ok(html.includes('type="range"'));
    assert.ok(html.includes('min="0"'));
    assert.ok(html.includes('max="100"'));
    assert.ok(html.includes(`${value}%`));
    assert.equal(html.includes('disabled=""'), !available);
    assert.equal(html.includes('role="alert"'), error);
  });
}

for (const [name, snapshot, expected] of [
  ["Russian ready", { language: "ru", echoCancellation: true, autoGainControl: false }, "Эхоподавление"],
  ["English ready", { language: "en", echoCancellation: false, autoGainControl: true }, "Echo cancellation"],
  ["unknown locale", { language: "unknown" }, "Эхоподавление"],
  ["pending", { language: "en", pending: "echoCancellation" }, "Echo cancellation"],
  ["failure", { language: "en", error: true }, "Could not update audio settings"],
  ["effective mismatch", { language: "en", echoCancellation: false, effectiveEchoCancellation: true }, "Currently applied: on."],
]) {
  test(`shared microphone settings render safely without executing commands: ${name}`, async () => {
    const render = await renderer();
    const html = render(snapshot);
    assert.ok(html.includes(expected));
    assert.equal((html.match(/role="switch"/g) || []).length, 2);
    assert.equal((html.match(/ disabled=""/g) || []).length, snapshot.pending ? 2 : 0);
    assert.equal(html.includes('role="alert"'), !!snapshot.error);
    assert.equal(html.includes('role="status"'), false);
    assert.equal(html.includes("Applying setting"), false);
    assert.equal((html.match(/role="tooltip"/g) || []).length, 0);
    assert.equal((html.match(/<svg /g) || []).length, 2);
    assert.equal((html.match(/aria-describedby=/g) || []).length, 2);
  });
}
