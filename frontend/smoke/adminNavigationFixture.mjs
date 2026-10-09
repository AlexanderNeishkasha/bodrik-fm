import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** Render real navigation markup without authentication requests or account mutations. */
export async function adminNavigationFixture() {
  const result = await build({
    stdin: { contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import StudioScreen from "./app/studio/components/StudioScreen.js";
      import AdminPage from "./app/puppet_master/page.js";
      export const admin = () => renderToStaticMarkup(React.createElement(AdminPage));
      export const studio = (auth) => renderToStaticMarkup(React.createElement(StudioScreen, {
        auth: { isAuthed: true, isChecked: false, roomSlugInput: "", roomListedInput: false, ...auth },
        hotkeys: { isHydrated: false },
      }));
    `, resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
    outdir: "unused-admin-navigation-output",
    loader: { ".js": "jsx", ".png": "dataurl" },
    external: ["react", "react/*", "react-dom/*", "next/link", "next/image"],
    plugins: [{
      name: "read-only-admin-hook",
      /** Replace only the I/O owner; the actual admin page and navigation are rendered unchanged. */
      setup(builder) {
        builder.onResolve({ filter: /hooks\/useAdminUsers$/ }, () => ({ path: "admin-hook", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: 'export default function useAdminUsers() { return {status:"ready", users:[], notice:null}; }',
          loader: "js",
        }));
      },
    }],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find(file => file.path.endsWith(".js")).text, {
    module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url), process,
  });
  return evaluated.exports;
}
