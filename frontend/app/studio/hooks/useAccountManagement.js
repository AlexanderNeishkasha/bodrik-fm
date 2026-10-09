import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ui } from "../../lang/ru";
import { localizeApiMessage } from "../lib/localizeApiMessage";
import { clearCachedAuthUser } from "../../lib/authSession";

/** Read and localize one public account error response. */
async function readApiMessage(res, fallback) {
  try {
    const data = await res.json();
    return data?.message ? localizeApiMessage(data.message, fallback) : fallback;
  } catch {
    return fallback;
  }
}

/** Own account modal drafts and cancellable account mutations. */
export default function useAccountManagement({ apiBase, showNotice, setStatus }) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const controllerRef = useRef(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  /** Clear all password-change drafts after close or success. */
  const resetPasswordFields = useCallback(() => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }, []);

  /** Close the account modal only when no mutation owns it. */
  const close = useCallback(() => {
    if (isBusy) {
      return;
    }
    setIsOpen(false);
    resetPasswordFields();
    setDeletePassword("");
  }, [isBusy, resetPasswordFields]);

  const changePassword = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsBusy(true);
    setStatus("changing password");
    try {
      const response = await fetch(`${apiBase}/api/account/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
          confirm_password: confirmPassword,
        }),
      });
      if (response.ok) {
        resetPasswordFields();
        showNotice(ui.messages.passwordChanged);
        setStatus("ready");
      } else {
        const message = await readApiMessage(response, ui.messages.passwordChangeFailed);
        if (controller.signal.aborted) return;
        showNotice(message);
        setStatus("password change failed");
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        showNotice(ui.messages.passwordChangeFailed);
        setStatus("password change failed");
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setIsBusy(false);
      }
    }
  }, [apiBase, confirmPassword, currentPassword, newPassword, resetPasswordFields, setStatus, showNotice]);

  const deleteAccount = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsBusy(true);
    setStatus("deleting account");
    try {
      const response = await fetch(`${apiBase}/api/account/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({ current_password: deletePassword }),
      });
      if (response.ok) {
        clearCachedAuthUser();
        setStatus("account deleted");
        router.replace("/");
        return;
      }
      const message = await readApiMessage(response, ui.messages.accountDeleteFailed);
      if (controller.signal.aborted) return;
      showNotice(message);
      setStatus("account delete failed");
    } catch (error) {
      if (error?.name !== "AbortError") {
        showNotice(ui.messages.accountDeleteFailed);
        setStatus("account delete failed");
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setIsBusy(false);
      }
    }
  }, [apiBase, deletePassword, router, setStatus, showNotice]);

  /** Open the account modal without mutating its current drafts. */
  const open = useCallback(() => setIsOpen(true), []);

  return {
    isOpen,
    isBusy,
    currentPassword,
    newPassword,
    confirmPassword,
    deletePassword,
    open,
    close,
    setCurrentPassword,
    setNewPassword,
    setConfirmPassword,
    setDeletePassword,
    changePassword,
    deleteAccount,
  };
}
