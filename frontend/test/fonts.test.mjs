import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";

const fontsRoot = new URL("../app/fonts/", import.meta.url);

/** Read one self-hosted font source file. */
function read(relative) {
  return readFileSync(new URL(relative, fontsRoot), "utf8");
}

test("self-hosted font definitions resolve to nonempty assets and retained licenses", () => {
  const index = read("fonts.css");
  const definitions = [...index.matchAll(/@import '\.\/definitions\/([a-z-]+\.css)'/g)]
    .map((match) => match[1]);
  assert.equal(definitions.length, 15);
  assert.equal(new Set(definitions).size, definitions.length);

  const assets = new Set();
  for (const definition of definitions) {
    const css = read(`definitions/${definition}`);
    for (const match of css.matchAll(/url\('\.\.\/files\/([^']+\.woff2)'\)/g)) {
      const asset = new URL(`files/${match[1]}`, fontsRoot);
      assert.equal(existsSync(asset), true, match[1]);
      assert.ok(statSync(asset).size > 0, match[1]);
      assets.add(match[1]);
    }
    const slug = definition.replace(/\.css$/, "");
    assert.match(read(`licenses/${slug}.txt`), /SIL OPEN FONT LICENSE Version 1\.1/);
  }
  assert.equal(assets.size, 35);
  assert.equal(readdirSync(new URL("files/", fontsRoot)).length, assets.size);
});

test("theme font variables are declared without build-time Google imports", () => {
  const layout = readFileSync(new URL("../app/layout.js", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /next\/font\/google/);
  assert.match(layout, /import "\.\/fonts\/fonts\.css"/);

  const declarations = new Set([...read("fonts.css").matchAll(/(--font-[a-z-]+):/g)]
    .map((match) => match[1]));
  const themes = readdirSync(new URL("../app/themes/", import.meta.url))
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(new URL(`../app/themes/${name}`, import.meta.url), "utf8"))
    .join("\n");
  const references = new Set([...themes.matchAll(/var\((--font-[a-z-]+)/g)]
    .map((match) => match[1]));
  for (const variable of references) assert.equal(declarations.has(variable), true, variable);
});
