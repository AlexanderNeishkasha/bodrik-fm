import { ru } from "./ru.js";

/** Resolve one UI-copy key and interpolate its named string parameters. */
export function t(key, parameters = {}) {
  const value = readPath(ru, key);
  if (value === undefined) throw new Error(`Unknown UI copy key: ${key}`);
  if (typeof value !== "string") return value;
  return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.hasOwn(parameters, name) ? String(parameters[name]) : match
  ));
}

/** Read only own properties from a dot-separated dictionary path. */
function readPath(dictionary, key) {
  if (typeof key !== "string" || key.length === 0) return undefined;
  let value = dictionary;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
