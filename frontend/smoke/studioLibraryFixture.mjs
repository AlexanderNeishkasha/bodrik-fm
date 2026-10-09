import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { THEME_NAMES } from "../app/lib/theme.js";

/** Bundle the actual interactive library and production styles without auth, media or API I/O. */
export async function studioLibraryFixture({ dragTargets = false } = {}) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = await build({
    stdin: { contents: `
      import "./app/fonts/fonts.css";
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { DndContext, PointerSensor, useSensor, useSensors, useDroppable } from "@dnd-kit/core";
      import LibraryPanel from "./app/studio/components/LibraryPanel.js";
      import { displayName } from "./app/studio/lib/format.js";
      /** Provide isolated queue/player destinations for pointer-drag regression tests. */
      function DropTarget({ id, top }) {
        const { setNodeRef } = useDroppable({ id });
        return <div ref={setNodeRef} data-testid={id} style={{ position: "fixed", left: 10, top, width: 160, height: 80, background: "#ddd" }}>{id}</div>;
      }
      /** Own fake canonical library data; actions are recorded rather than sent to a server. */
      function Fixture() {
        const [tracks, setTracks] = useState([
          { id: 1, filename: "Battle in the Forest.mp3", section_id: 10, sort_order: 0 },
          { id: 2, filename: "Quiet forest.flac", section_id: null, sort_order: 0 },
          { id: 3, filename: "Песня о ЛЕСЕ.ogg", section_id: 20, sort_order: 0 },
          { id: 4, filename: "Night.mp3", section_id: 10, sort_order: 1 },
        ]);
        const [isEditing, setIsEditing] = useState(false);
        const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
        window.replaceLibraryTracks = setTracks;
        return <DndContext sensors={sensors} onDragEnd={event => window.libraryDrops.push({ target: event.over?.id ?? null, data: event.active.data.current })}>
          {${JSON.stringify(dragTargets)} && <><DropTarget id="queue-container" top={20} /><DropTarget id="now-playing" top={120} /></>}
          <LibraryPanel
          tracks={tracks}
          sections={[{ id: 10, name: "Battle category" }, { id: 20, name: "Collapsed category" }]}
          collapsedSectionIds={new Set(["20"])} uploads={[]} youtubeDownloads={[]}
          displayName={displayName} isEditingLibrary={isEditing}
          onToggleEdit={() => setIsEditing(value => !value)}
          onPlay={id => window.libraryActions.push(["play", id])}
          onQueue={id => window.libraryActions.push(["queue", id])}
          onStartRename={track => window.libraryActions.push(["rename", track.id])}
          onRequestDelete={track => window.libraryActions.push(["delete", track.id])}
        /></DndContext>;
      }
      window.libraryActions = [];
      window.libraryDrops = [];
      const root = createRoot(document.getElementById("root"));
      /** Allow isolated browser tests to verify animation/resource cleanup on unmount. */
      window.unmountLibraryFixture = () => root.unmount();
      root.render(<Fixture />);
    `, resolveDir: root, loader: "jsx" },
    bundle: true, platform: "browser", format: "iife", write: false, jsx: "automatic",
    outdir: "unused-studio-library-output", loader: { ".js": "jsx", ".woff2": "dataurl" },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const globalPath = fileURLToPath(new URL("../app/globals.css", import.meta.url));
  const globalStyles = await postcss([tailwind({ base: root })]).process(
    readFileSync(globalPath, "utf8"), { from: globalPath }
  );
  const themes = THEME_NAMES.map(theme => readFileSync(new URL(`../app/themes/${theme}.css`, import.meta.url), "utf8")).join("\n");
  const css = result.outputFiles.find(file => file.path.endsWith(".css")).text;
  const script = result.outputFiles.find(file => file.path.endsWith(".js")).text;
  return `<!doctype html><html data-theme="ivory"><head><meta charset="utf-8">
    <style>${themes}\n${globalStyles.css}\n${css}</style></head><body>
    <main id="root" style="max-width:800px;margin:20px auto"></main>
    <script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`;
}
