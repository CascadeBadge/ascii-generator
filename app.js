/* ASCII generator v1 — plain JS, no build step, no backend.
 *
 * JS port of ~/workspace/ascii-banner (CascadeBadge/ascii-banner):
 *   gif_to_ascii.py  — Rec.709 luminance, percentile tonemap (clip 1st /
 *     99.5th, gamma 0.75), density ramp " .:-=+*#%@ ", per-cell source colour.
 *   ascii_effect.py / ascii_effect_orbit.py — wave + palette_color().
 *   ascii_effect_bases.py / bases2.py — ripples, spiral, rain, starfield,
 *     pulsing rings. All 120-frame / 6 s perfect loops.
 *   ascii_effect_orbit_effects_v3.py — orbit v3, sparkles, bursts.
 *   ascii_effect_explode_v2.py — explode, per-cell scatter + bursts.
 *   ascii_effect_spin_3d_v4/v5.py — spin 3D, bitmap letters, extrusion.
 *   R-style spin — cos-eased, slow at faces, fast through edges.
 * Differences from Python are noted in README.md (browser canvas sampling
 * is bilinear, not Lanczos; fonts are the browser's monospace stack).
 */
'use strict';

/* ---------- constants from the Python repo ---------- */
var RAMP = ' .:-=+*#%@';
var CELL_RATIO = 0.507; // char width / char height, DejaVu Sans Mono at 16px
var N_FRAMES = 120;     // house tempo: 120 frames, 6 s, 50 ms/frame
var GLYPHS = ['#', '%', '@', '&', '$', 'X', '8', '0', '*', '+'];
var SPARKLE_GLYPHS = ['+', '*', '\u2022', '\u00f7', '\u00d7', '\u00b0', '#', '%'];
var RAIN_GLYPHS = '01#%@&$*+.:=xaziss'.split('');
var RAIN_TIP_SEQ = ['x', 'a', 'z', 'i', 's', '_', 's'];
var HOUSE = { black: '#000000', pink: '#ff6ec8', white: '#ffffff' };

/* ---------- deterministic RNG (Python random.Random(seed) equivalent in spirit:
 * same seed -> same sequence, every load, so loops stay seamless ---------- */
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(n) { // scramble an integer seed the way a hash would
  var x = (n >>> 0) || 1;
  x = Math.imul(x ^ (x >>> 16), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  return (x ^= x >>> 16) >>> 0;
}
// Random glyph for this tick, guaranteed different from the previous tick's
// glyph for the same seed — the orbit v3 / explode pick_glyph rule.
function pickGlyph(tick, seedId, glyphs) {
  glyphs = glyphs || GLYPHS; // Python default: the letter glyph set
  var g = glyphs[Math.floor(mulberry32(hashSeed(tick * 1000 + seedId))() * glyphs.length)];
  if (tick > 0) {
    var prev = glyphs[Math.floor(mulberry32(hashSeed((tick - 1) * 1000 + seedId))() * glyphs.length)];
    if (g === prev) g = glyphs[(glyphs.indexOf(g) + 1) % glyphs.length];
  }
  return g;
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
function hexToRgb(hex) {
  var h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbStr(rgb, alpha) {
  if (alpha === undefined || alpha >= 1) return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
  return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
}
function rgbHex(rgb) {
  return '#' + rgb.map(function (v) { return clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'); }).join('');
}
// palette_color() from ascii_effect.py: pink -> purple gradient, white at peaks.
function paletteColor(v) {
  if (v < 0.25) return [80, 0, 90];
  if (v < 0.5) return [170, 40, 160];
  if (v < 0.75) return [255, 70, 180];
  if (v < 0.92) return [200, 110, 255];
  return [255, 120, 220];
}

/* ---------- state ---------- */
var state = {
  mode: 'wave',            // converter | wave | ripples | spiral | rain | rain-tips | starfield | pulsing | orbit | explode | spin3d | rspin
  motionBase: 'wave',      // base drawn under a motion
  word: 'xaziss',
  cols: 80,
  fontSize: 28,            // px; auto-fit to the cell on cols/canvas change
  gamma: 0.75,
  floor: 0,
  fps: 20,
  sparkles: 28,
  explodeMax: 220,         // px at 1360 wide; cells fly 80-220 in Python
  reroll: 10,              // glyph changes / sec for rain, sparkles, explode, spin
  bursts: true,
  fit: true, keyGreen: false, trimGreen: false, bold: false, mono: false,
  canvasW: 1360, canvasH: 480,
  fullBleed: false,
  playing: true,
  view: 'canvas',          // canvas | text
  baseColor: '#ff6ec8', sparkleColor: '#ff6ec8', burstColor: '#ffffff',
  letterColor: '#ffffff', lockWhite: true,
  remapEnabled: true,
};
var BASE_MODES = ['wave', 'ripples', 'spiral', 'rain', 'rain-tips', 'starfield', 'pulsing'];
var MOTION_MODES = ['orbit', 'explode', 'spin3d', 'rspin'];
var FORMULAS = {
  converter: 'Image → ASCII, the gif_to_ascii.py pipeline. Each frame is fit or centre-cropped to the canvas, sampled down to the character grid, then per cell: luminance = 0.2126·R + 0.7152·G + 0.0722·B (Rec. 709). Luminance is tonemapped by clipping the 1st and 99.5th percentiles and raising to gamma (default 0.75) — an adaptive tonemap, not a linear gain — then mapped to the density ramp " .:-=+*#%@ ", so bright = dense. Each character is drawn in its source pixel colour (or white in mono). Green-screen pixels can be keyed to black, and the floor slider zeroes dim pixels before tonemapping so a dark background does not get lifted into visible characters.',
  wave: 'Wave — the original base. A pink band flowing across the banner: centre = rows/2 + 2.2·sin(x·0.22 + phase) + 1.2·sin(x·0.11 − phase·1.5), brightness falls off with distance from the centre line, with a ripple texture sin(x·0.9 + y·0.7 + phase·2). Phase advances 2π per 60 frames; the three sine terms have periods 60 / 40 / 30 frames, so the least common multiple is 120 — the loop is seamless at 120 frames, 6 seconds.',
  ripples: 'Ripples — concentric rings expanding from the centre, like a stone dropped in water over and over. brightness = sin(distance·0.045 − phase), phase advances 2π every 30 frames (4 cycles per loop), fading with distance so the centre glows and the edges go quiet black.',
  spiral: 'Spiral — three spiral arms rotating around the centre. value = sin(3·angle + radius·0.035 − phase), phase advances 2π every 60 frames (2 rotations per loop). Trippy, like the circle effect on shaymin.net, as a full-banner base.',
  rain: 'Rain — Matrix-style vertical streams. Each column has its own drop head with a 4-cell fading trail; ~60% of columns rain at once, speeds are 28 or 56 cells per 120 frames so every column completes a whole number of falls per loop. Glyphs re-roll at the glyph rate, head brightest, trail fading.',
  'rain-tips': 'Rain, with the tip of each drop spelling the word as it falls: the tip cycles x → a → z → i → s → _ → s, one letter per row, so each drop spells at its own rate and out of sync. The tail stays normal glyphs. Loop-perfect: rows × step is a multiple of 7, so the sequence continues across the bottom-to-top wrap.',
  starfield: 'Starfield — a quiet black sky, ~140 twinkling stars (white or pink) on 30 / 60 / 120-frame periods, gently floating, plus three shooting stars per loop, one every 40 frames, with a long bright trail. The calmest base — the letters do all the talking. (The v3 “crazy” exploding-meteor version is not in v1 — see README.)',
  pulsing: 'Pulsing rings — three fixed rings around the centre (radii ~120 / 220 / 320 px) lighting up in sequence, inner → middle → outer, period 60 frames, like a sonar / heartbeat. The centre glows on the opposite beat. Unlike ripples, the rings stay put and breathe.',
  orbit: 'Orbit v3 — the landed banner. The word travels an ellipse (RX 470, RY 145 at 1360×480), 2 orbits per 6-second loop, over the base. Front letters are their true letter, white, no flicker. Back letters are a single random glyph (# % @ & $ X 8 0 * +), changing every frame and guaranteed different from the previous frame. Sparkles sit behind everything at 70% opacity max. When a letter reaches front centre, a ring of that letter itself bursts out (life 10 frames, so bursts never overlap and mix). First frame spells “xaz” with a in the centre front.',
  explode: 'Explode — no rotation. Each letter’s ASCII cells fly out from the letter centre on their own random direction (80–220 px), then fly back home, left to right, 5 frames apart: x f20, a f25, z f30, i f35, s f40, s f45. 30 frames out, ~10 scattered, 30 back, assembled again by f115. Scattered cells fade to mid-grey and back to white. At each letter’s pop moment a ring of that letter bursts out (16 particles, life 15 frames).',
  spin3d: 'Spin 3D — chunky 10×12-cell letters spinning in place on their Y axis, width = cos(angle), 1 rotation per 60 frames, edge-on order X, A, Z, I, S, S from frame 0. Three extrusion layers (dark → mid → bright front) with a rotating vector: down-right at full face, purely sideways at edge-on, so the edge-on letter is a slab in the letter’s own shape, not a rectangle. Random glyphs per cell re-roll at the glyph rate, the same glyph in all three layers. Front white, back mid-grey.',
  rspin: 'R-spin — from the rotating-R reference GIF. Letters spin on their Y axis with a cos-eased cycle: slow at full faces, fast through edges, 50 frames of rotation + a 12-frame hold at front, reversed direction, solid side fill, a solid black slab at the edge. V1 draws each letter as one large glyph (not a bitmap) — see README.',
};

/* ---------- dom ---------- */
var $ = function (id) { return document.getElementById(id); };
var canvas = $('stageCanvas'), ctx = canvas.getContext('2d');
var textView = $('textView'), stageEl = $('stage');
var statusMode = $('statusMode'), statusGrid = $('statusGrid'), statusGif = $('statusGif'), statusMsg = $('statusMsg');
var formulaText = $('formulaText');

/* ---------- grid helpers (gif_to_ascii.py grid_for) ---------- */
function gridDims() {
  var cols = state.cols;
  var rows = Math.max(8, Math.round(cols * (state.canvasH / state.canvasW) * CELL_RATIO));
  return { cols: cols, rows: rows };
}
function cellSize() {
  var cw = state.canvasW / state.cols;
  return { w: cw, h: cw / CELL_RATIO };
}
function effectiveFont() {
  var cs = cellSize();
  return clamp(state.fontSize, 6, Math.max(8, Math.round(cs.h * 0.98)));
}
function autoFitFont() {
  var cs = cellSize();
  state.fontSize = clamp(Math.round(cs.h * 0.85), 8, 40);
  $('fontSlider').value = state.fontSize;
  $('fontVal').textContent = state.fontSize;
}
function makeCells(cols, rows) {
  var cells = new Array(rows);
  for (var y = 0; y < rows; y++) { cells[y] = new Array(cols); for (var x = 0; x < cols; x++) cells[y][x] = null; }
  return cells;
}
function emptyTextGrid(cols, rows) {
  var g = [];
  for (var y = 0; y < rows; y++) g.push(new Array(cols).fill(' '));
  return g;
}

/* ---------- base colour ---------- */
// Default: the Python palette_color() gradient. If the user picks a base
// colour other than the house pink, bases render single-hue: that colour
// scaled by brightness. (Documented in README.)
function baseColour(bright) {
  if (state.baseColor.toLowerCase() === HOUSE.pink) return paletteColor(bright);
  var c = hexToRgb(state.baseColor);
  return [Math.round(c[0] * bright), Math.round(c[1] * bright), Math.round(c[2] * bright)];
}

/* ---------- bases: return { cells, text } ----------
 * cells[y][x] = { ch, rgb } | null. text is the plain-text transcription
 * (same grid, chars only) used by the Text view / copy / export. */
function computeBase(kind, frame, cols, rows, W, H) {
  var cells = makeCells(cols, rows);
  var text = emptyTextGrid(cols, rows);
  var sx = W / 1360, sy = H / 480, s = Math.min(sx, sy);
  var tick = Math.floor(frame * state.reroll / state.fps); // glyph re-roll tick
  var x, y, bright, ch;
  var cx = W / 2, cy = H / 2;
  if (kind === 'wave' || kind === 'ripples' || kind === 'spiral' || kind === 'pulsing') {
    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++) {
        var dx = (x + 0.5) * (W / cols) - cx;
        var dy = ((y + 0.5) * (H / rows) - cy) * 1.5; // elliptical, wide banner
        var d = Math.sqrt(dx * dx + dy * dy);
        if (kind === 'wave') {
          var phase = 2 * Math.PI * frame / 60;
          var centre = rows / 2 + 2.2 * Math.sin(x * 0.22 + phase) + 1.2 * Math.sin(x * 0.11 - phase * 1.5);
          var dd = Math.abs(y - centre);
          bright = clamp(1 - dd / 2.5, 0, 1);
          bright *= 0.75 + 0.25 * Math.sin(x * 0.9 + y * 0.7 + phase * 2);
        } else if (kind === 'ripples') {
          var rphase = 2 * Math.PI * frame / 30;
          bright = clamp((0.5 + 0.5 * Math.sin(d * 0.045 - rphase)) * Math.exp(-d / 550) * 1.6, 0, 1);
        } else if (kind === 'spiral') {
          var theta = Math.atan2(dy, dx);
          var sphase = 2 * Math.PI * frame / 60;
          bright = clamp((0.5 + 0.5 * Math.sin(3 * theta + d * 0.035 - sphase)) * Math.exp(-d / 700) * 1.5, 0, 1);
        } else { // pulsing
          bright = 0;
          var radii = [120, 220, 320];
          for (var i = 0; i < 3; i++) {
            var pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * frame / 60 - i * 2 * Math.PI / 3);
            var ring = Math.exp(-((d - radii[i] * s) * (d - radii[i] * s)) / (2 * 22 * s * 22 * s));
            bright = Math.max(bright, ring * (0.35 + 0.65 * pulse));
          }
          var centreB = Math.exp(-(d * d) / (2 * 70 * s * 70 * s));
          var cpulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * frame / 60 + Math.PI);
          bright = Math.max(bright, centreB * (0.3 + 0.7 * cpulse));
          bright = clamp(bright, 0, 1);
        }
        bright = clamp(bright, 0, 1);
        var idx = Math.floor(bright * (RAMP.length - 1));
        ch = RAMP[idx];
        if (ch === ' ') continue;
        cells[y][x] = { ch: ch, rgb: baseColour(bright) };
        text[y][x] = ch;
      }
    }
    return { cells: cells, text: text };
  }
  if (kind === 'rain' || kind === 'rain-tips') {
    var tips = kind === 'rain-tips';
    for (x = 0; x < cols; x++) {
      var rng = mulberry32(x * 7919);
      if (rng() < 0.4) continue; // ~60% of columns rain
      var speed = (rng() < 0.5 ? 28 : 56) / 120; // cells/frame, whole falls per loop
      var offset = rng() * rows;
      var head = (offset + frame * speed) % rows;
      for (var dyy = 0; dyy < 5; dyy++) {
        var yy = ((Math.floor(head) - dyy) % rows + rows) % rows;
        var b = (1 - dyy / 5) * (dyy === 0 ? 1 : 0.75);
        if (b <= 0.05) continue;
        var glyph;
        if (dyy === 0 && tips) {
          glyph = RAIN_TIP_SEQ[Math.floor(head) % 7];
        } else if (b > 0.9) {
          glyph = RAIN_GLYPHS[Math.floor(mulberry32(hashSeed(tick * 1000 + yy * 100 + x))() * RAIN_GLYPHS.length)];
        } else {
          glyph = RAMP[Math.floor(b * (RAMP.length - 1))];
        }
        cells[yy][x] = { ch: glyph, rgb: baseColour(b) };
        text[yy][x] = glyph;
      }
    }
    return { cells: cells, text: text };
  }
  // starfield is drawn as pixel overlays (not a grid) — see drawStarfield().
  return { cells: cells, text: text };
}

/* ---------- starfield (bases2.py, v2 shooting stars) ---------- */
var STARS = (function () {
  var rng = mulberry32(7), out = [];
  for (var i = 0; i < 140; i++) {
    out.push({
      x: rng() * 1340 + 10, y: rng() * 460 + 10,
      pink: rng() < 0.35,
      period: [30, 60, 120][Math.floor(rng() * 3)],
      phase: rng() * 2 * Math.PI,
      size: [8, 10, 10, 14, 16][Math.floor(rng() * 5)],
      glyph: ['*', '+', '\u2022', '\u00b0', '#'][Math.floor(rng() * 5)],
    });
  }
  return out;
})();
function drawStarfield(frame, W, H, text) {
  var sx = W / 1360, sy = H / 480;
  var i, st, tw, dim, yy, rgb;
  for (i = 0; i < STARS.length; i++) {
    st = STARS[i];
    tw = 0.5 + 0.5 * Math.sin(2 * Math.PI * frame / st.period + st.phase);
    dim = 0.25 + 0.75 * tw;
    rgb = st.pink ? hexToRgb(state.sparkleColor) : [255, 255, 255];
    yy = (st.y + 8 * Math.sin(2 * Math.PI * frame / 120 + st.phase)) * sy;
    ctx.font = Math.round(st.size * Math.min(sx, sy)) + 'px "DejaVu Sans Mono", monospace';
    ctx.fillStyle = rgbStr([Math.round(rgb[0] * dim), Math.round(rgb[1] * dim), Math.round(rgb[2] * dim)]);
    ctx.fillText(st.glyph, st.x * sx, yy);
    stampText(text, st.glyph, st.x * sx, yy, W, H);
  }
  // Three shooting stars per loop, one every 40 frames (starfield v2).
  for (var si = 0; si < 3; si++) {
    var start = si * 40, age = frame - start;
    if (age < 0 || age >= 20) continue;
    var rng = mulberry32(100 + si);
    var y0 = (rng() * 120 + 80) * sy, x0 = (rng() * 300 + 100) * sx;
    var speed = 45 * sx, fade = 1 - age / 20;
    for (var ti = 0; ti < 6; ti++) {
      var bx = x0 + speed * age - ti * 18 * sx;
      var by = y0 + (speed * age - ti * 18 * sx) * 0.25;
      var d2 = fade * (1 - ti / 6) * 0.8;
      ctx.font = Math.round(14 * Math.min(sx, sy)) + 'px "DejaVu Sans Mono", monospace';
      ctx.fillStyle = rgbStr([255, 255, 255], d2);
      ctx.fillText('*', bx, by);
      stampText(text, '*', bx, by, W, H);
    }
  }
}
// Stamp one overlay glyph into the text grid at its pixel position.
function stampText(text, glyph, px, py, W, H) {
  if (!text) return;
  var dims = gridDims(), cs = cellSize();
  var gx = Math.floor(px / cs.w), gy = Math.floor(py / cs.h);
  if (gx >= 0 && gx < dims.cols && gy >= 0 && gy < dims.rows) text[gy][gx] = glyph;
}

/* ---------- sparkles (orbit v3 rules) ---------- */
var SPARKLES = (function () {
  var rng = mulberry32(42), out = [];
  for (var i = 0; i < 84; i++) {
    out.push({
      x: rng() * 1320 + 20, yStart: rng() * 350 + 120,
      pink: rng() < 0.5, start: Math.floor(rng() * 120),
      life: [36, 48, 48, 60][Math.floor(rng() * 4)],
      rise: rng() * 50 + 60,
    });
  }
  return out;
})();
function drawSparkles(frame, W, H, text) {
  var sx = W / 1360, sy = H / 480;
  var tick = Math.floor(frame * state.reroll / state.fps);
  var n = Math.min(state.sparkles, SPARKLES.length);
  for (var si = 0; si < n; si++) {
    var sp = SPARKLES[si];
    var age = (frame - sp.start) % N_FRAMES; if (age < 0) age += N_FRAMES;
    if (age >= sp.life) continue;
    var fade = Math.min(1, age / 5) * Math.min(1, (sp.life - age) / 10);
    var dim = 0.7 * fade;
    var rgb = sp.pink ? hexToRgb(state.sparkleColor) : [255, 255, 255];
    var glyph = pickGlyph(tick, 500 + si, SPARKLE_GLYPHS);
    var y = (sp.yStart - sp.rise * (age / sp.life)) * sy;
    ctx.font = Math.round(28 * Math.min(sx, sy)) + 'px "DejaVu Sans Mono", monospace';
    ctx.fillStyle = rgbStr([Math.round(rgb[0] * dim), Math.round(rgb[1] * dim), Math.round(rgb[2] * dim)]);
    ctx.fillText(glyph, sp.x * sx, y);
    stampText(text, glyph, sp.x * sx, y, W, H);
  }
}

/* ---------- letter-as-burst rings (orbit v3 + explode v2) ---------- */
function drawBurstRing(cx, cy, letter, age, life, W, H, text, seed) {
  if (age < 0 || age >= life) return;
  var s = Math.min(W / 1360, H / 480);
  var fade = 1 - age / life;
  var rgb = hexToRgb(state.burstColor);
  for (var pi = 0; pi < 16; pi++) {
    var rng = mulberry32(hashSeed((seed || 1000) * 1000 + pi));
    var ang = rng() * 2 * Math.PI, speed = rng() * 3 + 5;
    var size = [14, 16, 20][Math.floor(rng() * 3)];
    var dist = (20 + speed * age) * s;
    var bx = cx + Math.cos(ang) * dist, by = cy + Math.sin(ang) * dist;
    ctx.font = Math.round(size * s) + 'px "DejaVu Sans Mono", monospace';
    ctx.fillStyle = rgbStr(rgb, fade);
    ctx.fillText(letter, bx, by);
    stampText(text, letter, bx, by, W, H);
  }
}

/* ---------- drawing a cell grid ---------- */
function drawCells(cells, W, H) {
  var dims = gridDims(), cs = cellSize();
  var fontPx = effectiveFont();
  ctx.font = (state.bold ? 'bold ' : '') + fontPx + 'px "DejaVu Sans Mono", monospace';
  ctx.textBaseline = 'top';
  for (var y = 0; y < dims.rows; y++) {
    for (var x = 0; x < dims.cols; x++) {
      var c = cells[y][x];
      if (!c) continue;
      ctx.fillStyle = rgbStr(c.rgb);
      ctx.fillText(c.ch, x * cs.w, y * cs.h + (cs.h - fontPx) / 2);
    }
  }
}
function textFromGrid(text) {
  return text.map(function (row) { return row.join('').replace(/\s+$/, ''); }).join('\n');
}

/* ---------- letter bitmaps (explode / spin 3D) ----------
 * True-lowercase bitmap like explode_v2 letter_bitmap(): draw the letter
 * big and bold on an offscreen canvas, sample to 10 x 12, threshold > 90.
 * Canvas drawImage scaling stands in for Pillow's Lanczos resize. */
var bitmapCache = {};
function letterBitmap(ch) {
  if (bitmapCache[ch]) return bitmapCache[ch];
  var big = document.createElement('canvas'); big.width = 200; big.height = 240;
  var bctx = big.getContext('2d');
  bctx.fillStyle = '#000'; bctx.fillRect(0, 0, 200, 240);
  bctx.fillStyle = '#fff'; bctx.font = 'bold 200px "DejaVu Sans Mono", monospace';
  bctx.textBaseline = 'top'; bctx.fillText(ch, 0, 0);
  var small = document.createElement('canvas'); small.width = 10; small.height = 12;
  var sctx = small.getContext('2d');
  sctx.drawImage(big, 0, 0, 10, 12);
  var data = sctx.getImageData(0, 0, 10, 12).data, bmp = [];
  for (var r = 0; r < 12; r++) { bmp.push([]); for (var c = 0; c < 10; c++) bmp[r].push(data[(r * 10 + c) * 4] > 90); }
  bitmapCache[ch] = bmp;
  return bmp;
}
function letterColour() { return state.lockWhite ? [255, 255, 255] : hexToRgb(state.letterColor); }

/* ---------- orbit v3 ---------- */
function drawOrbit(frame, W, H, text) {
  var s = Math.min(W / 1360, H / 480);
  var cx = W / 2, cy = H / 2, RX = 470 * (W / 1360), RY = 145 * (H / 480);
  var word = state.word || 'xaziss';
  // phase = 5pi/6 + f * (2pi/60): 2 orbits per 120-frame loop, frame 0 spells xaz.
  var phase = (5 * Math.PI / 6) + frame * (2 * Math.PI / 60);
  var letters = [];
  for (var i = 0; i < word.length; i++) {
    var ang = phase - i * (2 * Math.PI / word.length);
    letters.push({ depth: Math.sin(ang), ch: word[i], x: cx + RX * Math.cos(ang), y: cy + RY * Math.sin(ang), i: i });
  }
  letters.sort(function (a, b) { return a.depth - b.depth; }); // back first
  var L;
  for (L = 0; L < letters.length; L++) {
    var lt = letters[L];
    if (lt.depth >= 0) continue;
    var size = Math.round((40 + 10 * lt.depth) * s);
    var colour = lt.depth < -0.3 ? [90, 90, 90] : [170, 170, 170];
    var g = pickGlyph(frame, lt.i, GLYPHS); // every frame, guaranteed change
    drawOrbitLetter(lt.x, lt.y, g, size, colour, s);
    stampText(text, g, lt.x, lt.y, W, H);
  }
  for (L = 0; L < letters.length; L++) {
    lt = letters[L];
    if (lt.depth < 0) continue;
    size = Math.round((40 + 10 * lt.depth) * s);
    colour = lt.depth >= 0.3 ? letterColour() : [170, 170, 170];
    drawOrbitLetter(lt.x, lt.y, lt.ch, size, colour, s);
    stampText(text, lt.ch, lt.x, lt.y, W, H);
  }
  if (state.bursts) {
    // A letter arrives at front centre every 10 frames; burst IS that letter.
    for (var bs = 0; bs < 120; bs += 10) {
      var age = (frame - bs) % 120; if (age < 0) age += 120;
      if (age >= 10) continue;
      var bl = word[(bs / 10) % word.length];
      drawBurstRing(cx, cy + RY, bl, age, 10, W, H, text, bs);
    }
  }
}
function drawOrbitLetter(x, y, ch, size, colour, s) {
  ctx.font = 'bold ' + Math.max(8, size) + 'px "DejaVu Sans Mono", monospace';
  var w = ctx.measureText(ch).width;
  ctx.fillStyle = '#000';
  ctx.fillRect(x - w / 2 - 10 * s, y - size / 2 - 8 * s, w + 20 * s, size + 16 * s);
  ctx.fillStyle = rgbStr(colour);
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, x - w / 2, y);
  ctx.textBaseline = 'top';
}

/* ---------- explode (v2) ---------- */
function explodeProgress(f, start) {
  if (f < start) return 0;
  if (f < start + 30) return smoothstep((f - start) / 30);
  if (f < start + 40) return 1;
  if (f < start + 70) return 1 - smoothstep((f - start - 40) / 30);
  return 0;
}
function drawExplode(frame, W, H, text) {
  var s = Math.min(W / 1360, H / 480);
  var word = state.word || 'xaziss';
  var tick = Math.floor(frame * state.reroll / state.fps);
  var lcw = 17 * s, lch = 33 * s; // chunky v5 cells: 17 x 33 px at 1360 wide
  var letterW = 10 * lcw, letterH = 12 * lch, spacing = 36 * s;
  var totalW = word.length * letterW + (word.length - 1) * spacing;
  var startX = (W - totalW) / 2, startY = (H - letterH) / 2;
  var cells = [];
  for (var i = 0; i < word.length; i++) {
    var p = explodeProgress(frame, 20 + i * 5);
    var bmp = letterBitmap(word[i]);
    var cxL = startX + i * (letterW + spacing) + letterW / 2;
    var cyL = startY + letterH / 2;
    for (var r = 0; r < 12; r++) for (var c = 0; c < 10; c++) {
      if (!bmp[r][c]) continue;
      var rng = mulberry32(hashSeed(i * 10000 + r * 100 + c));
      var ang = rng() * 2 * Math.PI;
      var maxD = state.explodeMax * s, minD = maxD * 80 / 220;
      var dist = minD + rng() * (maxD - minD);
      var dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist - 30 * s;
      var drift = p > 0 ? Math.sin(2 * Math.PI * frame / 60 + (i * 7 + r * 3 + c)) * 4 * s : 0;
      var x = startX + i * (letterW + spacing) + c * lcw + dx * p;
      var y = startY + r * lch + dy * p + drift * p;
      x = clamp(x, 10, W - 30); y = clamp(y, 10, H - 40);
      var grey = Math.round(255 - 115 * p);
      cells.push({ p: p, i: i, r: r, c: c, x: x, y: y, rgb: [grey, grey, grey] });
    }
    if (state.bursts) {
      var bAge = (frame - (20 + i * 5)) % 120; if (bAge < 0) bAge += 120;
      drawBurstRing(cxL, cyL, word[i], bAge, 15, W, H, text, 20 + i * 5);
    }
  }
  cells.sort(function (a, b) { return a.p - b.p; }); // scattered first, assembled on top
  ctx.font = 'bold ' + Math.max(8, Math.round(lch * 0.85)) + 'px "DejaVu Sans Mono", monospace';
  ctx.textBaseline = 'top';
  for (var k = 0; k < cells.length; k++) {
    var cell = cells[k];
    var g = pickGlyph(tick, cell.i * 10000 + cell.r * 100 + cell.c);
    ctx.fillStyle = rgbStr(cell.rgb);
    ctx.fillText(g, cell.x, cell.y);
    stampText(text, g, cell.x, cell.y, W, H);
  }
}

/* ---------- spin 3D (v4/v5) ---------- */
function drawSpin3d(frame, W, H, text) {
  var s = Math.min(W / 1360, H / 480);
  var word = state.word || 'xaziss';
  var tick = Math.floor(frame * state.reroll / state.fps);
  var lcw = 17 * s, lch = 33 * s;
  var letterW = 10 * lcw, letterH = 12 * lch, spacing = 36 * s;
  var totalW = word.length * letterW + (word.length - 1) * spacing;
  var startX = (W - totalW) / 2, startY = (H - letterH) / 2;
  ctx.textBaseline = 'top';
  for (var i = 0; i < word.length; i++) {
    // Stagger minus i/12 of a rotation; 1 rotation per 60 frames.
    var theta = 2 * Math.PI * frame / 60 - i * (2 * Math.PI / 12);
    var cos = Math.cos(theta);
    var bmp = letterBitmap(word[i]);
    var cxL = startX + i * (letterW + spacing) + letterW / 2;
    var cyL = startY + letterH / 2;
    // Extrusion: 3 layers back -> front, dark -> mid -> bright.
    // Rotating vector: down-right at full face, purely sideways at edge-on.
    var layers = [
      { k: 0, rgb: [70, 70, 70] },
      { k: 1, rgb: [130, 130, 130] },
      { k: 2, rgb: cos >= 0 ? letterColour() : [160, 160, 160] },
    ];
    for (var li = 0; li < layers.length; li++) {
      var lay = layers[li];
      var offX = lay.k * (6 + 6 * Math.abs(Math.sin(theta))) * s;
      var offY = lay.k * 8 * Math.abs(cos) * s;
      var scaleX = Math.max(Math.abs(cos), 0.08) * (cos < 0 ? -1 : 1);
      ctx.save();
      ctx.translate(cxL + offX, cyL + offY);
      ctx.scale(scaleX, 1);
      ctx.translate(-cxL, -cyL);
      ctx.font = Math.max(8, Math.round(lch * 0.85)) + 'px "DejaVu Sans Mono", monospace';
      ctx.fillStyle = rgbStr(lay.rgb);
      for (var r = 0; r < 12; r++) for (var c = 0; c < 10; c++) {
        if (!bmp[r][c]) continue;
        var g = pickGlyph(tick, i * 10000 + r * 100 + c);
        var x = startX + i * (letterW + spacing) + c * lcw;
        var y = startY + r * lch;
        ctx.fillText(g, x, y);
        if (li === 2) stampText(text, g, x, y, W, H);
      }
      ctx.restore();
    }
  }
}

/* ---------- R-spin ---------- */
function drawRspin(frame, W, H, text) {
  var s = Math.min(W / 1360, H / 480);
  var word = state.word || 'xaziss';
  var tick = Math.floor(frame * state.reroll / state.fps);
  var size = Math.round(170 * s);
  var totalW = word.length * size * 0.62;
  var startX = (W - totalW) / 2, cy = H / 2;
  for (var i = 0; i < word.length; i++) {
    // 50 frames rotation + 12-frame hold at front = 62-frame cycle.
    // Cos-eased: slow at full faces, fast through edges. Reversed direction.
    var cyc = (frame + i * 6) % 62;
    var theta = 0, width = 1;
    if (cyc < 50) {
      var t = cyc / 50;
      theta = -Math.PI * (t - Math.sin(2 * Math.PI * t) / (2 * Math.PI));
      width = Math.cos(theta);
    }
    var x = startX + i * size * 0.62 + size * 0.31;
    var front = Math.abs(width) > 0.15;
    ctx.save();
    ctx.translate(x, cy);
    ctx.scale(Math.max(Math.abs(width), 0.06) * (width < 0 ? -1 : 1), 1);
    ctx.font = 'bold ' + size + 'px "DejaVu Sans Mono", monospace';
    ctx.textBaseline = 'middle';
    if (!front) { ctx.fillStyle = '#000'; ctx.fillRect(-size * 0.3, -size * 0.6, size * 0.6, size * 1.2); }
    var ch = front && width > 0 ? word[i] : pickGlyph(tick, 900 + i, GLYPHS);
    ctx.fillStyle = rgbStr(width > 0 ? letterColour() : [160, 160, 160]);
    ctx.fillText(ch, -ctx.measureText(ch).width / 2, 0);
    ctx.restore();
    ctx.textBaseline = 'top';
    stampText(text, ch, x, cy, W, H);
  }
}

/* ---------- converter (gif_to_ascii.py, JS/Canvas port) ---------- */
var converter = {
  source: null,        // HTMLCanvasElement holding the current source frame (target size)
  frames: [],          // [{ grid, text, delay }] for animated GIFs; [single] otherwise
  gifFrames: 0, gifAnimated: false,
  palette: [],         // [{ orig:[r,g,b], mapped:'#rrggbb' }]
  status: 'demo image loaded — no upload yet',
};
// Percentile tonemap: clip 1st / 99.5th percentile, gamma. Python samples
// f[::4, ::4] for the percentiles — same here (stride 4 in x and y).
function tonemapLum(lum, gamma) {
  var sample = [];
  for (var i = 0; i < lum.length; i += 4) sample.push(lum[i]);
  sample.sort(function (a, b) { return a - b; });
  var lo = sample[Math.floor(sample.length * 0.01)] || 0;
  var hi = sample[Math.floor(sample.length * 0.995)] || 255;
  if (hi - lo < 10) hi = lo + 10;
  var out = new Float32Array(lum.length);
  for (var j = 0; j < lum.length; j++) out[j] = Math.pow(clamp((lum[j] - lo) / (hi - lo), 0, 1), gamma) * 255;
  return out;
}
function keyGreenInPlace(data) {
  for (var i = 0; i < data.length; i += 4) {
    if (data[i + 1] > 180 && data[i] < 100 && data[i + 2] < 100) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
  }
}
// Fit whole image (black bars) or centre-crop to the canvas aspect.
function fitOrCrop(img, tw, th) {
  var c = document.createElement('canvas'); c.width = tw; c.height = th;
  var x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, tw, th);
  var iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
  if (state.fit) {
    var sc = Math.min(tw / iw, th / ih), nw = Math.max(1, Math.round(iw * sc)), nh = Math.max(1, Math.round(ih * sc));
    x.drawImage(img, (tw - nw) / 2, (th - nh) / 2, nw, nh);
  } else {
    var aspect = tw / th, sw, sh, sx0, sy0;
    if (iw / ih > aspect) { sw = ih * aspect; sh = ih; sx0 = (iw - sw) / 2; sy0 = 0; }
    else { sw = iw; sh = iw / aspect; sx0 = 0; sy0 = (ih - sh) / 2; }
    x.drawImage(img, sx0, sy0, sw, sh, 0, 0, tw, th);
  }
  return c;
}
function trimGreenCanvas(c) {
  var x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data;
  var x0 = c.width, y0 = c.height, x1 = 0, y1 = 0, found = false;
  for (var yy = 0; yy < c.height; yy++) for (var xx = 0; xx < c.width; xx++) {
    var i = (yy * c.width + xx) * 4;
    if (!(d[i + 1] > 180 && d[i] < 100 && d[i + 2] < 100)) {
      found = true;
      if (xx < x0) x0 = xx; if (yy < y0) y0 = yy; if (xx > x1) x1 = xx; if (yy > y1) y1 = yy;
    }
  }
  if (!found) return c;
  var pad = 8, out = document.createElement('canvas');
  out.width = Math.max(1, x1 - x0 + 1 + pad * 2); out.height = Math.max(1, y1 - y0 + 1 + pad * 2);
  out.getContext('2d').drawImage(c, Math.max(0, x0 - pad), Math.max(0, y0 - pad), out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
// One source canvas -> one ASCII grid. This is ascii_frame() in Python:
// sample to cols x rows, Rec.709 luminance, floor, tonemap, ramp, per-cell colour.
function convertCanvasToGrid(srcCanvas) {
  var dims = gridDims(), cols = dims.cols, rows = dims.rows;
  var small = document.createElement('canvas'); small.width = cols; small.height = rows;
  var sx = small.getContext('2d');
  sx.drawImage(srcCanvas, 0, 0, cols, rows);
  var img = sx.getImageData(0, 0, cols, rows), data = img.data;
  var lum = new Float32Array(cols * rows);
  var colours = [];
  for (var i = 0; i < cols * rows; i++) {
    var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (state.keyGreen && g > 180 && r < 100 && b < 100) { r = 0; g = 0; b = 0; }
    var l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (state.floor > 0 && l < state.floor) { r = 0; g = 0; b = 0; l = 0; }
    lum[i] = l; colours.push([r, g, b]);
  }
  var mapped = tonemapLum(lum, state.gamma);
  var cells = makeCells(cols, rows), text = emptyTextGrid(cols, rows);
  for (var y = 0; y < rows; y++) for (var xx = 0; xx < cols; xx++) {
    var idx = y * cols + xx;
    var rampIdx = Math.floor(mapped[idx] / 255 * (RAMP.length - 1));
    var ch = RAMP[rampIdx];
    if (ch === ' ') continue;
    var rgb = state.mono ? [255, 255, 255] : remapColour(colours[idx]);
    cells[y][xx] = { ch: ch, rgb: rgb };
    text[y][xx] = ch;
  }
  return { cells: cells, text: textFromGrid(text), grid: text };
}
function remapColour(rgb) {
  if (!state.remapEnabled || !converter.palette.length) return rgb;
  var best = null, bestD = Infinity;
  for (var i = 0; i < converter.palette.length; i++) {
    var o = converter.palette[i].orig;
    var d = (rgb[0] - o[0]) * (rgb[0] - o[0]) + (rgb[1] - o[1]) * (rgb[1] - o[1]) + (rgb[2] - o[2]) * (rgb[2] - o[2]);
    if (d < bestD) { bestD = d; best = converter.palette[i]; }
  }
  return best ? hexToRgb(best.mapped) : rgb;
}
// Quantize the current source to 8 dominant colours (small k-means, seeded).
function quantizePalette(srcCanvas) {
  var c = document.createElement('canvas'); c.width = 48; c.height = 48;
  var x = c.getContext('2d'); x.drawImage(srcCanvas, 0, 0, 48, 48);
  var d = x.getImageData(0, 0, 48, 48).data, pts = [];
  for (var i = 0; i < d.length; i += 4) {
    if (d[i] < 8 && d[i + 1] < 8 && d[i + 2] < 8) continue; // skip near-black
    pts.push([d[i], d[i + 1], d[i + 2]]);
  }
  if (!pts.length) { converter.palette = []; renderPalette(); return; }
  var rng = mulberry32(1234), centres = [];
  for (var k = 0; k < 8; k++) centres.push(pts[Math.floor(rng() * pts.length)].slice());
  for (var it = 0; it < 12; it++) {
    var sums = centres.map(function () { return [0, 0, 0, 0]; });
    for (var p = 0; p < pts.length; p++) {
      var bi = 0, bd = Infinity;
      for (var j = 0; j < 8; j++) {
        var dd = (pts[p][0] - centres[j][0]) ** 2 + (pts[p][1] - centres[j][1]) ** 2 + (pts[p][2] - centres[j][2]) ** 2;
        if (dd < bd) { bd = dd; bi = j; }
      }
      sums[bi][0] += pts[p][0]; sums[bi][1] += pts[p][1]; sums[bi][2] += pts[p][2]; sums[bi][3]++;
    }
    for (var j2 = 0; j2 < 8; j2++) if (sums[j2][3]) centres[j2] = [sums[j2][0] / sums[j2][3], sums[j2][1] / sums[j2][3], sums[j2][2] / sums[j2][3]];
  }
  converter.palette = centres.map(function (cc) {
    var rgb = cc.map(function (v) { return Math.round(v); });
    return { orig: rgb, mapped: rgbHex(rgb) };
  });
  renderPalette();
}
function renderPalette() {
  var wrap = $('uploadPalette'); wrap.innerHTML = '';
  if (!converter.palette.length) { $('paletteStatus').textContent = 'No upload palette yet — the demo image palette is below once converted.'; return; }
  $('paletteStatus').textContent = converter.palette.length + ' dominant colours from the upload — change any swatch to remap it.';
  converter.palette.forEach(function (sw, i) {
    var label = document.createElement('label'); label.className = 'swatch';
    var input = document.createElement('input'); input.type = 'color'; input.value = sw.mapped;
    input.setAttribute('aria-label', 'remap colour ' + rgbHex(sw.orig));
    input.addEventListener('input', function () { converter.palette[i].mapped = input.value; reconvertCurrent(); });
    var span = document.createElement('span'); span.textContent = rgbHex(sw.orig);
    label.appendChild(input); label.appendChild(span); wrap.appendChild(label);
  });
}
function setConverterSource(srcCanvas, label) {
  converter.source = srcCanvas;
  converter.frames = [convertCanvasToGrid(srcCanvas)];
  converter.gifFrames = 1; converter.gifAnimated = false;
  converter.status = label;
  quantizePalette(srcCanvas);
  updateUploadStatus();
  statusGif.textContent = 'gif: ' + label;
}
function reconvertCurrent() {
  if (state.mode !== 'converter' || !converter.source) return;
  if (converter.gifAnimated && converter.rawGifFrames) {
    converter.frames = converter.rawGifFrames.map(function (f) { return convertCanvasToGrid(f.canvas); });
  } else if (converter.source) {
    converter.frames = [convertCanvasToGrid(converter.source)];
  }
}
function updateUploadStatus() { $('uploadStatus').textContent = converter.status; }
function makeDemoImage() {
  var c = document.createElement('canvas'); c.width = 680; c.height = 480;
  var x = c.getContext('2d');
  var grad = x.createRadialGradient(340, 240, 20, 340, 240, 340);
  grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.35, '#ff6ec8'); grad.addColorStop(0.7, '#aa28a0'); grad.addColorStop(1, '#000000');
  x.fillStyle = grad; x.fillRect(0, 0, 680, 480);
  x.fillStyle = '#ffffff'; x.font = 'bold 200px "DejaVu Sans Mono", monospace'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('xaziss', 340, 240);
  x.fillStyle = '#ff6ec8';
  for (var i = 0; i < 24; i++) { var a = i / 24 * 2 * Math.PI; x.beginPath(); x.arc(340 + Math.cos(a) * 260, 240 + Math.sin(a) * 160, 8, 0, 7); x.fill(); }
  return c;
}
function loadDemo() {
  var demo = makeDemoImage();
  var fitted = state.trimGreen ? trimGreenCanvas(demo) : demo;
  setConverterSource(fitOrCrop(fitted, state.canvasW, state.canvasH), 'demo image (synthetic) — upload a GIF or image to replace it');
}
/* GIF decoding: gifuct-js from CDN, with an honest first-frame fallback.
 * Python note: the converter does NOT composite partial GIF frames, so
 * for transparency/partial-update GIFs the frames need compositing first —
 * gifuct-js decompressFrames(..., true) builds full composited frames. */
var gifuctLoading = null;
function loadGifuct() {
  if (window.gifuct) return Promise.resolve();
  if (gifuctLoading) return gifuctLoading;
  gifuctLoading = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/gifuct-js@2.1.2/dist/gifuct-js.umd.js';
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('gifuct-js CDN failed to load')); };
    document.head.appendChild(s);
    setTimeout(function () { reject(new Error('gifuct-js load timed out')); }, 8000);
  });
  return gifuctLoading;
}
function handleFile(file) {
  if (!file || !file.type || file.type.indexOf('image/') !== 0) {
    statusMsg.textContent = 'That file is not an image.'; return;
  }
  var url = URL.createObjectURL(file);
  var isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
  if (!isGif) {
    var img = new Image();
    img.onload = function () {
      var src = state.trimGreen ? trimGreenCanvas(fitOrCrop(img, img.naturalWidth, img.naturalHeight)) : img;
      setConverterSource(fitOrCrop(src, state.canvasW, state.canvasH), file.name + ' — still image, 1 frame');
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { statusMsg.textContent = 'Could not read that image.'; };
    img.src = url;
    return;
  }
  // GIF: try the decoder; fall back to the browser's first frame.
  loadGifuct().then(function () {
    return fetch(url).then(function (r) { return r.arrayBuffer(); });
  }).then(function (buf) {
    var gif = window.gifuct.parseGIF(buf);
    var frames = window.gifuct.decompressFrames(gif, true); // buildPatch: full frames
    frames = frames.slice(0, 90); // Python --max-frames 90
    if (!frames.length) throw new Error('no frames decoded');
    var raw = frames.map(function (fr) {
      var c = document.createElement('canvas'); c.width = fr.dims.width; c.height = fr.dims.height;
      var d = c.getContext('2d').createImageData(fr.dims.width, fr.dims.height);
      d.data.set(fr.patch); c.getContext('2d').putImageData(d, 0, 0);
      return { canvas: fitOrCrop(c, state.canvasW, state.canvasH), delay: fr.delay || 100 };
    });
    converter.rawGifFrames = raw;
    converter.gifFrames = raw.length;
    converter.gifAnimated = raw.length > 1;
    converter.frames = raw.map(function (f) { return convertCanvasToGrid(f.canvas); });
    converter.source = raw[0].canvas;
    converter.status = file.name + ' — GIF: ' + raw.length + ' frames decoded (gifuct-js, composited)';
    quantizePalette(raw[0].canvas);
    updateUploadStatus();
    statusGif.textContent = 'gif: ' + raw.length + ' frames, animated';
  }).catch(function (err) {
    var img = new Image();
    img.onload = function () {
      setConverterSource(fitOrCrop(img, state.canvasW, state.canvasH), file.name + ' — GIF first frame only: decoder unavailable (' + err.message + '). Full animation needs the gifuct-js CDN.');
      statusGif.textContent = 'gif: first frame only — decoder failed';
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { statusMsg.textContent = 'Could not read that GIF.'; };
    img.src = url;
  });
}

/* ---------- render + animation ---------- */
var currentTextStr = '';
var currentFrame = 0;
var animStart = performance.now();
var gifStart = performance.now();
var lastTextUpdate = 0;

function currentGifFrameIndex(now) {
  if (!converter.gifAnimated || !converter.rawGifFrames) return 0;
  var total = converter.rawGifFrames.reduce(function (a, f) { return a + f.delay; }, 0) || 100;
  var t = (now - gifStart) % total, acc = 0;
  for (var i = 0; i < converter.rawGifFrames.length; i++) {
    acc += converter.rawGifFrames[i].delay;
    if (t < acc) return i;
  }
  return 0;
}
function renderFrame(now) {
  var W = state.canvasW, H = state.canvasH;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  var dims = gridDims(), text = '';
  if (state.mode === 'converter') {
    if (!converter.frames.length) loadDemo();
    var gi = currentGifFrameIndex(now);
    var fr = converter.frames[gi] || converter.frames[0];
    drawCells(fr.cells, W, H);
    text = fr.text;
  } else {
    var base = computeBase(state.mode, currentFrame, dims.cols, dims.rows, W, H);
    var motionBase = null;
    if (MOTION_MODES.indexOf(state.mode) >= 0) {
      if (state.motionBase !== 'none') motionBase = computeBase(state.motionBase, currentFrame, dims.cols, dims.rows, W, H);
      var stampGrid = motionBase ? motionBase.text : base.text;
      drawSparkles(currentFrame, W, H, stampGrid);
      if (motionBase) drawCells(motionBase.cells, W, H);
      if (state.mode === 'orbit') drawOrbit(currentFrame, W, H, stampGrid);
      else if (state.mode === 'explode') drawExplode(currentFrame, W, H, stampGrid);
      else if (state.mode === 'spin3d') drawSpin3d(currentFrame, W, H, stampGrid);
      else if (state.mode === 'rspin') drawRspin(currentFrame, W, H, stampGrid);
      text = textFromGrid(stampGrid);
    } else {
      drawSparkles(currentFrame, W, H, base.text);
      drawCells(base.cells, W, H);
      if (state.mode === 'starfield') drawStarfield(currentFrame, W, H, base.text);
      text = textFromGrid(base.text);
    }
  }
  currentTextStr = text;
  if (state.view === 'text' && now - lastTextUpdate > 150) {
    textView.textContent = text;
    lastTextUpdate = now;
  }
  $('frameReadout').textContent = 'frame ' + currentFrame + ' / ' + N_FRAMES +
    (state.mode === 'converter' && converter.gifAnimated ? ' · gif frame ' + (currentGifFrameIndex(now) + 1) + '/' + converter.gifFrames : '');
  statusMode.textContent = 'mode: ' + state.mode + (MOTION_MODES.indexOf(state.mode) >= 0 ? ' over ' + state.motionBase : '');
  statusGrid.textContent = 'grid ' + dims.cols + ' × ' + dims.rows + ' · cell ' + Math.round(cellSize().w) + '×' + Math.round(cellSize().h) + ' px';
}
function loop(now) {
  if (state.playing) {
    currentFrame = Math.floor((now - animStart) * state.fps / 1000) % N_FRAMES;
  }
  renderFrame(now);
  requestAnimationFrame(loop);
}

/* ---------- canvas sizing ---------- */
function applyCanvasSize() {
  if (state.fullBleed) {
    stageEl.classList.add('full-bleed');
    var w = Math.max(320, stageEl.clientWidth), h = Math.max(240, stageEl.clientHeight || 480);
    state.canvasW = w; state.canvasH = h;
  } else {
    stageEl.classList.remove('full-bleed');
  }
  canvas.width = state.canvasW; canvas.height = state.canvasH;
  autoFitFont();
  var dims = gridDims();
  $('canvasReadout').textContent = 'canvas ' + state.canvasW + ' × ' + state.canvasH + ' · grid ' + dims.cols + ' × ' + dims.rows;
  $('customW').value = state.canvasW; $('customH').value = state.canvasH;
  if (state.mode === 'converter' && converter.source) {
    // Re-fit the current (already target-sized) source to the new canvas.
    // Slight quality loss vs. refitting the original upload — see README.
    converter.source = fitOrCrop(converter.source, state.canvasW, state.canvasH);
    reconvertCurrent();
  }
}

/* ---------- export (v1: text / png / html; gif is v2, disabled) ---------- */
function downloadBlob(blob, name) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportName(ext) { return 'ascii-' + state.mode + '-' + state.canvasW + 'x' + state.canvasH + '-f' + currentFrame + '.' + ext; }
function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/* ---------- ui wiring ---------- */
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
  formulaText.textContent = FORMULAS[mode] || '';
  if (mode === 'converter') {
    statusGif.textContent = 'gif: ' + converter.status;
    if (!converter.frames.length) loadDemo();
    reconvertCurrent();
  }
  if (state.view === 'text') { textView.textContent = currentTextStr; lastTextUpdate = performance.now(); }
}
function bindSlider(id, valId, fn, fmt) {
  var el = $(id);
  el.addEventListener('input', function () {
    var v = parseFloat(el.value);
    fn(v);
    $(valId).textContent = fmt ? fmt(v) : String(v);
  });
}
function init() {
  document.querySelectorAll('.mode-btn').forEach(function (b) {
    b.addEventListener('click', function () { setMode(b.dataset.mode); });
  });
  document.querySelectorAll('.preset-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.preset-btn').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      state.fullBleed = false; $('fullBleedToggle').checked = false;
      state.canvasW = parseInt(b.dataset.w, 10); state.canvasH = parseInt(b.dataset.h, 10);
      applyCanvasSize();
    });
  });
  $('customApplyBtn').addEventListener('click', function () {
    var w = clamp(parseInt($('customW').value, 10) || 1360, 160, 2400);
    var h = clamp(parseInt($('customH').value, 10) || 480, 120, 2400);
    state.fullBleed = false; $('fullBleedToggle').checked = false;
    state.canvasW = w; state.canvasH = h;
    document.querySelectorAll('.preset-btn').forEach(function (x) { x.classList.remove('active'); });
    applyCanvasSize();
  });
  $('fullBleedToggle').addEventListener('change', function () {
    state.fullBleed = $('fullBleedToggle').checked;
    applyCanvasSize();
  });
  window.addEventListener('resize', function () { if (state.fullBleed) applyCanvasSize(); });

  $('wordInput').addEventListener('input', function () {
    state.word = ($('wordInput').value || 'xaziss').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'xaziss';
  });
  $('motionBaseSelect').addEventListener('change', function () { state.motionBase = $('motionBaseSelect').value; });
  $('burstToggle').addEventListener('change', function () { state.bursts = $('burstToggle').checked; });

  bindSlider('colsSlider', 'colsVal', function (v) { state.cols = Math.round(v); autoFitFont(); updateCanvasReadout(); if (state.mode === 'converter') reconvertCurrent(); });
  bindSlider('fontSlider', 'fontVal', function (v) { state.fontSize = Math.round(v); });
  bindSlider('gammaSlider', 'gammaVal', function (v) { state.gamma = v; if (state.mode === 'converter') reconvertCurrent(); }, function (v) { return v.toFixed(2); });
  bindSlider('floorSlider', 'floorVal', function (v) { state.floor = Math.round(v); if (state.mode === 'converter') reconvertCurrent(); });
  bindSlider('fpsSlider', 'fpsVal', function (v) {
    state.fps = Math.round(v);
    $('loopHint').textContent = N_FRAMES + ' frames · ' + (N_FRAMES / state.fps).toFixed(1) + ' s loop';
  });
  bindSlider('sparkleSlider', 'sparkleVal', function (v) { state.sparkles = Math.round(v); });
  bindSlider('explodeSlider', 'explodeVal', function (v) { state.explodeMax = Math.round(v); }, function (v) { return Math.round(v) + ' px'; });
  bindSlider('rerollSlider', 'rerollVal', function (v) { state.reroll = Math.round(v); }, function (v) { return Math.round(v) + ' / sec'; });

  $('fitToggle').addEventListener('change', function () { state.fit = $('fitToggle').checked; if (state.mode === 'converter') reconvertCurrent(); });
  $('keyGreenToggle').addEventListener('change', function () { state.keyGreen = $('keyGreenToggle').checked; if (state.mode === 'converter') reconvertCurrent(); });
  $('trimGreenToggle').addEventListener('change', function () { state.trimGreen = $('trimGreenToggle').checked; if (state.mode === 'converter') reconvertCurrent(); });
  $('boldToggle').addEventListener('change', function () { state.bold = $('boldToggle').checked; });
  $('monoToggle').addEventListener('change', function () { state.mono = $('monoToggle').checked; if (state.mode === 'converter') reconvertCurrent(); });

  // Palette
  $('baseColor').addEventListener('input', function () { state.baseColor = $('baseColor').value; });
  $('sparkleColor').addEventListener('input', function () { state.sparkleColor = $('sparkleColor').value; });
  $('burstColor').addEventListener('input', function () { state.burstColor = $('burstColor').value; });
  $('letterColor').addEventListener('input', function () { state.letterColor = $('letterColor').value; });
  $('lockWhiteToggle').addEventListener('change', function () {
    state.lockWhite = $('lockWhiteToggle').checked;
    $('letterColor').disabled = state.lockWhite;
  });
  $('resetPaletteBtn').addEventListener('click', function () {
    state.baseColor = HOUSE.pink; state.sparkleColor = HOUSE.pink; state.burstColor = HOUSE.white;
    state.letterColor = HOUSE.white; state.lockWhite = true;
    $('baseColor').value = HOUSE.pink; $('sparkleColor').value = HOUSE.pink; $('burstColor').value = HOUSE.white;
    $('letterColor').value = HOUSE.white; $('lockWhiteToggle').checked = true; $('letterColor').disabled = true;
    if (converter.palette.length) {
      converter.palette.forEach(function (sw) { sw.mapped = rgbHex(sw.orig); });
      renderPalette(); reconvertCurrent();
    }
  });

  // Upload: picker + drag-drop (sidebar zone and stage)
  $('fileInput').addEventListener('change', function () { handleFile($('fileInput').files[0]); $('fileInput').value = ''; });
  $('demoBtn').addEventListener('click', function () { loadDemo(); if (state.mode !== 'converter') setMode('converter'); });
  ['dragenter', 'dragover'].forEach(function (ev) {
    $('dropZone').addEventListener(ev, function (e) { e.preventDefault(); $('dropZone').classList.add('drag'); });
    stageEl.addEventListener(ev, function (e) { e.preventDefault(); $('dropOverlay').hidden = false; });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    $('dropZone').addEventListener(ev, function (e) { e.preventDefault(); $('dropZone').classList.remove('drag'); });
    stageEl.addEventListener(ev, function (e) { e.preventDefault(); $('dropOverlay').hidden = true; });
  });
  $('dropZone').addEventListener('drop', function (e) { handleFile(e.dataTransfer.files[0]); if (state.mode !== 'converter') setMode('converter'); });
  stageEl.addEventListener('drop', function (e) { handleFile(e.dataTransfer.files[0]); if (state.mode !== 'converter') setMode('converter'); });

  // View + play/pause
  $('viewCanvasBtn').addEventListener('click', function () {
    state.view = 'canvas';
    $('viewCanvasBtn').classList.add('active'); $('viewTextBtn').classList.remove('active');
    canvas.hidden = false; textView.hidden = true;
  });
  $('viewTextBtn').addEventListener('click', function () {
    state.view = 'text';
    $('viewTextBtn').classList.add('active'); $('viewCanvasBtn').classList.remove('active');
    canvas.hidden = true; textView.hidden = false;
    textView.textContent = currentTextStr; lastTextUpdate = performance.now();
  });
  $('playPauseBtn').addEventListener('click', function () {
    state.playing = !state.playing;
    $('playPauseBtn').textContent = state.playing ? 'pause' : 'play';
    if (state.playing) animStart = performance.now() - currentFrame * 1000 / state.fps;
  });

  // Export
  $('copyTextBtn').addEventListener('click', function () {
    var done = function () { $('exportStatus').textContent = 'Copied the current frame as text (' + currentTextStr.split('\n').length + ' lines).'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(currentTextStr).then(done, function () { fallbackCopy(); done(); });
    } else { fallbackCopy(); done(); }
    function fallbackCopy() {
      var ta = document.createElement('textarea'); ta.value = currentTextStr;
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) { /* clipboard unavailable */ }
      ta.remove();
    }
  });
  $('pngBtn').addEventListener('click', function () {
    canvas.toBlob(function (blob) {
      if (!blob) { $('exportStatus').textContent = 'PNG export failed in this browser.'; return; }
      downloadBlob(blob, exportName('png'));
      $('exportStatus').textContent = 'PNG saved: ' + exportName('png');
    }, 'image/png');
  });
  $('htmlBtn').addEventListener('click', function () {
    var doc = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>ascii — ' + state.mode + '</title>\n' +
      '<style>body{background:#000;color:#fff;font-family:"DejaVu Sans Mono",monospace;margin:0;padding:16px}pre{font-size:11px;line-height:1.15;margin:0}</style>\n</head>\n<body>\n<pre>' +
      escapeHtml(currentTextStr) + '</pre>\n</body>\n</html>\n';
    downloadBlob(new Blob([doc], { type: 'text/html' }), exportName('html'));
    $('exportStatus').textContent = 'HTML saved: ' + exportName('html') + ' (standalone, current frame as real text).';
  });

  // Init
  formulaText.textContent = FORMULAS.wave;
  $('loopHint').textContent = N_FRAMES + ' frames · ' + (N_FRAMES / state.fps).toFixed(1) + ' s loop';
  loadDemo();
  applyCanvasSize();
  requestAnimationFrame(loop);
}
function updateCanvasReadout() {
  var dims = gridDims();
  $('canvasReadout').textContent = 'canvas ' + state.canvasW + ' × ' + state.canvasH + ' · grid ' + dims.cols + ' × ' + dims.rows;
}
document.addEventListener('DOMContentLoaded', init);
