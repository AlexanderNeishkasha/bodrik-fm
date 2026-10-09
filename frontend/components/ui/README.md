# Shared UI controls

Small React primitives for the static Next frontend and isolated meeting islands.
These are source imports, not a separate package or another settings store.

| Primitive | Consumers |
| --- | --- |
| `RangeControl` | Public player volume, Studio volume/seek, meeting output volume |
| `Icon` | Existing player/Studio imports via compatibility re-export, React About and meeting settings |
| `SwitchControl` | Meeting echo/gain, PTT and speaker focus; native Studio checkboxes are intentionally unchanged |
| `SelectControl`, `Button` | Meeting audio/video/background controls, Profile forms, speaker test and explicit camera-access action |
| `HelpTooltip` | Meeting setting labels; accent border/hover, focus and Escape dismissal, escaped text |

## Boundaries

- Primitives render controlled values and forward input changes. No storage,
  API calls, audio graph, socket, admission or meeting state belongs here.
- `SelectControl` uses a themed combobox/listbox with keyboard navigation, typeahead,
  touch selection and viewport fitting. Its popover escapes panel overflow while
  inheriting the theme; older browsers use a fixed list. `onChange` receives
  `{ target: { value }, currentTarget: { value } }`, rather than a native event.
  Choices and device commands remain with consumers.
- `Button` is the player's pill button: ghost by default, `variant="accent"` for a
  primary action and `variant="danger"`. It defaults to `type="button"`; explicit
  `submit`/`reset` are forwarded.
  Forms and command outcomes belong to consumers, not the primitive.
- `RangeControl` accepts arbitrary native units (player 0–1, meeting 0–100,
  seek seconds). Preview/commit callbacks remain with consumers: changing visuals
  must not change mute, autoplay unlock, seek or persistence behavior.
- CSS Modules are self-contained, including range track/thumb rules. Do not import
  player Tailwind/preflight or legacy meeting globals into a ShadowRoot.
- Shared styles use `--theme-*` tokens with safe fallbacks. The meeting applies the
  player's theme via `data-theme` and its tokens (`features/meeting/meetingTheme.module.css`),
  so these primitives look the same in the player and the meeting. Embedding boundaries
  can override `--ui-accent`, `--ui-border`, `--ui-track`, `--ui-contrast`,
  `--ui-halo` and `--ui-surface`; meeting-specific variables stay in the adapter CSS.
- Help uses an owned body-level ShadowRoot layer outside settings overflow/transform.
  Only the tooltip CSS Module rules are projected into it. Theme appearance and
  viewport geometry are derived from the anchor while visible; observers/listeners
  are removed on close. The original hidden description remains in the anchor root
  for accessible `aria-describedby` resolution across shadow boundaries.
- Switch transitions are 140ms; switch/button/help styles honor reduced motion.
  Tooltip overlays do not change row height, and a dismissed tooltip lets Escape
  propagate to the owning panel.
- `Icon` uses the existing `lucide-react` dependency and provides an intrinsic size
  for contexts without Tailwind classes. Icons are decorative; their enclosing
  button/control supplies its accessible name.
- Feature-level `SettingRow` and `SettingSlider` compose labels, percentages and
  command adapters. They do not move player/Studio domain logic into this library.

Run frontend lint/tests, island build and an isolated production export. Browser
acceptance must include ordinary Next consumers and ShadowRoot consumers; an
island-only check is not proof of the running Next dev server's compiled version.
