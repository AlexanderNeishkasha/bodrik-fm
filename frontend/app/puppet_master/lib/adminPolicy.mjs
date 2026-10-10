/** Return the next monotonic draft revision for one admin user. */
export function nextRequestRevision(previous) {
  return (previous?.revision ?? 0) + 1;
}

/** Return whether a response still owns the latest user draft revision. */
export function ownsRequestRevision(current, revision) {
  return current?.revision === revision;
}

/** Build a password reset payload without trimming meaningful password whitespace. */
export function passwordResetPayload(password) {
  return typeof password === "string" && password.length > 0 ? { password } : null;
}

/** Replace one admin user row while preserving all unrelated rows and fields. */
export function updateAdminUser(rows, userId, patch) {
  return rows.map((row) => (row.id === userId ? { ...row, ...patch } : row));
}
