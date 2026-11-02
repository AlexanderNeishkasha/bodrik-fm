import RangeControl from "../../../components/ui/RangeControl";
import { t } from "../../lang/index.js";

/** Render shared seek styling while retaining Studio's existing preview/commit events. */
export default function NowPlayingSeek({
  seekValue,
  seekMax,
  onSeekChange,
  onSeekCommit,
}) {
  return (
    <div className="space-y-2">
      <RangeControl
        label={t("studio.hotkeys.seek")}
        min="0"
        max={seekMax}
        step="1"
        value={Number(seekValue)}
        onChange={onSeekChange}
        onMouseUp={onSeekCommit}
        onTouchEnd={onSeekCommit}
        onKeyUp={onSeekCommit}
      />
    </div>
  );
}
