# ASCII generator — v1

Static site source only. Plain HTML/CSS/JS, no build step, no backend, no npm.
Local files only — **not pushed, not deployed**. The agreed resting spot is
`ascii.maniac.ceo`, but nothing here creates a repo, a Pages project, or a deploy.

## Files

- `index.html` — layout: sidebar (converter / bases / motions / controls /
  canvas / palette / export) + stage + formula explainer.
- `styles.css` — ASCII UI: black first, pink `#FF6EC8` + white only, monospace.
- `app.js` — everything. JS port of `~/workspace/ascii-banner`
  (`CascadeBadge/ascii-banner`).

## Preview locally

```bash
cd ~/workspace/goals/ascii-discord-banner/files/ascii-generator-v1
python3 -m http.server 8000
# open http://localhost:8000/
```

`file://` also works for the app itself, but the GIF decoder (below) is
loaded from a CDN, so the http-server route is the honest test.

## What works in v1

- **Sidebar, grouped as specced.** Converter / Bases (Wave, Ripples, Spiral,
  Rain, Rain-tips spelling x-a-z-i-s-s, Starfield, Pulsing rings) / Motions
  (Orbit v3, Explode, Spin 3D, R-spin). A “base under motion” dropdown layers
  any base under any motion, the way the Python scripts layer letters on a base.
  Word input, default `xaziss`, editable (letters only, max 12).
- **Sliders, mapped to real params.** Cols/chunk size (rows derived exactly
  like `gif_to_ascii.py`: `rows = round(cols · H/W · 0.507)`), font size
  (auto-fits the cell when cols/canvas change), gamma (default 0.75), floor
  (0–255, default 0), fps/speed (120-frame loop, so loop seconds = 120/fps),
  sparkles (28 / 56 / 84 — the dials already judged), explosion distance
  (max px, Python flies cells 80–220), glyph re-roll rate (1–20/sec).
  All show live values.
- **Canvas.** Presets: Discord profile 1360×480, Discord display 680×240,
  server 960×540, square 960×960, custom W×H, and a full-bleed toggle that
  makes the canvas fill the stage. The canvas element really resizes.
- **Converter — JS port of `gif_to_ascii.py`.** Rec. 709 luminance, percentile
  tonemap (clip 1st/99.5th, gamma), density ramp `.:-=+*#%@`, per-cell source
  colour, `--fit` / centre-crop, `--key-green`, `--trim-green`,
  `--floor`, `--bold`, `--mono` toggles. Drag-drop + file picker.
  A synthetic demo image loads by default so the converter works with no upload.
- **GIFs.** Animated GIFs are decoded with gifuct-js from the CDN
  (`cdn.jsdelivr.net/npm/gifuct-js@2.1.2`), frames composited (full frames),
  capped at 90 frames like Python's `--max-frames`. **If the CDN is
  unreachable or decoding fails, the app falls back to the browser's first
  frame and says so in the status bar** — it never pretends a still is an
  animation. Status shows “N frames, animated” or “first frame only”.
- **Palettes.** An upload is quantized to 8 dominant colours (small seeded
  k-means); each swatch is a colour input that remaps that cluster in the
  converter output. Plus base / sparkle / burst colour pickers and a
  lock-letters-white toggle (on by default). Defaults: black `#000000`,
  pink `#FF6EC8`, white `#FFFFFF`.
- **Export (v1).** Copy ASCII text (current frame), Download PNG (current
  frame, from the canvas), Download HTML (standalone file with the ASCII as
  real text). GIF export is **disabled with a “v2” label — not implemented**.
- **Rendering.** Animated preview on `<canvas>`; a Text view toggle shows the
  current frame as real selectable ASCII text (cell-resolution transcription
  of the canvas frame, including stamped overlay letters), like shaymin-site.
  A “how this formula works” panel under the stage explains the current
  formula in plain words.
- **Loops.** Everything generative runs the house tempo: 120 frames, 20 fps
  default, seamless loop (wave LCM 120, rain whole falls per loop, sparkles
  modulo-120 lifetimes, explode reassembled by f115).

## Honest fallbacks / known differences from Python

- **Sampling is bilinear, not Lanczos.** Browser `drawImage` downsampling is
  not Pillow's Lanczos, so converter edges/tones are close, not bit-identical.
- **Fonts are the browser monospace stack** (`"DejaVu Sans Mono", monospace`),
  not the DejaVu files at `/usr/share/fonts/...` — cell ratio 0.507 is kept,
  but exact glyph shapes depend on the machine.
- **Starfield is the v2 version** (3 shooting stars per loop, one per 40
  frames). The v3 “crazy” exploding-meteor version (blast wave flinging stars
  home as damped oscillation) is **not** in v1.
- **R-spin is a large-glyph approximation**, not the bitmap version: each
  letter is one glyph squashed by cos(eased angle), with the black edge slab.
  The cos-ease, 50-frame rotation + 12-frame hold, and reversed direction are
  real.
- **Base colour picker:** with the default house pink, bases use the Python
  `palette_color()` pink→purple→white gradient. Picking another base colour
  switches bases to single-hue (that colour scaled by brightness).
- **Orbit v3 back letters change every frame by design** (20/sec at 20 fps);
  the glyph re-roll slider does not slow them — it governs rain, sparkles,
  explode and spin cells, which are 10/sec in Python.
- **Canvas resize in converter mode re-fits the already-fitted source**
  instead of the original upload, so repeated resizes lose a little quality.
  Re-upload to get a clean fit at a new size.
- **Text view is a transcription**, not a separate renderer: overlay letters
  are stamped into the nearest grid cell, so a spinning letter reads as one
  character in the text, not a bitmap.
- **Sparkles (28 by default) are drawn behind every generative mode**,
  including base-only views; set sparkles to 0 to judge a base alone.

## Deferred to v2 (not in this build)

- GIF export.
- Starfield v3 exploding meteors.
- maniac.ceo rings + rotating cycling word as its own formula.
- DOVE / CRT shader.
- Anything that needs a backend.

## Verification

- `node --check app.js` — passes.
- All files referenced by `index.html` (`styles.css`, `app.js`) exist in this
  folder; the only external dependency is the gifuct-js CDN, loaded on demand
  for GIF uploads only, with a labelled first-frame fallback.
- No push, deploy, repo creation, or Pages project was made from this build.
