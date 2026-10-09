import { useEffect } from "react";

export default function useStudioCurrentLabel({
  state,
  displayName,
  noTrackLabel,
  fetchTracks,
}) {
  const currentLabel = state?.current
    ? displayName(state.current.filename)
    : noTrackLabel;

  useEffect(() => {
    if (state?.library_version == null) {
      return;
    }
    fetchTracks({ reason: "library_version" });
  }, [fetchTracks, state?.library_version]);

  return currentLabel;
}
