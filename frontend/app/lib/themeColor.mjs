/**
 * Keep `<meta name="theme-color">` equal to the active theme's `--theme-bg`, so mobile
 * browsers tint their toolbar to match. Watches `data-theme` on `<html>`, which covers every
 * way a theme is applied. Standalone for the pre-hydration script; lives for the page.
 */
export function watchThemeColor({ document = globalThis.document, MutationObserverImpl = globalThis.MutationObserver } = {}) {
  const root = document.documentElement;
  const sync = () => {
    const color = document.defaultView?.getComputedStyle(root).getPropertyValue("--theme-bg").trim();
    // Before theme CSS has loaded the token is empty; the load listener retries.
    if (!color) return;
    let meta = document.head.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    if (meta.getAttribute("content") !== color) meta.setAttribute("content", color);
  };
  new MutationObserverImpl(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  document.defaultView?.addEventListener("load", sync, { once: true });
  sync();
}
