import { useEffect, useRef, useState } from "react";
import { deferEffect } from "../../lib/deferEffect";
import { limitRoomSlug } from "../lib/roomSlugLimit";
import { nextDraftRevision, ownsDraftRevision } from "../lib/requestPolicy.mjs";

/** Own debounced room drafts and reject obsolete persistence responses. */
export default function useStudioRoomDraft({
  user,
  isAuthed,
  setRoomSlug,
  setRoomListed,
  setUser,
}) {
  const [roomSlugInput, setRawRoomSlugInput] = useState("");
  const [roomListedInput, setRoomListedInput] = useState(true);
  const [savedRoomSlug, setSavedRoomSlug] = useState("");
  const [savedRoomListed, setSavedRoomListed] = useState(true);
  const requestRef = useRef({ revision: 0, controller: null });

  /** Apply the frontend byte/shape limit before storing a slug draft. */
  const setRoomSlugInput = (value) => setRawRoomSlugInput(limitRoomSlug(value));

  useEffect(() => {
    const nextSlug = limitRoomSlug(user?.room_slug ?? "");
    const nextListed = Boolean(user?.room_listed ?? true);
    return deferEffect(() => {
      setRawRoomSlugInput(nextSlug);
      setRoomListedInput(nextListed);
      setSavedRoomSlug(nextSlug);
      setSavedRoomListed(nextListed);
    });
  }, [user?.room_slug, user?.room_listed]);

  useEffect(() => {
    if (!isAuthed) return;
    const draftSlug = limitRoomSlug(roomSlugInput.trim());
    const draftListed = Boolean(roomListedInput);
    const hasSlugChange = draftSlug !== savedRoomSlug;
    const hasListedChange = draftListed !== savedRoomListed;
    if (!hasSlugChange && !hasListedChange) return;

    requestRef.current.controller?.abort();
    const revision = nextDraftRevision(requestRef.current.revision);
    requestRef.current = { revision, controller: null };
    const timerId = window.setTimeout(async () => {
      const controller = new AbortController();
      if (!ownsDraftRevision(requestRef.current.revision, revision)) return;
      requestRef.current.controller = controller;
      const patch = {};
      let resolvedSlug = null;
      let resolvedListed = null;
      try {
        if (hasSlugChange) {
          const nextSlug = await setRoomSlug(draftSlug, { signal: controller.signal });
          if (controller.signal.aborted || !ownsDraftRevision(requestRef.current.revision, revision)) return;
          if (nextSlug != null) {
            const limitedSlug = limitRoomSlug(nextSlug);
            resolvedSlug = limitedSlug;
            patch.room_slug = limitedSlug;
          }
        }
        if (hasListedChange) {
          const nextListed = await setRoomListed(draftListed, { signal: controller.signal });
          if (controller.signal.aborted || !ownsDraftRevision(requestRef.current.revision, revision)) return;
          if (nextListed != null) {
            resolvedListed = nextListed;
            patch.room_listed = nextListed;
          }
        }
        if (resolvedSlug != null) {
          setRawRoomSlugInput(resolvedSlug);
          setSavedRoomSlug(resolvedSlug);
        }
        if (resolvedListed != null) {
          setRoomListedInput(resolvedListed);
          setSavedRoomListed(resolvedListed);
        }
        if (Object.keys(patch).length > 0) {
          setUser((previous) => (previous ? { ...previous, ...patch } : previous));
        }
      } finally {
        if (ownsDraftRevision(requestRef.current.revision, revision)) requestRef.current.controller = null;
      }
    }, 700);

    return () => {
      window.clearTimeout(timerId);
      if (ownsDraftRevision(requestRef.current.revision, revision)) {
        requestRef.current.controller?.abort();
        requestRef.current.controller = null;
      }
    };
  }, [
    isAuthed,
    roomListedInput,
    roomSlugInput,
    savedRoomListed,
    savedRoomSlug,
    setRoomListed,
    setRoomSlug,
    setUser,
  ]);

  return { roomSlugInput, roomListedInput, setRoomSlugInput, setRoomListedInput };
}
