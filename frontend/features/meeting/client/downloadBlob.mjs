/** Save a blob as a download through one temporary object URL. */
export function downloadBlob(blob, fileName, documentRef = globalThis.document) {
  const url = URL.createObjectURL(blob);
  const link = documentRef.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  documentRef.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
