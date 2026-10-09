/** Bind one caller-owned track and release only the element attachment created here. */
export function bindMediaTrack(element, track, createStream = (tracks) => new MediaStream(tracks)) {
  const stream = createStream([track]);
  element.srcObject = stream;
  return () => {
    if (element.srcObject === stream) element.srcObject = null;
  };
}
