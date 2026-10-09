import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ui } from "../../lang/ru";
import { localizeApiMessage } from "../lib/localizeApiMessage";
import { deferEffect } from "../../lib/deferEffect";
import { clearCachedAuthUser, hasCachedAuthUser, setCachedAuthUser } from "../../lib/authSession";

/** Return whether a response contains the minimum authoritative user contract. */
const isAuthPayload = (payload) => typeof payload?.role === "string" && typeof payload?.room_slug === "string";

/** Read and localize one public authentication failure response. */
async function readAuthError(response, fallback) {
  try {
    const data = await response.json();
    return data?.message ? localizeApiMessage(data.message, fallback) : fallback;
  } catch {
    return fallback;
  }
}

/** Own Studio authentication while treating browser cache only as a UI hint. */
export default function useStudioAuth({ apiBase, asUserId, showNotice, setStatus, setIsBusy }) {
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [isAuthed, setIsAuthed] = useState(false);
  const [isAuthChecked, setIsAuthChecked] = useState(false);
  const [user, setUser] = useState(null);
  const router = useRouter();
  const checkControllerRef = useRef(null);
  const actionControllerRef = useRef(null);

  useEffect(() => () => {
    checkControllerRef.current?.abort();
    actionControllerRef.current?.abort();
  }, []);

  /** Redirect an ordinary admin login while preserving explicit impersonation. */
  const redirectAdmin = useCallback(
    (payload) => {
      const isAdmin = payload?.actor_role === "admin" || payload?.role === "admin";
      if (!isAdmin || asUserId != null) {
        return false;
      }
      router.replace("/puppet_master");
      return true;
    },
    [asUserId, router],
  );

  /** Apply one server-validated identity and optional admin redirect. */
  const applyAuthPayload = useCallback(
    (payload, { redirectAdminUser = false } = {}) => {
      setCachedAuthUser(payload);
      if (redirectAdminUser && redirectAdmin(payload)) {
        setIsAuthChecked(false);
        setIsAuthed(false);
        setUser(null);
        return;
      }
      setIsAuthChecked(true);
      setIsAuthed(true);
      setUser(payload);
    },
    [redirectAdmin],
  );

  /** Revalidate a cached identity hint through the authoritative server. */
  const checkAuth = useCallback(async () => {
    checkControllerRef.current?.abort();
    checkControllerRef.current = null;
    if (!hasCachedAuthUser()) {
      setIsAuthed(false);
      setUser(null);
      setIsAuthChecked(true);
      return;
    }
    const controller = new AbortController();
    checkControllerRef.current = controller;
    try {
      const headers = asUserId != null ? { "x-studio-as-user-id": String(asUserId) } : undefined;
      const res = await fetch(`${apiBase}/api/auth/me`, {
        headers,
        credentials: "include",
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 401) {
          clearCachedAuthUser();
        }
        setIsAuthed(false);
        setUser(null);
        setIsAuthChecked(true);
        return;
      }
      const payload = await res.json();
      if (controller.signal.aborted) return;
      if (isAuthPayload(payload)) {
        applyAuthPayload(payload);
      } else {
        setIsAuthed(false);
        setUser(null);
        setIsAuthChecked(true);
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        setIsAuthed(false);
        setUser(null);
        setIsAuthChecked(true);
      }
    } finally {
      if (checkControllerRef.current === controller) checkControllerRef.current = null;
    }
  }, [apiBase, applyAuthPayload, asUserId]);

  useEffect(() => {
    return deferEffect(() => {
      checkAuth();
    });
  }, [checkAuth]);

  /** Consume one successful login/register response unless its action is obsolete. */
  const applySuccessfulAuth = useCallback(
    async (res, signal) => {
      let payload = null;
      try {
        payload = await res.json();
      } catch {}

      if (signal.aborted) return;
      setPassword("");
      setConfirmPassword("");
      setStatus("ready");

      if (isAuthPayload(payload) && asUserId == null) {
        applyAuthPayload(payload, { redirectAdminUser: true });
        return;
      }

      if (isAuthPayload(payload)) {
        setCachedAuthUser(payload);
      }
      await checkAuth();
    },
    [applyAuthPayload, asUserId, checkAuth, setStatus],
  );

  /** Submit one login while cancelling any obsolete auth mutation. */
  const login = useCallback(async () => {
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setIsBusy(true);
    setStatus("logging in");
    try {
      const response = await fetch(`${apiBase}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({ login: loginName, password }),
      });
      if (response.ok) await applySuccessfulAuth(response, controller.signal);
      else if (!controller.signal.aborted) {
        const message = await readAuthError(response, ui.messages.loginFailed);
        if (controller.signal.aborted) return;
        showNotice(message);
        setStatus("login failed");
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        showNotice(ui.messages.loginFailed);
        setStatus("login failed");
      }
    } finally {
      if (actionControllerRef.current === controller) {
        actionControllerRef.current = null;
        setIsBusy(false);
      }
    }
  }, [apiBase, applySuccessfulAuth, loginName, password, setIsBusy, setStatus, showNotice]);

  /** Submit one registration while cancelling any obsolete auth mutation. */
  const register = useCallback(async () => {
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setIsBusy(true);
    setStatus("registering");
    try {
      const response = await fetch(`${apiBase}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({ login: loginName, password, confirm_password: confirmPassword }),
      });
      if (response.ok) await applySuccessfulAuth(response, controller.signal);
      else if (!controller.signal.aborted) {
        const message = await readAuthError(response, ui.messages.registrationFailed);
        if (controller.signal.aborted) return;
        showNotice(message);
        setStatus("registration failed");
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        showNotice(ui.messages.registrationFailed);
        setStatus("registration failed");
      }
    } finally {
      if (actionControllerRef.current === controller) {
        actionControllerRef.current = null;
        setIsBusy(false);
      }
    }
  }, [apiBase, applySuccessfulAuth, confirmPassword, loginName, password, setIsBusy, setStatus, showNotice]);

  /** End the server session and report whether navigation may proceed. */
  const logout = useCallback(async () => {
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setIsBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) {
        const message = await readAuthError(response, ui.messages.actionFailed);
        if (controller.signal.aborted) return false;
        showNotice(message);
        setStatus("logout failed");
        return false;
      }
      clearCachedAuthUser();
      setIsAuthed(false);
      setUser(null);
      setIsRegisterMode(false);
      setPassword("");
      setConfirmPassword("");
      setStatus("logged out");
      return true;
    } catch (error) {
      if (error?.name !== "AbortError") {
        showNotice(ui.messages.actionFailed);
        setStatus("logout failed");
      }
      return false;
    } finally {
      if (actionControllerRef.current === controller) {
        actionControllerRef.current = null;
        setIsBusy(false);
      }
    }
  }, [apiBase, setIsBusy, setStatus, showNotice]);

  return {
    loginName,
    setLoginName,
    password,
    setPassword,
    confirmPassword,
    setConfirmPassword,
    isRegisterMode,
    setIsRegisterMode,
    isAuthed,
    isAuthChecked,
    user,
    setUser,
    checkAuth,
    login,
    register,
    logout,
  };
}
