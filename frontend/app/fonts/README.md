# Self-hosted theme fonts

These WOFF2 files are unmodified subset assets from Fontsource `5.3.0` packages:
`@fontsource-variable/*` where a weight axis exists and `@fontsource/*` for
Alegreya Sans and Montserrat Alternates. Only the Latin and available Cyrillic
subsets used by the application are retained. Sora, Space Grotesk and Work Sans
do not ship Cyrillic subsets and intentionally fall back to the configured generic
sans-serif face for Cyrillic text, matching their prior browser behavior.

Each family keeps its upstream SIL Open Font License and copyright notice under
`licenses/<family>.txt`. `definitions/*.css` maps the retained files and Unicode
ranges; `fonts.css` imports those definitions and owns the CSS variables consumed
by themes.

When updating fonts, keep package versions consistent, copy files without modifying
them, retain updated licenses/attribution, and run `bun run --cwd frontend test` plus a
production build. The font integrity test rejects missing assets, licenses, variables,
or reintroduced `next/font/google` imports.
