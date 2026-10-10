/** Return whether a caught request failure is an intentional cancellation. */
export function isAbortError(error) {
  return error?.name === "AbortError";
}
