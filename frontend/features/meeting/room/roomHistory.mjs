/**
 * Browser history for the meeting room: joining adds one same-URL entry, so Back (or a
 * swipe back) leaves the room for the prejoin screen instead of leaving the page.
 * Panel entries (`meetingPanel`, see MeetingRoom) sit above it and only close panels.
 */

/** Whether a history state belongs to the joined room or one of its panels. */
function inRoomState(state) {
  return Boolean(state?.meetingRoom || state?.meetingPanel);
}

/** Add the room entry once; a reload keeps it, so it is not pushed twice. */
export function enterRoomHistory(history) {
  if (!history || inRoomState(history.state)) return;
  history.pushState({ meetingRoom: true }, "");
}

/**
 * Call `onBack` when navigation pops below the room entry (back to prejoin);
 * popping a panel entry onto the room entry is ignored.
 * @returns {() => void} removes the listener
 */
export function watchRoomBack(target, onBack) {
  if (!target) return () => {};
  const listener = (event) => {
    if (!inRoomState(event.state)) onBack();
  };
  target.addEventListener("popstate", listener);
  return () => target.removeEventListener("popstate", listener);
}
