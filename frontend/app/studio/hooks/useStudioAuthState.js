import { useState } from "react";
import useStudioAuth from "./useStudioAuth";

export default function useStudioAuthState({
  apiBase,
  asUserId,
  showNotice,
  setStatus,
}) {
  const [authBusy, setAuthBusy] = useState(false);
  const {
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
    login,
    register,
    logout,
  } = useStudioAuth({
    apiBase,
    asUserId,
    showNotice,
    setStatus,
    setIsBusy: setAuthBusy,
  });

  return {
    authBusy,
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
    login,
    register,
    logout,
  };
}
