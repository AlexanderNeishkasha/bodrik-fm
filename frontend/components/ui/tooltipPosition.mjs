/** Place text help inside the visual viewport, independently of any clipped or transformed settings panel. */
export function tooltipPosition(anchor, size, viewport, padding = 8, gap = 8) {
  const left = viewport.left + padding;
  const top = viewport.top + padding;
  const right = viewport.left + viewport.width - padding;
  const bottom = viewport.top + viewport.height - padding;
  const maxWidth = Math.max(1, right - left);
  const maxHeight = Math.max(1, bottom - top);
  const width = Math.min(size.width, maxWidth);
  const height = Math.min(size.height, maxHeight);
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - height;
  const desiredY = below + height <= bottom ? below : above;
  return {
    x: Math.max(left, Math.min(anchor.left, right - width)),
    y: Math.max(top, Math.min(desiredY, bottom - height)),
    maxWidth, maxHeight,
  };
}
