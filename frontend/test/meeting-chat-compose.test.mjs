import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** Compile actual JSX and drive its hooks deterministically; this covers local lifecycle, not real browser event/focus behavior. */
async function harness(submit, { disabled = false } = {}) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../features/meeting/chat/ChatComposer.js", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
    outdir: "unused-chat-compose-test-output", loader: { ".js": "jsx" }, external: ["react", "react/*", "next/image"],
  });
  const composer = { current: null };
  const created = [];
  const revoked = [];
  const slots = [];
  const effects = [];
  let cursor = 0;
  const hooks = {
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = initial; return [slots[id], (value) => { slots[id] = typeof value === "function" ? value(slots[id]) : value; }]; },
    useRef(initial) { const id = cursor++; if (!(id in slots)) slots[id] = { current: initial }; return slots[id]; },
    useImperativeHandle(ref, create) { cursor++; if (ref) ref.current = create(); },
    useEffect(callback) { const id = cursor++; if (!(id in slots)) { slots[id] = true; effects.push(callback()); } },
  };
  const evaluated = { exports: {} };
  const require = createRequire(import.meta.url);
  vm.runInNewContext(result.outputFiles.find((file) => file.path.endsWith(".js")).text, {
    module: evaluated, exports: evaluated.exports, AbortController,
    URL: { createObjectURL: (file) => { const url = URL.createObjectURL(file); created.push(url); return url; }, revokeObjectURL: (url) => { revoked.push(url); URL.revokeObjectURL(url); } }, require: (name) => name === "react" ? { ...require("react"), ...hooks } : require(name),
  });
  /** Render without resetting hook state, just as a local rerender would do. */
  function render() { cursor = 0; return evaluated.exports.default({ submit, language: "en", ref: composer, disabled }); }
  /** Find a JSX node without executing another component's hooks. */
  function find(node, type) {
    if (!node || typeof node !== "object") return null;
    if (node.type === type) return node;
    for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, type); if (found) return found; }
    return null;
  }
  render();
  return { render, find, created, revoked, drop: (files) => composer.current.attachFiles(files), canDrop: () => composer.current.canAttach(), draft: (body) => find(render(), "textarea").props.onChange({ target: { value: body } }),
    send: () => render().props.onSubmit({ preventDefault() {} }),
    dispose: () => effects.forEach((cleanup) => cleanup?.()) };
}

for (const [name, result, clears] of [["local submission", { status: "submitted", clearDraft: true }, true], ["policy rejection", { status: "rejected", clearDraft: false }, false], ["empty", { status: "empty", clearDraft: true }, true], ["missing result", undefined, false]]) {
  test(`actual composer handles ${name} without claiming delivery`, async () => {
    const bodies = [];
    const h = await harness((body) => { bodies.push(body); return result; });
    h.draft("hello");
    await h.send();
    assert.deepEqual(bodies, ["hello"]);
    assert.equal(h.find(h.render(), "textarea").props.value, clears ? "" : "hello");
    const status = h.find(h.render(), "p").props.children;
    if (name === "local submission") assert.equal(status, "");
    if (name === "missing result") assert.ok(status.includes("could not be confirmed"));
    h.dispose();
  });
}
for (const [reason, expected] of [["no_participants", "No other participants"], ["length", "too long"], ["rate_limit", "wait"], ["policy", "moderator"], ["recipient", "no longer available"]]) {
  test(`composer explains local rejection ${reason} without exposing transport details`, async () => {
    const h = await harness(() => ({ status: "rejected", reason, clearDraft: false }));
    h.draft("hello");
    await h.send();
    assert.ok(h.find(h.render(), "p").props.children.includes(expected));
    assert.equal(h.find(h.render(), "textarea").props.value, "hello");
    h.dispose();
  });
}

test("composer serializes pending commands and keeps draft on transport failure without exposing exception contents", async () => {
  let reject;
  let calls = 0;
  const h = await harness(() => { calls++; return new Promise((_, no) => { reject = no; }); });
  h.draft("hello");
  const pending = h.send();
  await h.send();
  assert.equal(calls, 1);
  assert.equal(h.find(h.render(), "textarea").props.disabled, true);
  reject(new Error("synthetic-private-proof"));
  await pending;
  assert.equal(h.find(h.render(), "textarea").props.value, "hello");
  assert.equal(h.find(h.render(), "p").props.children.includes("synthetic-private-proof"), false);
  h.dispose();
});
test("obsolete completion cannot clear an unmounted composer draft", async () => {
  let resolve;
  const h = await harness(() => new Promise((yes) => { resolve = yes; }));
  h.draft("hello");
  const pending = h.send();
  h.dispose();
  resolve({ status: "submitted", clearDraft: true });
  await pending;
  assert.equal(h.find(h.render(), "textarea").props.value, "hello");
});
test("image draft preview is revoked on submit and the actual file/signal reach only the private command", async () => {
  let sent;
  const h = await harness((body, options) => { sent = { body, options }; return { status: "submitted", clearDraft: true }; });
  const file = new File(["x".repeat(100)], "fixture.png", { type: "image/png" });
  h.find(h.render(), "input").props.onChange({ target: { files: [file], value: "fixture" } });
  h.draft("caption");
  assert.equal(h.created.length, 1);
  await h.send();
  assert.equal(sent.options.file, file);
  assert.equal(sent.options.signal.aborted, false);
  assert.equal(sent.body, "caption");
  assert.deepEqual(h.revoked, h.created);
  assert.equal(h.find(h.render(), "img"), null);
  h.dispose();
});
test("invalid image never creates a preview; unmount aborts a pending valid image and releases its URL", async () => {
  let signal;
  let resolve;
  const h = await harness((_, options) => { signal = options.signal; return new Promise((yes) => { resolve = yes; }); });
  h.find(h.render(), "input").props.onChange({ target: { files: [new File(["invalid"], "bad.svg", { type: "image/svg+xml" })], value: "fixture" } });
  assert.equal(h.created.length, 0);
  h.find(h.render(), "input").props.onChange({ target: { files: [new File(["x".repeat(100)], "fixture.png", { type: "image/png" })], value: "fixture" } });
  const pending = h.send();
  h.dispose();
  assert.equal(signal.aborted, true);
  assert.deepEqual(h.revoked, h.created);
  resolve({ status: "submitted", clearDraft: true });
  await pending;
});

test("IME and Shift+Enter do not submit; plain Enter invokes the same command", async () => {
  let calls = 0;
  const h = await harness(() => { calls++; return { status: "submitted", clearDraft: true }; });
  h.draft("hello");
  for (const event of [{ shiftKey: true, isComposing: false }, { shiftKey: false, isComposing: true }]) {
    h.find(h.render(), "textarea").props.onKeyDown({ key: "Enter", shiftKey: event.shiftKey, nativeEvent: { isComposing: event.isComposing } });
  }
  assert.equal(calls, 0);
  h.find(h.render(), "textarea").props.onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {} });
  await Promise.resolve();
  assert.equal(calls, 1);
  h.dispose();
});

test("document draft shows name and size without an image URL and sends through the attachment command", async () => {
  let sent;
  const h = await harness((_, options) => { sent = options.file; return { status: "submitted", clearDraft: true }; });
  const file = new File(["document"], "rules.pdf", { type: "application/pdf" });
  h.find(h.render(), "input").props.onChange({ target: { files: [file], value: "fixture" } });
  assert.equal(h.created.length, 0);
  assert.equal(h.find(h.render(), "img"), null);
  assert.equal(h.find(h.render(), "strong").props.children, "rules.pdf");
  await h.send();
  assert.equal(sent, file);
  assert.equal(h.find(h.render(), "figure"), null);
  h.dispose();
});

test("a submitted file with rejected caption is unstaged while its caption remains editable", async () => {
  const h = await harness(() => ({ status: "rejected", reason: "caption", clearDraft: false, clearAttachment: true }));
  h.find(h.render(), "input").props.onChange({ target: { files: [new File(["doc"], "rules.pdf")], value: "fixture" } });
  h.draft("caption");
  await h.send();
  assert.equal(h.find(h.render(), "figure"), null);
  assert.equal(h.find(h.render(), "textarea").props.value, "caption");
  assert.match(h.find(h.render(), "p").props.children, /File sent/);
  h.dispose();
});

for (const [name, files, accepted] of [
  ["document", [new File(["notes"], "notes.txt")], true],
  ["image", [new File(["image"], "photo.png", { type: "image/png" })], true],
  ["multiple files", [new File(["a"], "a.txt"), new File(["b"], "b.txt")], false],
  ["empty drop", [], false],
  ["invalid filename", [new File(["a"], "../a.txt")], false],
]) test(`chat drop stages ${name} through the existing attachment flow`, async () => {
  let sent;
  const h = await harness((_, options) => { sent = options.file; return { status: "submitted", clearDraft: true }; });
  h.drop(files);
  assert.equal(Boolean(h.find(h.render(), "figure")), accepted);
  await h.send();
  assert.equal(sent, accepted ? files[0] : undefined);
  if (name === "multiple files") assert.match(h.find(h.render(), "p").props.children, /one file at a time/);
  h.dispose();
});

test("disabled and busy composers reject drops without replacing the staged attachment", async () => {
  const disabled = await harness(() => {}, { disabled: true });
  assert.equal(disabled.canDrop(), false);
  disabled.drop([new File(["a"], "a.txt")]);
  assert.equal(disabled.find(disabled.render(), "figure"), null);
  disabled.dispose();
  let resolve;
  let sent;
  const h = await harness((_, options) => { sent = options.file; return new Promise((yes) => { resolve = yes; }); });
  const file = new File(["original"], "original.txt");
  h.drop([file]);
  const pending = h.send();
  assert.equal(h.canDrop(), false);
  h.drop([new File(["replacement"], "replacement.txt")]);
  assert.equal(h.find(h.render(), "strong").props.children, "original.txt");
  resolve({ status: "submitted", clearDraft: true });
  await pending;
  assert.equal(sent, file);
  h.dispose();
});
