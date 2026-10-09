export const ASSET_PREFIX = process.env.NEXT_PUBLIC_ASSET_PREFIX || "";

export const assetUrl = (path) => {
  if (!ASSET_PREFIX) {
    return path;
  }
  if (path.startsWith("/")) {
    return `${ASSET_PREFIX}${path}`;
  }
  return `${ASSET_PREFIX}/${path}`;
};
