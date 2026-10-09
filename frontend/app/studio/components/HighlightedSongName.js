import { libraryNameParts } from "../lib/librarySearch.mjs";
import styles from "./HighlightedSongName.module.css";

/** Highlight each literal search match without changing the displayed name or interpreting HTML. */
export default function HighlightedSongName({ name, query }) {
  return libraryNameParts(name, query).map((part, index) => part.matched ? (
    <mark
      key={index}
      className={styles.match}
    >
      {part.text}
    </mark>
  ) : part.text);
}
