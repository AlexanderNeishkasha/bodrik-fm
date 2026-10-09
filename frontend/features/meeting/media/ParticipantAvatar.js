import { assetUrl } from "../../../app/lib/asset";

/** Render the retained circular name avatar without embedding participant text in an SVG URL. */
export default function ParticipantAvatar({ participant }) {
  const name = participant.name;
  const first = name.charCodeAt(0) || 0;
  const second = name.charCodeAt(1) || first;
  const red = Math.pow(first, 7) % 200;
  const green = Math.pow(second, 7) % 200;
  const blue = (red + green) % 200;
  return <svg viewBox="0 0 250 250" width="250" height="250" role="img" aria-label={participant.bot ? "Бодрик FM" : name}>
    {participant.bot || participant.avatar
      ? <image href={participant.bot ? assetUrl("/images/bodrik-ava.png") : participant.avatar} width="250" height="250" />
      : <>
          <circle fill={`rgb(${red}, ${green}, ${blue})`} cx="125" cy="125" r="125" />
          <text x="50%" y="50%" textAnchor="middle" fontSize="100" fontWeight="normal" dy=".1em" dominantBaseline="middle" fill="#ffffff">
            {name.slice(0, 2).toUpperCase()}
          </text>
        </>}
  </svg>;
}
