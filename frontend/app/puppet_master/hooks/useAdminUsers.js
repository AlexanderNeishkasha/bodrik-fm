import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ui } from "../../lang/ru";
import { clearCachedAuthUser, setCachedAuthUser } from "../../lib/authSession";
import { deferEffect } from "../../lib/deferEffect";
import { readAdminApiMessage } from "../lib/adminApiMessage";
import {
  isAbortError,
  nextRequestRevision,
  ownsRequestRevision,
  passwordResetPayload,
  updateAdminUser,
} from "../lib/adminPolicy.mjs";
import useAdminNotice from "./useAdminNotice";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001";

/** Own admin authorization, users, drafts and cancellable mutations. */
export default function useAdminUsers() {
  const [status, setStatus] = useState("loading");
  const [users, setUsers] = useState([]);
  const [passwordDrafts, setPasswordDrafts] = useState({});
  const [roomDrafts, setRoomDrafts] = useState({});
  const [listedDrafts, setListedDrafts] = useState({});
  const [conferenceBusyByUser, setConferenceBusyByUser] = useState({});
  const [passwordBusyByUser, setPasswordBusyByUser] = useState({});
  const [deleteBusyByUser, setDeleteBusyByUser] = useState({});
  const { notice, showNotice } = useAdminNotice();
  const router = useRouter();
  const loadControllerRef = useRef(null);
  const roomRequestsRef = useRef({});
  const conferenceControllersRef = useRef({});
  const roomDraftsRef = useRef(roomDrafts);
  const listedDraftsRef = useRef(listedDrafts);

  useEffect(() => {
    roomDraftsRef.current = roomDrafts;
  }, [roomDrafts]);

  useEffect(() => {
    listedDraftsRef.current = listedDrafts;
  }, [listedDrafts]);

  /** Cancel every owned timer/request for teardown or authoritative reload. */
  const cancelOwnedWork = useCallback(() => {
    loadControllerRef.current?.abort();
    loadControllerRef.current = null;
    for (const request of Object.values(roomRequestsRef.current)) {
      if (request.timer) clearTimeout(request.timer);
      request.controller?.abort();
    }
    roomRequestsRef.current = {};
    for (const controller of Object.values(conferenceControllersRef.current)) controller.abort();
    conferenceControllersRef.current = {};
  }, []);

  useEffect(() => cancelOwnedWork, [cancelOwnedWork]);

  /** Load authoritative identity and admin rows, replacing any obsolete load. */
  const loadUsers = useCallback(async () => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setStatus("loading");
    try {
      const me = await fetch(`${API_BASE}/api/auth/me`, {
        credentials: "include",
        signal: controller.signal,
      });
      if (me.status === 401) {
        clearCachedAuthUser();
        setStatus("unauthorized");
        return;
      }
      if (!me.ok) {
        const message = await readAdminApiMessage(me);
        if (controller.signal.aborted) return;
        showNotice(message);
        setStatus("error");
        return;
      }
      const meData = await me.json();
      if (controller.signal.aborted) return;
      setCachedAuthUser(meData);
      if (meData?.role !== "admin") {
        setStatus("forbidden");
        return;
      }
      const response = await fetch(`${API_BASE}/api/admin/users`, {
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) {
        const message = await readAdminApiMessage(response);
        if (controller.signal.aborted) return;
        showNotice(message);
        setStatus("error");
        return;
      }
      const data = await response.json();
      if (controller.signal.aborted) return;
      const rows = Array.isArray(data) ? data : [];
      for (const request of Object.values(roomRequestsRef.current)) {
        if (request.timer) clearTimeout(request.timer);
        request.controller?.abort();
      }
      roomRequestsRef.current = {};
      setUsers(rows);
      setRoomDrafts(Object.fromEntries(rows.map((user) => [user.id, user.room_slug || ""])));
      setListedDrafts(Object.fromEntries(rows.map((user) => [user.id, Boolean(user.room_listed)])));
      setStatus("ready");
    } catch (error) {
      if (!isAbortError(error)) {
        showNotice(ui.messages.actionFailed);
        setStatus("error");
      }
    } finally {
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
    }
  }, [showNotice]);

  useEffect(() => deferEffect(loadUsers), [loadUsers]);

  /** End the server session before clearing the local navigation hint. */
  const logout = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        showNotice(await readAdminApiMessage(response));
        return;
      }
      clearCachedAuthUser();
      router.replace("/");
    } catch {
      showNotice(ui.messages.actionFailed);
    }
  }, [router, showNotice]);

  /** Reset one password without trimming meaningful password whitespace. */
  const resetPassword = useCallback(async (userId) => {
    const payload = passwordResetPayload(passwordDrafts[userId] || "");
    if (!payload || passwordBusyByUser[userId]) return;
    setPasswordBusyByUser((current) => ({ ...current, [userId]: true }));
    try {
      const response = await fetch(`${API_BASE}/api/admin/users/${userId}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        showNotice(await readAdminApiMessage(response, ui.messages.passwordResetFailed));
        return;
      }
      setPasswordDrafts((current) => ({ ...current, [userId]: "" }));
    } catch {
      showNotice(ui.messages.actionFailed);
    } finally {
      setPasswordBusyByUser((current) => ({ ...current, [userId]: false }));
    }
  }, [passwordBusyByUser, passwordDrafts, showNotice]);

  /** Delete one account and reload only after a confirmed successful response. */
  const deleteUser = useCallback(async (userId) => {
    if (deleteBusyByUser[userId] || !window.confirm("Удалить пользователя?")) return;
    setDeleteBusyByUser((current) => ({ ...current, [userId]: true }));
    try {
      const response = await fetch(`${API_BASE}/api/admin/users/${userId}/delete`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        showNotice(await readAdminApiMessage(response));
        return;
      }
      await loadUsers();
    } catch {
      showNotice(ui.messages.actionFailed);
    } finally {
      setDeleteBusyByUser((current) => ({ ...current, [userId]: false }));
    }
  }, [deleteBusyByUser, loadUsers, showNotice]);

  /** Persist one debounced room draft only if its request remains current. */
  const updateRoom = useCallback(async (userId, revision) => {
    const owned = roomRequestsRef.current[userId];
    if (!ownsRequestRevision(owned, revision)) return;
    const room = (roomDraftsRef.current[userId] || "").trim();
    const listed = Boolean(listedDraftsRef.current[userId]);
    if (!room) return;
    const controller = new AbortController();
    owned.controller = controller;
    try {
      const response = await fetch(`${API_BASE}/api/admin/users/${userId}/room`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({ room, listed }),
      });
      if (!response.ok) {
        const message = await readAdminApiMessage(response);
        if (!controller.signal.aborted && ownsRequestRevision(roomRequestsRef.current[userId], revision)) {
          showNotice(message);
        }
        return;
      }
      const data = await response.json();
      if (controller.signal.aborted || !ownsRequestRevision(roomRequestsRef.current[userId], revision)) return;
      const nextSlug = data?.room_slug ?? room;
      const nextListed = Boolean(data?.room_listed ?? listed);
      setRoomDrafts((current) => ({ ...current, [userId]: nextSlug }));
      setListedDrafts((current) => ({ ...current, [userId]: nextListed }));
      setUsers((current) => updateAdminUser(current, userId, {
        room_slug: nextSlug,
        room_listed: nextListed,
      }));
    } catch (error) {
      if (!isAbortError(error)) showNotice(ui.messages.actionFailed);
    } finally {
      const current = roomRequestsRef.current[userId];
      if (ownsRequestRevision(current, revision)) current.controller = null;
    }
  }, [showNotice]);

  /** Replace the pending room timer/request with the newest draft revision. */
  const scheduleRoomUpdate = useCallback((userId) => {
    const previous = roomRequestsRef.current[userId];
    if (previous?.timer) clearTimeout(previous.timer);
    previous?.controller?.abort();
    const revision = nextRequestRevision(previous);
    const timer = setTimeout(() => {
      const current = roomRequestsRef.current[userId];
      if (!ownsRequestRevision(current, revision)) return;
      current.timer = null;
      updateRoom(userId, revision);
    }, 700);
    roomRequestsRef.current[userId] = { revision, timer, controller: null };
  }, [updateRoom]);

  /** Persist conference access with one cancellable request per user. */
  const updateConferenceAccess = useCallback(async (userId, enabled) => {
    conferenceControllersRef.current[userId]?.abort();
    const controller = new AbortController();
    conferenceControllersRef.current[userId] = controller;
    setConferenceBusyByUser((current) => ({ ...current, [userId]: true }));
    try {
      const response = await fetch(`${API_BASE}/api/admin/users/${userId}/conference-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({ allowed: enabled }),
      });
      if (!response.ok) {
        const message = await readAdminApiMessage(response);
        if (!controller.signal.aborted && conferenceControllersRef.current[userId] === controller) {
          showNotice(message);
        }
        return;
      }
      const payload = await response.json();
      if (controller.signal.aborted || conferenceControllersRef.current[userId] !== controller) return;
      setUsers((current) => updateAdminUser(current, userId, {
        conference_allowed: payload.allowed === true,
      }));
    } catch (error) {
      if (!isAbortError(error)) showNotice(ui.messages.actionFailed);
    } finally {
      if (conferenceControllersRef.current[userId] === controller) {
        delete conferenceControllersRef.current[userId];
        setConferenceBusyByUser((current) => ({ ...current, [userId]: false }));
      }
    }
  }, [showNotice]);

  return {
    status,
    users,
    passwordDrafts,
    roomDrafts,
    listedDrafts,
    conferenceBusyByUser,
    passwordBusyByUser,
    deleteBusyByUser,
    notice,
    setPasswordDrafts,
    setRoomDrafts,
    setListedDrafts,
    logout,
    resetPassword,
    deleteUser,
    scheduleRoomUpdate,
    updateConferenceAccess,
  };
}
