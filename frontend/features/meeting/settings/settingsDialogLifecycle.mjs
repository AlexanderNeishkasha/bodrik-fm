/** Keep a native settings modal subordinate to retained external Swal overlays, without a second visibility store. */
export function bindSettingsDialog(dialog, { getSnapshot, close, overlayDocument }) {
  const document = dialog.ownerDocument;
  const documents = [...new Set([document, overlayDocument].filter(Boolean))];
  let returnFocus = null;
  let disposed = false;
  let backdropPressed = false;
  /** Temporary retained dialogs keep interaction priority even when settings moved to the parent document. */
  function nested() { return documents.some((owner) => owner.body.classList.contains("swal2-shown")); }
  /** Follow composed focus through feature ShadowRoots, preserving the actual opener rather than its host. */
  function focused() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  }
  /** Synchronize only the native modal; feature command/capture/session state is not mutated. */
  function sync() {
    if (disposed) return;
    const open = getSnapshot().open;
    if (open && !nested()) {
      if (!dialog.open) {
        if (!returnFocus) returnFocus = focused();
        dialog.showModal();
      }
    } else {
      if (dialog.open) dialog.close();
      if (!open && !nested()) {
        if (returnFocus?.isConnected) returnFocus.focus();
        returnFocus = null;
      }
    }
  }
  /** Native Escape delegates to explicit source close; a nested dialog retains Escape ownership. */
  function cancel(event) {
    if (event.target !== dialog || event.defaultPrevented || nested()) return;
    event.preventDefault();
    close();
  }
  /** Ignore close events queued by suspension or cleanup, including a rapid close/reopen race. */
  function closed() {
    if (!disposed && !dialog.open && !nested() && getSnapshot().open) close();
  }
  /** Distinguish the native backdrop from dialog padding and nested content. */
  function outside(event) {
    if (event.target !== dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }
  /** Require the gesture to begin outside, so dragging from inside never dismisses settings. */
  function pointerDown(event) { backdropPressed = outside(event); }
  /** Cancel an interrupted backdrop gesture. */
  function pointerCancel() { backdropPressed = false; }
  /** Delegate a complete backdrop click to the same source-owned close action. */
  function backdropClick(event) {
    const dismiss = backdropPressed && outside(event);
    backdropPressed = false;
    if (dismiss && !disposed && dialog.open && !nested()) close();
  }
  const observer = new document.defaultView.MutationObserver(sync);
  for (const owner of documents) observer.observe(owner.body, { attributes: true, attributeFilter: ["class"] });
  dialog.addEventListener("pointerdown", pointerDown);
  dialog.addEventListener("pointercancel", pointerCancel);
  dialog.addEventListener("click", backdropClick);
  dialog.addEventListener("cancel", cancel);
  dialog.addEventListener("close", closed);
  return {
    sync,
    /** Release exactly owned listeners/observer/modal focus; never dispose feature sources or the shared call. */
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      dialog.removeEventListener("pointerdown", pointerDown);
      dialog.removeEventListener("pointercancel", pointerCancel);
      dialog.removeEventListener("click", backdropClick);
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("close", closed);
      dialog.close();
      if (!nested() && returnFocus?.isConnected) returnFocus.focus();
      returnFocus = null;
    },
  };
}
