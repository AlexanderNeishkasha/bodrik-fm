import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { rangeProgress } from "../components/ui/rangeModel.mjs";

test("shared help retains accent border/hover and switches honor reduced motion", () => {
  const help = readFileSync(new URL("../components/ui/HelpTooltip.module.css", import.meta.url), "utf8");
  const toggle = readFileSync(new URL("../components/ui/SwitchControl.module.css", import.meta.url), "utf8");
  assert.match(help, /70%, transparent/);
  assert.match(help, /\.button:hover, \.button:focus-visible/);
  assert.match(toggle, /transition: transform 140ms ease/);
  assert.match(toggle, /translateX\(16px\)/);
  assert.match(toggle, /prefers-reduced-motion: reduce[\s\S]*transition: none/);
});

for (const [name, value, min, max, expected] of [
  ["player units", 0.35, 0, 1, 35],
  ["meeting units", 35, 0, 100, 35],
  ["nonzero minimum", 15, 10, 20, 50],
  ["below lower bound", -5, 0, 100, 0],
  ["above upper bound", 105, 0, 100, 100],
  ["zero duration", 0, 0, 0, 0],
  ["inverted bounds", 5, 10, 0, 0],
  ["missing value", undefined, 0, 100, 0],
  ["nonfinite value", Infinity, 0, 100, 0],
]) {
  test(`shared range progress: ${name}`, () => assert.equal(rangeProgress(value, min, max), expected));
}

/** Compile the real shared controls, including Lucide and CSS Modules, with actual React rendering. */
async function renderer() {
  const result = await build({
    stdin: {
      contents: `import React from "react"; import { renderToStaticMarkup } from "react-dom/server";
        import RangeControl from "./components/ui/RangeControl.js";
        import Button from "./components/ui/Button.js";
        import SwitchControl from "./components/ui/SwitchControl.js";
        import HelpTooltip from "./components/ui/HelpTooltip.js";
        import Icon from "./components/ui/Icon.js";
        import LegacyIcon from "./app/components/Icon.js";
        import NowPlayingVolume from "./app/studio/components/NowPlayingVolume.js";
        import NowPlayingSeek from "./app/studio/components/NowPlayingSeek.js";
        export const volumeElement = NowPlayingVolume;
        export const seekElement = NowPlayingSeek;
        export const element = RangeControl;
        export const render = (kind, props) => renderToStaticMarkup(React.createElement({button:Button,range:RangeControl,switch:SwitchControl,help:HelpTooltip,icon:Icon,legacyIcon:LegacyIcon}[kind], props));`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    },
    bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
    outdir: "unused-shared-ui-output", loader: { ".js": "jsx" }, external: ["react", "react/*", "react-dom", "react-dom/*"],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find(file => file.path.endsWith(".js")).text, { module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url) });
  return evaluated.exports;
}

for (const [name, type, expected] of [["default action", undefined, "button"], ["form submit", "submit", "submit"], ["form reset", "reset", "reset"]]) {
  test(`shared button preserves native semantics: ${name}`, async () => {
    const { render } = await renderer();
    const html = render("button", { type, children: "Action", onClick: () => assert.fail("Must not execute while rendering") });
    assert.ok(html.includes(`type="${expected}"`));
  });
}

test("shared range forwards native handlers unchanged and never executes commands during render", async () => {
  const { element, render } = await renderer();
  const onChange = () => assert.fail("Change must be user-driven");
  const onMouseUp = () => assert.fail("Seek commit must be user-driven");
  const onPointerUp = () => assert.fail("Volume commit must be user-driven");
  const props = { label: "Volume", value: 0.35, min: 0, max: 1, step: 0.01, disabled: true, onChange, onMouseUp, onPointerUp };
  const range = element(props);
  assert.equal(range.props.onChange, onChange);
  assert.equal(range.props.onMouseUp, onMouseUp);
  assert.equal(range.props.onPointerUp, onPointerUp);
  assert.equal(range.props.style["--range-progress"], "35%");
  const html = render("range", props);
  assert.ok(html.includes('type="range"'));
  assert.ok(html.includes('aria-label="Volume"'));
  assert.ok(html.includes('disabled=""'));
  assert.ok(html.includes('max="1"'));
  assert.ok(html.includes('step="0.01"'));
});

for (const name of ["volume", "headphones", "audio-lines", "video", "code", "external-link"]) {
  test(`shared icon supports player and meeting: ${name}`, async () => {
    const { render } = await renderer();
    const html = render("icon", { name, size: 18 });
    assert.ok(html.includes('<svg '));
    assert.ok(html.includes('width="18"'));
    assert.ok(html.includes('aria-hidden="true"'));
    assert.equal(render("legacyIcon", { name, size: 18 }), html);
  });
}

/** Walk unrendered JSX to inspect consumer wiring without executing playback hooks. */
function elements(node) {
  if (!node || typeof node !== "object") return [];
  const children = node.props?.children;
  return [node, ...(Array.isArray(children) ? children : [children]).flatMap(elements)];
}

test("Studio volume retains separate mute/change handlers and fractional units", async () => {
  const { volumeElement } = await renderer();
  const toggle = () => assert.fail("Mute must be user-driven");
  const change = () => assert.fail("Volume must be user-driven");
  const nodes = elements(volumeElement({ label: "Local volume", localVolume: 0.35, localMuted: false, disabled: true, onToggleMute: toggle, onVolumeChange: change }));
  const range = nodes.find(node => node.props?.onChange === change);
  assert.ok(range);
  assert.equal(range.props.value, 0.35);
  assert.equal(range.props.max, "1");
  assert.equal(range.props.step, "0.01");
  assert.equal(range.props.disabled, true);
  assert.ok(nodes.some(node => node.props?.onClick === toggle));
});

test("Studio seek keeps its mouse/touch/keyboard commit contract", async () => {
  const { seekElement } = await renderer();
  const change = () => assert.fail("Seek preview must be user-driven");
  const commit = () => assert.fail("Seek commit must be user-driven");
  const range = elements(seekElement({ seekValue: "12", seekMax: 60, onSeekChange: change, onSeekCommit: commit })).find(node => node.props?.onChange === change);
  assert.ok(range);
  assert.equal(range.props.value, 12);
  assert.equal(range.props.max, 60);
  assert.equal(range.props.onMouseUp, commit);
  assert.equal(range.props.onTouchEnd, commit);
  assert.equal(range.props.onKeyUp, commit);
});

test("shared switch stays controlled and help text is safely escaped and initially hidden", async () => {
  const { render } = await renderer();
  const html = render("switch", { label: "Echo", checked: true, disabled: true, onChange() {} });
  assert.ok(html.includes('role="switch"'));
  assert.ok(html.includes('checked=""'));
  assert.ok(html.includes('disabled=""'));
  const tooltip = render("help", { label: "Help", content: "<script>not markup</script>" });
  assert.ok(tooltip.includes('aria-describedby='));
  assert.ok(tooltip.includes('hidden=""'));
  assert.equal(tooltip.includes('role="tooltip"'), false);
  assert.equal(tooltip.includes('<script>'), false);
});
