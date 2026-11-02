/** Read/write a validated theme across sibling domains; standalone for pre-hydration use. */
export function themePreference(mode, value, themes, { storage, document = globalThis.document, location = globalThis.location } = {}) {
  const key = "bodrik_fm_theme_v2";
  // Before v2, the grey theme was "mono" and the black one "pirate"; map those ids on read.
  const legacyKey = "bodrik_fm_theme";
  const upgrade = (theme) => (theme === "mono" ? "pirate" : theme === "pirate" ? "noir" : theme);
  if (mode === "read") {
    const cookies = (() => { try { return document?.cookie.split(";").map(part => part.trim()) ?? []; } catch { return []; } })();
    const cookie = (name) => cookies.find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
    const saved = (name) => { try { return (storage ?? globalThis.localStorage)?.getItem(name); } catch { return undefined; } };
    const candidates = [cookie(key), saved(key), upgrade(cookie(legacyKey)), upgrade(saved(legacyKey))];
    return candidates.find(theme => themes.includes(theme)) ?? null;
  }
  if (!themes.includes(value)) return null;
  try {
    const target = storage ?? globalThis.localStorage;
    if (target?.getItem?.(key) !== value) target?.setItem(key, value);
  } catch {}
  try {
    const hostname = location?.hostname;
    const domain = hostname === "bodrik.fm" || hostname?.endsWith(".bodrik.fm") ? "; Domain=bodrik.fm" : "";
    const secure = location?.protocol === "https:" ? "; Secure" : "";
    if (document && !document.cookie.split(";").some(part => part.trim() === `${key}=${value}`)) {
      document.cookie = `${key}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${domain}${secure}`;
    }
  } catch {}
  return value;
}
