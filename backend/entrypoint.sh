#!/bin/sh
set -eu

seed_path=${YTDLP_SEED_PATH:-/usr/local/share/yt-dlp/yt-dlp}
target_path=${YTDLP_PATH:-/data/yt-dlp/yt-dlp}
target_dir=${target_path%/*}
if [ "$target_dir" = "$target_path" ]; then
  target_dir=.
fi

temporary_path=
cleanup() {
  if [ -n "$temporary_path" ]; then
    rm -f "$temporary_path"
  fi
}
trap cleanup 0 1 2 15

if [ ! -e "$target_path" ]; then
  temporary_path="$target_dir/.yt-dlp.seed.$$"
  echo "Seeding yt-dlp at $target_path"
  cp "$seed_path" "$temporary_path"
  chmod 0755 "$temporary_path"
  mv -f "$temporary_path" "$target_path"
  temporary_path=
fi

trap - 0 1 2 15
exec "$@"
