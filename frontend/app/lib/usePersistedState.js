import { useEffect, useRef, useState } from "react";
import { getStoredValue, setStoredValue } from "./storageKeys";

export default function usePersistedState({
  key,
  defaultValue,
  parse = (value) => value,
  serialize = (value) => String(value),
  onPersist,
}) {
  const [value, setValue] = useState(() =>
    typeof defaultValue === "function" ? defaultValue() : defaultValue
  );
  const [ready, setReady] = useState(false);
  const parseRef = useRef(parse);
  const serializeRef = useRef(serialize);
  const onPersistRef = useRef(onPersist);

  useEffect(() => {
    parseRef.current = parse;
  }, [parse]);

  useEffect(() => {
    serializeRef.current = serialize;
  }, [serialize]);

  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  useEffect(() => {
    let stored = null;
    try {
      stored = getStoredValue(key);
    } catch {}
    if (stored != null) {
      try {
        setValue(parseRef.current(stored));
      } catch {}
    }
    setReady(true);
  }, [key]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    try {
      setStoredValue(key, serializeRef.current(value));
    } catch {}
    if (onPersistRef.current) {
      onPersistRef.current(value);
    }
  }, [key, ready, value]);

  return [value, setValue, ready];
}
