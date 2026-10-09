/** Build a stable duplicate-admission key for one browser File-like object. */
export function uploadKey(file) {
  return `${file?.name ?? ""}:${file?.size ?? 0}:${file?.lastModified ?? 0}`;
}

/** Combine a file identity with a caller-provided unique nonce for UI rows. */
export function uploadId(file, nonce) {
  return `${uploadKey(file)}:${nonce}`;
}
