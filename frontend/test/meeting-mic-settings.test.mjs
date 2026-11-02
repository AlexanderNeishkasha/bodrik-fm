import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** Compile the actual settings/menu component with React SSR; effects and commands remain browser concerns. */
async function renderer(component = "MicProcessingSettings", viewProps = {}) {
  const result = await build({
    stdin: {
      contents: `import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import View from "./features/meeting/settings/${component}.js"; const command = () => { throw new Error("Commands must not run during render"); }; export const render = snapshot => renderToStaticMarkup(React.createElement(View, { ...${JSON.stringify(viewProps)}, audio: { getSnapshot: () => snapshot, subscribe: () => () => {}, createInputComparison: () => ({ subscribe: () => () => {}, getSnapshot: () => snapshot }), execute: command, setVolume: command }, language: snapshot.language, source: { getSnapshot: () => snapshot, subscribe: () => () => {}, subscribeLevel: () => () => {}, getInputLevel: () => 0, getImage: () => "/images/test-background.jpg", execute: command, setVolume: command }, renderSection: section => React.createElement("p", null, section) }));`,
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
    if (snapshot.error === "unknown_outcome") assert.ok(html.includes("Проверьте настройки"));
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
    assert.ok(html.includes("Профиль"));
    assert.ok(html.includes("&lt;Player&gt;"));
    assert.match(html, /<button[^>]+type="submit"/);
    assert.ok(html.includes("&lt;Browser&gt;"));
    assert.equal(html.includes("<Player>"), false);
    assert.equal(html.includes("Удалить аватар"), snapshot.customAvatar);
    assert.ok(html.includes(snapshot.presenter ? ("Ведущий") : ("Участник")));
    assert.equal(html.includes('role="alert"'), !!snapshot.error);
    if (snapshot.pending) assert.equal((html.match(/disabled=""/g) || []).length, 4);
  });
}

test("personal shortcuts render safely without commands", async () => {
  const render = await renderer("PersonalSettings", { kind: "shortcuts" });
  const html = render({ shortcuts: true, pending: "shortcuts", error: true, entries: [] });
  assert.ok(html.includes('disabled=""'));
  assert.ok(html.includes('role="alert"'));
  assert.equal((html.match(/<kbd>/g) || []).length, 5);
  assert.equal(html.includes("<kbd>K</kbd>"), false);
  assert.equal(html.includes("<kbd>R</kbd>"), false);
  assert.equal(html.includes("Субтитры"), false);
  assert.ok(!html.includes("<kbd>F</kbd>"));
  assert.ok(!html.includes("<kbd>H</kbd>"));
});

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
    assert.ok(html.includes("FPS камеры"));
    // Camera effects: only none, light and strong blur, localized.
    assert.ok(html.includes("Небольшое размытие"));
    assert.equal((html.match(/role="combobox"/g) || []).length >= 3, true);
    assert.equal(html.includes('<Camera>'), false);
    assert.equal(html.includes('aria-label="FPS демонстрации"'), !!snapshot.screenAvailable);
    assert.equal(html.includes('Запросить доступ к камере'), !snapshot.cameras.length || !!snapshot.accessStatus);
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
  ["no output selection RU", "ru", { outputSelectionAvailable: false }],
  ["no PTT/focus", "en", { pttAvailable: false, focusAvailable: false }],
  ["coupled Android RU", "ru", { coupledAudioRouting: true, outputSelectionAvailable: false }],
  ["coupled Android EN", "en", { coupledAudioRouting: true, outputSelectionAvailable: false }],
  ["missing microphone", "en", { inputDevices: [], inputDevice: "" }],
]) {
  test(`complete shared audio tab renders safely: ${name}`, async () => {
    const render = await renderer("AudioSettings");
    const snapshot = { language, inputDevices: [{ value: "mic", label: "<Mic>" }], outputDevices: [{ value: "speaker", label: "Speakers" }], inputDevice: "mic", outputDevice: "speaker", enhancedAvailable: true, microphoneAvailable: true, processingAvailable: true, noiseMode: "browser", pttAvailable: true, focusAvailable: true, pushToTalk: false, speakerFocus: false, speakerVolume: 50, volumeAvailable: true, outputSelectionAvailable: true, ...options };
    const html = render(snapshot);
    assert.ok(html.includes("Шумоподавление"));
    assert.ok(html.includes('role="meter"'));
    assert.ok(html.includes("Браузерное"));
    assert.equal(html.includes('aria-label="Динамики"'), snapshot.outputSelectionAvailable);
    assert.equal(html.includes("В этом браузере нельзя выбрать динамики"), !snapshot.outputSelectionAvailable && !snapshot.coupledAudioRouting);
    if (snapshot.coupledAudioRouting) {
      assert.ok(html.includes("Аудиоустройство"));
      assert.ok(html.includes("Микрофон и динамики переключатся вместе."));
      const outputLabel = "Динамики";
      const testLabel = "Проверить";
      assert.ok(html.includes(outputLabel), "the output section retains its heading");
      assert.ok(html.indexOf(outputLabel) < html.indexOf(testLabel), "the heading explains the test button");
      assert.equal(html.includes(`aria-label="${outputLabel}"`), false, "no independent output select in coupled mode");
    }
    assert.equal((html.match(/role="switch"/g) || []).length, 2 + Number(snapshot.pttAvailable) + Number(snapshot.focusAvailable));
    if (snapshot.pttAvailable) {
      const ptt = "Push-to-talk";
      const gain = "Выравнивание громкости";
      const output = "Динамики";
      assert.ok(html.indexOf(gain) < html.indexOf(ptt), "PTT follows microphone gain");
      if (!snapshot.coupledAudioRouting) assert.ok(html.indexOf(ptt) < html.indexOf(output), "PTT precedes output settings");
      assert.match(html, new RegExp(`<input[^>]+aria-label="${ptt}"[^>]*>`));
    }
    assert.equal(html.includes('<Mic>'), false);
    assert.ok(html.includes('type="range"'));
    assert.equal(html.includes('role="status"'), false);
    if (snapshot.pending) assert.equal((html.match(/disabled=""/g) || []).length, 8);
    assert.ok(html.includes("Проверить"));
  });
}

for (const [name, language, fields] of [
  ["RU", "ru", {}], ["EN", "en", {}], ["enabled", "ru", { pushToTalk: true }],
  ["pending", "en", { pending: "pushToTalk" }], ["unavailable", "en", { pttAvailable: false }],
  ["coupled routes", "ru", { coupledAudioRouting: true, outputSelectionAvailable: false,
    inputDevices: [{ value: "speakerphone", label: "Speakerphone" }, { value: "bluetooth", label: "Bluetooth headset" }] }],
]) {
  test(`quick microphone menu places controlled PTT below gain: ${name}`, async () => {
    const render = await renderer("../room/MicQuickMenu");
    const snapshot = { language, inputDevices: [], outputDevices: [{ value: "default", label: "Default" }],
      outputSelectionAvailable: true, noiseMode: "browser", echoCancellation: true, autoGainControl: true,
      pttAvailable: true, pushToTalk: false, speakerVolume: 50, ...fields };
    const html = render(snapshot);
    const ptt = "Push-to-talk";
    assert.equal(html.includes(ptt), snapshot.pttAvailable);
    if (snapshot.pttAvailable) {
      const gain = "Выравнивание громкости";
      const output = "Динамики";
      assert.ok(html.indexOf(gain) < html.indexOf(ptt));
      if (!snapshot.coupledAudioRouting) assert.ok(html.indexOf(ptt) < html.indexOf(output));
      const input = html.match(new RegExp(`<input[^>]+aria-label="${ptt}"[^>]*>`))?.[0];
      assert.ok(input);
      assert.equal(input.includes('checked=""'), snapshot.pushToTalk);
      assert.equal(input.includes('disabled=""'), Boolean(snapshot.pending));
    }
    assert.equal(html.includes('role="tooltip"'), false);
    if (snapshot.coupledAudioRouting) {
      assert.ok(html.includes('aria-label="Аудиоустройство"'));
      assert.ok(html.includes("Speakerphone") && html.includes("Bluetooth headset"));
      assert.equal(html.includes('role="meter"'), false, "routes have no background device-level probes");
      assert.equal(html.includes('aria-label="Устройство вывода"'), false);
    }
  });
}

for (const component of ["AudioSettings", "../room/MicQuickMenu"]) {
  for (const [name, available, selected] of [
    ["browser only", false, "browser"], ["RNNoise", true, "rnnoise"],
    ["maximum", true, "deepfilternet"],
  ]) {
    test(`neural suppression choices in ${component}: ${name}`, async () => {
      const render = await renderer(component);
      const html = render({ inputDevices: [], outputDevices: [], processingAvailable: true,
        microphoneAvailable: true, enhancedAvailable: available, noiseMode: selected, speakerVolume: 50 });
      const label = { browser: "Браузерное", rnnoise: "Умное", deepfilternet: "Студийное" }[selected];
      assert.match(html, new RegExp(`role="combobox"[^>]*aria-label="Шумоподавление"[^>]*><span[^>]*>${label}</span>`));
      assert.equal(html.includes('role="listbox"'), false, "choices open only after user interaction");
    });
  }
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
    assert.ok(html.includes("Громкость встречи"));
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
  ["English input ignored", { language: "en", echoCancellation: false, autoGainControl: true }, "Эхоподавление"],
  ["unknown locale", { language: "unknown" }, "Эхоподавление"],
  ["pending", { language: "en", pending: "echoCancellation" }, "Эхоподавление"],
  ["failure", { language: "en", error: true }, "Не удалось изменить настройки звука"],
  ["effective mismatch", { language: "en", echoCancellation: false, effectiveEchoCancellation: true }, "Фактически сейчас: включено"],
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
