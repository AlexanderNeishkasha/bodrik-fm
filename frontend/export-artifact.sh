#!/bin/sh
set -eu

if ! printf '%s' "${FRONTEND_RELEASE_ID:-}" | grep -Eq '^[0-9a-f]{40}-[0-9]+$'; then
  echo "FRONTEND_RELEASE_ID must be a commit SHA and numeric suffix" >&2
  exit 1
fi

target="/releases/$FRONTEND_RELEASE_ID"
staging="$target.staging"
test ! -e "$target"
test ! -e "$staging"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging"
cp -R /artifact/. "$staging/"

for file in \
  index.html studio.html puppet_master.html privacy.html terms.html meeting-unavailable.html \
  index.txt studio.txt puppet_master.txt privacy.txt terms.txt meeting-unavailable.txt
do
  test -s "$staging/$file"
done
find "$staging/_next/static" -type f -name '*.js' -size +0c -print -quit | grep -q .
mv "$staging" "$target"
trap - EXIT
