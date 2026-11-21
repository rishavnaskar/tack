# Fanfold — brand kit v1

**Name.** *fanfold* — paper folded in a continuous accordion, so one sheet opens page after page.
The product asks once, fans out across the web, and folds the results back into one list.
Doubles as the feature verb: "run a fanfold".

**Mark.** Four pages fanning from one pivot (the fan-out). Three ink, one orange — the page
being read right now. The front page has a folded corner so it reads as a document.

## Files
- `svg/mark-*.svg` — the mark, 100×100 viewBox, scales to any size. `-light` for paper backgrounds,
  `-dark` for ink backgrounds (the knock-out gaps are tinted to the background), `-mono-*` single colour.
- `svg/wordmark-*.svg` — "Fanfold" as outlined vector paths (Host Grotesk 520, −4.5% tracking) — no font needed.
- `svg/lockup-horizontal-*.svg`, `svg/lockup-stacked-*.svg` — mark + wordmark, spacing locked.
- `svg/app-icon-*.svg` — 1024 grid, rx 228. Orange is the primary app icon.
- `favicon/` — `favicon.svg` (preferred), `favicon.ico` (16/32/48/64), PNG fallbacks, `fanfold-apple-touch-icon-180.png`.
- `png/` — transparent PNG exports at web/retina sizes.

## Colours
Ink #0B0B0C · Paper #F7F6F4 · Orange #F0521C · Orange light #FF7A3D (on dark) · Rust #B93714 (eyebrows) · Line #E2DED7

## Type
Headlines: Host Grotesk 500, tracking −0.045em. Labels/code: JetBrains Mono 500/700, tracking +0.2em, uppercase.

## Rules
- Minimum mark size 16 px. Below 24 px use `favicon.svg` (wider knock-out gaps).
- Clear space around the mark ≥ the width of one page.
- Don't recolour the pages individually; the only accent is the front page.
- Don't rotate or mirror the fan.

## HTML snippet
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/fanfold-apple-touch-icon-180.png">
