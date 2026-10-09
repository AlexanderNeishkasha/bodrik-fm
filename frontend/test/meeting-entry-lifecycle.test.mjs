import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INITIAL_MEETING_ENTRY,
  startMeetingEntry,
} from "../features/meeting/runtime/meetingEntryLifecycle.mjs";

/** Flush promise and queueMicrotask continuations. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("fixed export performs no request or publication", async () => {
  let requested = false;
  const states = [];
  const lifecycle = startMeetingEntry({
    pathname: "/meeting",
    publish: (state) => states.push(state),
    resolve: async () => { requested = true; return INITIAL_MEETING_ENTRY; },
  });
  lifecycle.dispose();
  await settle();
  assert.equal(requested, false);
  assert.deepEqual(states, []);
});

test("entry state table publishes bounded admission outcomes", async () => {
  const cases = [
    ["enabled", "/room/table-7", { phase: "prejoin", code: null, slug: "table-7" }],
    ["disabled", "/room/table-7", { phase: "error", code: "disabled", slug: null }],
    ["network", "/room/table-7", new Error("private transport details")],
    ["malformed", "/room/bad%20path", null],
  ];
  for (const [name, pathname, outcome] of cases) {
    const states = [];
    const lifecycle = startMeetingEntry({
      pathname,
      publish: (state) => states.push(state),
      resolve: async () => {
        if (outcome instanceof Error) throw outcome;
        return Object.freeze(outcome);
      },
    });
    await settle();
    lifecycle.dispose();
    assert.deepEqual(states, [name === "network"
      ? { phase: "error", code: "network", slug: null }
      : name === "malformed"
        ? { phase: "error", code: "malformed", slug: null }
        : outcome], name);
  }
});

test("dispose aborts the pending request and fences stale success", async () => {
  const states = [];
  let signal;
  let complete;
  const lifecycle = startMeetingEntry({
    pathname: "/room/table-7",
    publish: (state) => states.push(state),
    resolve: ({ signal: currentSignal }) => {
      signal = currentSignal;
      return new Promise((resolve) => { complete = resolve; });
    },
  });
  lifecycle.dispose();
  lifecycle.dispose();
  assert.equal(signal.aborted, true);
  complete(Object.freeze({ phase: "prejoin", code: null, slug: "table-7" }));
  await settle();
  assert.deepEqual(states, []);
});

test("abort rejection is silent while ordinary failure is bounded", async () => {
  const states = [];
  const lifecycle = startMeetingEntry({
    pathname: "/room/table-7",
    publish: (state) => states.push(state),
    resolve: async () => { throw new DOMException("obsolete", "AbortError"); },
  });
  await settle();
  lifecycle.dispose();
  assert.deepEqual(states, []);
});
