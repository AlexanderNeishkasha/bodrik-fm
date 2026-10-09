/**
 * Expand participants into grid cards: one main card per participant (camera or
 * avatar, plus audio) and one separate card per screen share.
 */
export function buildCards(participants, sources) {
  return participants.flatMap((participant) => {
    const own = sources.filter((source) => source.participantId === participant.id);
    const main = { key: participant.id, participant, sources: own.filter((source) => source.kind !== "screen"), screen: false };
    const screens = own.filter((source) => source.kind === "screen" && !source.paused)
      .map((source) => ({ key: `${participant.id}:${source.id}`, participant, sources: [source], screen: true }));
    return [main, ...screens];
  });
}

/**
 * The one focused card, shown large with the others in a strip: the card whose key is
 * the layout's focus, or null (plain grid) when nothing is focused or it went away.
 */
export function focusedCard(cards, focusKey) {
  return (focusKey && cards.find((card) => card.key === focusKey)) || null;
}

/** Keys of screen-share cards that appeared since the previous render. */
export function newScreenKeys(previous, cards) {
  return cards.filter((card) => card.screen && !previous.has(card.key)).map((card) => card.key);
}

/**
 * Largest equal tile size for `count` tiles of `ratio` (height/width) inside a
 * width×height area, as the legacy grid did. Rows are filled left to right and
 * the last partial row is centered by the caller (flex wrap), so 3 tiles become
 * 2 on top and 1 centered below.
 */
export function fitTiles(count, width, height, gap = 12, ratio = 9 / 16) {
  if (count < 1 || width <= 0 || height <= 0) return { width: 0, height: 0, columns: 1 };
  let best = { width: 0, height: 0, columns: 1 };
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const tile = Math.min((width - gap * (columns - 1)) / columns, (height - gap * (rows - 1)) / rows / ratio);
    if (tile > best.width) best = { width: Math.floor(tile), height: Math.floor(tile * ratio), columns };
  }
  return best;
}
