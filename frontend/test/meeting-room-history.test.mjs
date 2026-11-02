import assert from "node:assert/strict";
import test from "node:test";

import { enterRoomHistory, watchRoomBack } from "../features/meeting/room/roomHistory.mjs";

/** History double recording pushed states. */
function fakeHistory(state = null) {
  const pushed = [];
  return { pushed, state, pushState(next) { pushed.push(next); this.state = next; } };
}

const enterCases = [
  { name: "fresh page pushes the room entry", state: null, pushed: [{ meetingRoom: true }] },
  { name: "router state without a room entry pushes", state: { __NA: true }, pushed: [{ meetingRoom: true }] },
  { name: "reloaded room entry is not pushed twice", state: { meetingRoom: true }, pushed: [] },
  { name: "open panel entry is not covered", state: { meetingPanel: true }, pushed: [] },
];

for (const item of enterCases) {
  test(`enterRoomHistory: ${item.name}`, () => {
    const history = fakeHistory(item.state);
    enterRoomHistory(history);
    enterRoomHistory(history);
    assert.deepEqual(history.pushed, item.pushed);
  });
}

const backCases = [
  { name: "popping to the prejoin entry returns to prejoin", state: null, back: 1 },
  { name: "popping to a router entry returns to prejoin", state: { __NA: true }, back: 1 },
  { name: "closing a panel onto the room entry stays in the room", state: { meetingRoom: true }, back: 0 },
  { name: "Forward onto a panel entry stays in the room", state: { meetingPanel: true }, back: 0 },
];

for (const item of backCases) {
  test(`watchRoomBack: ${item.name}`, () => {
    const target = new EventTarget();
    let back = 0;
    const stop = watchRoomBack(target, () => back++);
    target.dispatchEvent(Object.assign(new Event("popstate"), { state: item.state }));
    assert.equal(back, item.back);
    stop();
    target.dispatchEvent(Object.assign(new Event("popstate"), { state: null }));
    assert.equal(back, item.back, "no calls after cleanup");
  });
}
