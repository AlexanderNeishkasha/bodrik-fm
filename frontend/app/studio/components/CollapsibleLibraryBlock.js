import styles from "./LibraryMotion.module.css";

export default function CollapsibleLibraryBlock({ isOpen, children }) {
  return (
    <div
      className={`${styles.collapse} ${
        isOpen ? styles.collapseOpen : styles.collapseClosed
      }`}
      aria-hidden={!isOpen}
    >
      <div className={styles.collapseInner}>{children}</div>
    </div>
  );
}
