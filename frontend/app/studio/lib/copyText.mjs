/** Copy text through the secure Clipboard API or a user-gesture legacy fallback. */
export async function copyText(value, {
  clipboard = globalThis.navigator?.clipboard,
  documentRef = globalThis.document,
} = {}) {
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {}
  }
  if (!documentRef?.body || typeof documentRef.execCommand !== "function") return false;

  const field = documentRef.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  field.style.pointerEvents = "none";
  documentRef.body.appendChild(field);
  try {
    field.focus();
    field.select();
    return documentRef.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
