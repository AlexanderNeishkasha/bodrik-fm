/** Build stable occurrence keys for duplicate queue filenames. */
export const buildQueueKeys = (items) => {
  const seen = new Map();
  return items.map((item) => {
    const name = item?.filename ?? item?.id ?? "unknown";
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return `${name}::${count}`;
  });
};

/** Build the authoritative ordering signature used for snapshot reconciliation. */
export const queueSignature = (items) =>
  items.map((item) => item?.filename ?? item?.id ?? "").join("||");

/** Return a copied queue with one validated caller-selected move applied. */
export const reorderQueue = (items, fromIndex, toIndex) => {
  const copy = [...items];
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, moved);
  return copy;
};

/** Return whether a DnD target identifies one rendered queue entry. */
export const isQueueItemTarget = (target) =>
  typeof target === "string" && target.startsWith("queue-item-");

/** Return whether a DnD target accepts queue items. */
export const isQueueDropTarget = (target) =>
  target === "queue-container" || isQueueItemTarget(target);
