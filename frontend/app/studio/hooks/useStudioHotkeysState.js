import usePersistedState from "../../lib/usePersistedState";
import useHydrated from "../../lib/useHydrated";

export default function useStudioHotkeysState() {
  const [showHotkeys, setShowHotkeys] = usePersistedState({
    key: "hotkeys_studio",
    defaultValue: () => {
      if (typeof document === "undefined") {
        return true;
      }
      const attr = document.documentElement.getAttribute("data-hotkeys-studio");
      if (attr == null) {
        return true;
      }
      return attr === "true";
    },
    parse: (value) => value === "true",
    onPersist: (value) => {
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute(
          "data-hotkeys-studio",
          String(value)
        );
      }
    },
  });
  const isHydrated = useHydrated();

  return { showHotkeys, setShowHotkeys, isHydrated };
}
