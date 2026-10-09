export const BASE_CHANCE = 1 / 7000;

const SIZE_MIN = 72;
const SIZE_MAX = 128;
const SIZE_VW = 0.12;
const SPEED_MIN = 160;
const SPEED_MAX = 220;
const EXIT_PADDING = 24;

export const pickSize = () => {
  if (typeof window === "undefined") {
    return SIZE_MAX;
  }
  return Math.round(
    Math.min(SIZE_MAX, Math.max(SIZE_MIN, window.innerWidth * SIZE_VW))
  );
};

export const pickSpeed = () =>
  SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);

export const getPageBounds = () => {
  if (typeof document === "undefined") {
    return { width: 0, height: 0 };
  }
  const doc = document.documentElement;
  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  const width = Math.max(doc.clientWidth, doc.scrollWidth, viewportWidth);
  const height = Math.max(doc.clientHeight, doc.scrollHeight, viewportHeight);
  return { width, height };
};

export const pickEntry = (size) => {
  const { width, height } = getPageBounds();
  const side = Math.floor(Math.random() * 4);

  if (side === 0) {
    return { x: -size - EXIT_PADDING, y: Math.random() * height, side };
  }
  if (side === 1) {
    return { x: width + EXIT_PADDING, y: Math.random() * height, side };
  }
  if (side === 2) {
    return { x: Math.random() * width, y: -size - EXIT_PADDING, side };
  }
  return { x: Math.random() * width, y: height + EXIT_PADDING, side };
};

export const hasExitedPage = ({ x, y, size, width, height }) =>
  x + size < -EXIT_PADDING ||
  x > width + EXIT_PADDING ||
  y + size < -EXIT_PADDING ||
  y > height + EXIT_PADDING;
