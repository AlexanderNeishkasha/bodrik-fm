/** Avatar edge length in pixels; the server limits avatars to 256 KB. */
const AVATAR_SIZE = 256;

/**
 * Center-crop an image file to a 256×256 WebP, as the legacy meeting did, so any
 * photo fits the server's avatar size limit.
 */
export async function normalizeAvatar(file, { createBitmap = globalThis.createImageBitmap, createCanvas = () => document.createElement("canvas") } = {}) {
  const bitmap = await createBitmap(file);
  let canvas;
  try {
    if (!bitmap.width || !bitmap.height) throw new Error("Image conversion is unavailable");
    canvas = createCanvas();
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable");
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  } finally {
    bitmap.close?.();
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Image conversion failed"))), "image/webp", 0.82);
  });
}
