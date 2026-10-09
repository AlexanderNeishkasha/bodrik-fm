# Meeting assets

Notification sounds were imported from the Bodrik MiroTalk SFU fork at
`d4148b634b593dcf81fa5c183d43b5b113762893` and retain the included AGPL-3.0 license.
`frontend/scripts/prepare-meeting-assets.mjs` copies these checked-in inputs and
npm-owned RNNoise/MediaPipe assets into the generated `public/meeting-assets/`.
No external fork or runtime CDN is required.
