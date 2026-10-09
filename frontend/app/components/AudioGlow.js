/** Two fixed glow surfaces crossfade without repainting shadow radii. */
export default function AudioGlow() {
  return <><span aria-hidden="true" className="audio-glow-layer audio-glow-near" /><span aria-hidden="true" className="audio-glow-layer audio-glow-wide" /></>;
}
