import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

/** Read one frontend source file relative to this test. */
function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("all native checkboxes use the active theme accent and focus ring", () => {
  const controls = read("../app/globals.components.css");
  assert.match(controls, /input\[type="checkbox"\]\s*\{\s*accent-color: var\(--theme-accent\);/);
  assert.match(controls, /input\[type="checkbox"\]:focus-visible\s*\{[\s\S]*outline: 2px solid var\(--theme-accent\);/);

  const studioFiles = [
    "../app/studio/components/StudioScreen.js",
  ];
  for (const file of studioFiles) assert.match(read(file), /type="checkbox"/, file);
});

test("every theme supplies the checkbox accent token", () => {
  const themesUrl = new URL("../app/themes/", import.meta.url);
  const themes = readdirSync(themesUrl).filter((name) => name.endsWith(".css"));
  assert.equal(themes.length, 13);
  for (const theme of themes) {
    assert.match(read(`../app/themes/${theme}`), /--theme-accent:\s*[^;]+;/, theme);
  }
});
