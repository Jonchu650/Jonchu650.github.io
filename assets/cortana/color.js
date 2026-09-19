// color.js — shared display-colour treatment. Companion colours are stored verbatim as
// picked; every surface that PAINTS them (orbs, swatches, chat tint, agent cards) runs
// them through vivid() so a near-black pick still reads against the dark starfield.
// Display-only: editors and API payloads always carry the raw stored value.

const FLOOR = 0.48;   // minimum HSL lightness a painted colour may have — a dark pick still
                      // clears the invisible zone, but a colour already above it keeps its
                      // exact picked hue + saturation (no wash toward white)

// Raise a hex colour to the lightness floor, preserving hue + saturation. A colour already
// at/above the floor passes through as its exact picked value — the companion's real colour,
// never lightened. Non-hex or falsy input (named colours, undefined) passes through
// untouched — never throw here.
export function vivid(c) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim());
  if (!m) return c;
  let hex = m[1];
  if (hex.length === 3) hex = hex.replace(/./g, ch => ch + ch);
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255,
        b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (l >= FLOOR) return '#' + hex.toLowerCase();
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return hslToHex(h, s, FLOOR);
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
                  : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
