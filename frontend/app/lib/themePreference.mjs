/** Read/write a validated theme across sibling domains; standalone for pre-hydration use. */
export function themePreference(mode, value, themes, { storage, document = globalThis.document, location = globalThis.location } = {}) {
  const key = "bodrik_fm_theme";
  if (mode === "read") {
    let cookie;
    let saved;
    try { cookie = document?.cookie.split(";").map(part => part.trim()).find(part => part.startsWith(`${key}=`))?.slice(key.length + 1); } catch {}
    try { saved = (storage ?? globalThis.localStorage)?.getItem(key); } catch {}
    return themes.includes(cookie) ? cookie : themes.includes(saved) ? saved : null;
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
