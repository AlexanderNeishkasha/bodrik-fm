/** Keep only departing presentation snapshots; current items remain authoritative. */
export function retainLibraryExits(exits, previous, current) {
  const currentKeys = new Set(current.map(item => item.key));
  const retained = new Map(exits.filter(item => !currentKeys.has(item.key)).map(item => [item.key, item]));
  const positions = new Map(libraryPresenceItems(previous, exits).map((item, index) => [item.key, index]));
  previous.forEach(item => {
    if (!currentKeys.has(item.key)) retained.set(item.key, { ...item, index: positions.get(item.key) });
  });
  const next = [...retained.values()];
  return next.length === exits.length && next.every((item, index) => item === exits[index]) ? exits : next;
}

/** Insert retiring snapshots near their old positions without changing current item order. */
export function libraryPresenceItems(current, exits) {
  const keys = new Set(current.map(item => item.key));
  const items = current.map(item => ({ ...item, isExiting: false }));
  for (const item of exits.filter(item => !keys.has(item.key)).toSorted((a, b) => a.index - b.index)) {
    items.splice(Math.min(item.index, items.length), 0, { ...item, isExiting: true });
  }
  return items;
}
