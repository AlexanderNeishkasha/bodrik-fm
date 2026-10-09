/** Observe a visual track without stopping capture or changing audio subscriptions. */
export function observeVideoViewport(element, source, report, scope = globalThis) {
  if (source.local) return () => {};
  let intersecting = true;
  const doc = element.ownerDocument;
  /** PiP keeps video live even when its card or browser tab is out of view. */
  const update = () => report(source.id, doc.pictureInPictureElement === element ||
    (intersecting && doc.visibilityState !== "hidden"));
  const observer = typeof scope.IntersectionObserver === "function" ? new scope.IntersectionObserver((entries) => {
    intersecting = entries.some((entry) => entry.isIntersecting);
    update();
  }) : null;
  observer?.observe(element);
  doc.addEventListener("visibilitychange", update);
  element.addEventListener("enterpictureinpicture", update);
  element.addEventListener("leavepictureinpicture", update);
  update();
  return () => {
    observer?.disconnect();
    doc.removeEventListener("visibilitychange", update);
    element.removeEventListener("enterpictureinpicture", update);
    element.removeEventListener("leavepictureinpicture", update);
    report(source.id, false);
  };
}
