"use client";

import { useEffect, useId, useRef } from "react";
import { ABOUT_COPY, normalizeAboutSnapshot, SOURCE_REPOSITORY_URL } from "./aboutModel.mjs";
import styles from "./AboutDialog.module.css";
import Icon from "../../../components/ui/Icon";
import { assetUrl } from "../../../app/lib/asset";

/** Render one accessible read-only About dialog; closing the view never ends a meeting. */
export default function AboutDialog({ snapshot, onClose, onReady }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const model = normalizeAboutSnapshot(snapshot);
  const copy = ABOUT_COPY[model.language];

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    onReady?.();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onReady]);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      lang={model.language}
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
    >
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>{copy.title}</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label={copy.close}>×</button>
      </header>
      <p className={styles.version}>MiroTalk SFU{model.version ? ` · v${model.version}` : ""}</p>
      <section className={styles.card}>
        <h3 className={styles.heading}><Icon name="video" size={20} className={styles.icon} />{copy.platform}</h3>
        <p className={styles.text}>{copy.description}</p>
        <a className={styles.link} href="https://sfu.mirotalk.com" target="_blank" rel="noopener noreferrer">{copy.platformLink}<Icon name="external-link" size={16} className={styles.externalIcon} /></a>
      </section>
      <section className={styles.card}>
        <h3 className={styles.heading}><Icon name="code" size={20} className={styles.icon} />{copy.license}</h3>
        <p className={styles.text}>{copy.licenseDescription}</p>
        <a className={styles.link} href={assetUrl("/meeting-assets/LICENSE")} target="_blank" rel="noopener noreferrer">{copy.licenseLink}<Icon name="external-link" size={16} className={styles.externalIcon} /></a>
        <a className={styles.link} href={SOURCE_REPOSITORY_URL} target="_blank" rel="noopener noreferrer">{copy.sourceLink}<Icon name="external-link" size={16} className={styles.externalIcon} /></a>
      </section>
      <button type="button" className={styles.confirm} onClick={onClose}>{copy.close}</button>
    </dialog>
  );
}
