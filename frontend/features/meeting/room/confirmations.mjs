/**
 * One pending confirmation at a time for the meeting room (e.g. "ban this person?").
 * `ask` resolves true/false once the room's dialog is answered; a newer request
 * cancels an older unanswered one.
 */
export function createConfirmations() {
  const listeners = new Set();
  let current = null;
  let sequence = 0;

  /** Publish the current request. */
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    /** Ask for confirmation of `{ kind, name }`; resolves with the answer. */
    ask(request) {
      current?.resolve(false);
      return new Promise((resolve) => {
        sequence += 1;
        current = Object.freeze({ ...request, id: sequence, resolve });
        notify();
      });
    },
    /** Answer the current request (true confirms). */
    answer(accepted) {
      const pending = current;
      current = null;
      pending?.resolve(accepted === true);
      notify();
    },
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
