/** Bound authorized byte reads; queue entries and in-flight requests have explicit cancellation owners. */
export function createAttachmentReads(read, limit = 4) {
  const pending = [];
  const active = new Set();
  let disposed = false;

  /** Start waiting reads without exceeding the server's shared request budget. */
  function pump() {
    while (!disposed && active.size < limit && pending.length) {
      const job = pending.shift();
      if (job.controller.signal.aborted) continue;
      active.add(job);
      Promise.resolve().then(() => read(job.id, { signal: job.controller.signal })).then(job.resolve, job.reject).finally(() => {
        active.delete(job); job.cleanup(); pump();
      });
    }
  }

  return {
    /** Queue one read and remove aborted waiters before they consume a transport slot. */
    read(id, { signal } = {}) {
      if (disposed || signal?.aborted || pending.length >= 1000) return Promise.reject(new Error("Attachment read unavailable"));
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const job = { id, controller, resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
        /** Cancel this read; queued requests never reach the server. */
        function abort() {
          controller.abort();
          const index = pending.indexOf(job);
          if (index >= 0) pending.splice(index, 1);
          job.cleanup(); reject(new Error("Attachment read cancelled"));
        }
        signal?.addEventListener("abort", abort, { once: true });
        pending.push(job); pump();
      });
    },
    /** Release queued and active requests when their chat owner ends. */
    dispose() {
      disposed = true;
      for (const job of pending.splice(0)) { job.controller.abort(); job.cleanup(); job.reject(new Error("Attachment read cancelled")); }
      for (const job of active) { job.controller.abort(); job.cleanup(); job.reject(new Error("Attachment read cancelled")); }
    },
  };
}
