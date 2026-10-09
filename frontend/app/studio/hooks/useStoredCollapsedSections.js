import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deferEffect } from "../../lib/deferEffect";
import { getStoredValue, setStoredValue } from "../../lib/storageKeys";

const STORAGE_NAME = "studio_library_collapsed_sections";

export default function useStoredCollapsedSections({ asUserId, isAuthed }) {
  const [collapsedSectionIds, setCollapsedSectionIds] = useState(() => new Set());
  const hydratedRef = useRef(false);
  const storageName = useMemo(
    () => `${STORAGE_NAME}_${asUserId == null ? "self" : asUserId}`,
    [asUserId]
  );

  useEffect(() => {
    hydratedRef.current = false;
    return deferEffect(() => {
      if (!isAuthed) {
        setCollapsedSectionIds(new Set());
        return;
      }
      setCollapsedSectionIds(readCollapsedSectionIds(storageName));
      hydratedRef.current = true;
    });
  }, [isAuthed, storageName]);

  useEffect(() => {
    if (!isAuthed || !hydratedRef.current) {
      return;
    }
    try {
      setStoredValue(storageName, JSON.stringify([...collapsedSectionIds]));
    } catch {}
  }, [collapsedSectionIds, isAuthed, storageName]);

  const toggleSectionCollapsed = useCallback((sectionId) => {
    const key = sectionId == null ? "none" : String(sectionId);
    setCollapsedSectionIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const removeCollapsedSection = useCallback((sectionId) => {
    setCollapsedSectionIds((prev) => {
      const next = new Set(prev);
      next.delete(String(sectionId));
      return next;
    });
  }, []);

  return {
    collapsedSectionIds,
    setCollapsedSectionIds,
    toggleSectionCollapsed,
    removeCollapsedSection,
  };
}

function readCollapsedSectionIds(storageName) {
  try {
    const stored = getStoredValue(storageName);
    if (!stored) {
      return new Set();
    }
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.map((id) => String(id)));
  } catch {
    return new Set();
  }
}
