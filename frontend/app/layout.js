import "./fonts/fonts.css";
import "./themes/crimson.css";
import "./themes/mono.css";
import "./themes/midnight.css";
import "./themes/ivory.css";
import "./themes/lucifer.css";
import "./themes/aurora.css";
import "./themes/saffron.css";
import "./themes/prism.css";
import "./themes/mythic.css";
import "./themes/grove.css";
import "./themes/spectrum.css";
import "./themes/pirate.css";
import "./themes/emberveil.css";
import "./globals.css";
import { assetUrl } from "./lib/asset";
import { THEME_NAMES } from "./lib/theme";
import { themePreference } from "./lib/themePreference.mjs";

export const metadata = {
  title: "Бодрик FM",
  description: "Синхронная музыка для настольных игр и уютных посиделок.",
};

const themeLookup = JSON.stringify(THEME_NAMES);
const themeScript = `(function(){try{var root=document.documentElement;var preference=${themePreference.toString()};var themes=${themeLookup};var theme=preference("read",null,themes)||"mono";root.setAttribute("data-theme",theme);preference("write",theme,themes);var v=localStorage.getItem("bodrik_fm_volume");var m=localStorage.getItem("bodrik_fm_muted");if(v!==null){window.__meetingFmVolume=v}if(m!==null){window.__meetingFmMuted=m}var hm=localStorage.getItem("bodrik_fm_hotkeys_main");root.setAttribute("data-hotkeys-main",hm===null?"true":hm);var hs=localStorage.getItem("bodrik_fm_hotkeys_studio");root.setAttribute("data-hotkeys-studio",hs===null?"true":hs);var hh=localStorage.getItem("bodrik_fm_hat_hidden");root.setAttribute("data-hat-hidden",hh==="true"?"true":"false")}catch(e){}})();`;

/** Render shared metadata, self-hosted fonts and pre-hydration preferences. */
export default function RootLayout({ children }) {
  return (
    <html lang="ru" suppressHydrationWarning data-theme="mono">
      <head>
        <link rel="apple-touch-icon" sizes="180x180" href={assetUrl("/apple-touch-icon.png")} />
        <link rel="icon" type="image/png" sizes="32x32" href={assetUrl("/favicon-32x32.png")} />
        <link rel="icon" type="image/png" sizes="16x16" href={assetUrl("/favicon-16x16.png")} />
        <link rel="manifest" href={assetUrl("/site.webmanifest")} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased font-sans">{children}</body>
    </html>
  );
}
