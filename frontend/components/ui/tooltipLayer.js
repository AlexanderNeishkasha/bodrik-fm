/** Copy only the tooltip's compiled CSS Module rules, not Tailwind, Bootstrap or other page globals. */
function tooltipCss(root, className) {
  const rules = [];
  /** Walk stylesheet grouping rules while retaining only this primitive's selectors. */
  function collect(list) {
    for (const rule of list) {
      if (rule.selectorText?.includes(`.${className}`)) rules.push(rule.cssText);
      else if (rule.cssRules) collect(rule.cssRules);
    }
  }
  for (const sheet of [...(root.styleSheets || []), ...(root.adoptedStyleSheets || [])]) {
    try { collect(sheet.cssRules); }
    catch (error) { if (error.name !== "SecurityError") throw error; }
  }
  if (!rules.length) throw new Error("Tooltip CSS Module is unavailable");
  return rules.join("\n");
}

/** Follow composed ancestry so a tooltip stays in the active native modal's top layer, including slotted islands. */
function tooltipParent(anchor) {
  const visited = new Set();
  let element = anchor;
  while (element && !visited.has(element)) {
    visited.add(element);
    const dialog = element.closest?.("dialog[open]");
    if (dialog) return dialog;
    element = element.assignedSlot || element.parentElement || element.getRootNode?.().host;
  }
  return anchor.ownerDocument.body;
}

/** Create a separately isolated tooltip layer, inside the current modal or at body level for ordinary panels. */
export function createTooltipLayer(anchor, className) {
  const document = anchor.ownerDocument;
  const host = document.createElement("div");
  host.setAttribute("data-ui-tooltip-layer", "");
  host.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none";
  const shadow = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("style");
  stylesheet.textContent = tooltipCss(anchor.getRootNode(), className);
  shadow.append(stylesheet);
  tooltipParent(anchor).append(host);
  return {
    host, container: shadow,
    /** Derive appearance from the anchor; the original theme remains the only authority. */
    syncAppearance() {
      const computed = document.defaultView.getComputedStyle(anchor);
      host.style.font = computed.font;
      host.style.color = computed.color;
      for (const key of ["--ui-accent", "--ui-border", "--ui-surface", "--theme-accent", "--theme-border", "--theme-card"]) {
        host.style.setProperty(key, computed.getPropertyValue(key));
      }
    },
    /** Remove only the visual layer, never its parent settings panel or meeting resources. */
    dispose() { host.remove(); },
  };
}
