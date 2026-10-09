"use client";

import { useCallback, useEffect, useState } from "react";
import { deferEffect } from "./deferEffect";
import { detectRoomSlug, roomPath } from "./mainRouting.mjs";

const UNRESOLVED_ROUTE = {
  roomSlug: null,
  invalidPath: false,
  isRouteResolved: false,
};

/** Own browser history and the current room route for the static SPA fallback. */
export default function useMainRoute() {
  const [route, setRoute] = useState(UNRESOLVED_ROUTE);

  useEffect(() => {
    const syncRoute = () => setRoute({ ...detectRoomSlug(), isRouteResolved: true });
    const cancelInitialSync = deferEffect(syncRoute);
    window.addEventListener("popstate", syncRoute);
    return () => {
      cancelInitialSync();
      window.removeEventListener("popstate", syncRoute);
    };
  }, []);

  const replaceRoom = useCallback((nextSlug) => {
    if (!nextSlug || nextSlug === route.roomSlug) return;
    window.history.replaceState(window.history.state, "", roomPath(nextSlug));
    setRoute({ roomSlug: nextSlug, invalidPath: false, isRouteResolved: true });
  }, [route.roomSlug]);

  const navigateHome = useCallback(() => {
    window.history.pushState(window.history.state, "", "/");
    setRoute({ roomSlug: null, invalidPath: false, isRouteResolved: true });
  }, []);

  const navigateRoom = useCallback((event, nextSlug) => {
    event.preventDefault();
    if (!nextSlug) return;
    window.history.pushState(window.history.state, "", roomPath(nextSlug));
    setRoute({ roomSlug: nextSlug, invalidPath: false, isRouteResolved: true });
  }, []);

  return {
    ...route,
    replaceRoom,
    navigateHome,
    navigateRoom,
  };
}
