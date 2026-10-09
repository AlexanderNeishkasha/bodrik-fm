/** Merge a newly observed room snapshot without losing API-only invitation data or crossing identities. */
export function reconcileConferenceRoomSnapshot(previous, scope, roomState) {
  const base = previous.scope === scope ? previous : { scope, allowed: false, enabled: false, inviteUrl: null };
  return {
    ...base,
    allowed: typeof roomState?.conference_allowed === "boolean" ? roomState.conference_allowed : base.allowed,
    enabled: typeof roomState?.conference_enabled === "boolean" ? roomState.conference_enabled : base.enabled,
  };
}
