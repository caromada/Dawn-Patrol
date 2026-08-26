// The landing scene: dawn at a sandy pointbreak, palms moving in the wind.
// Pure code pixel art on the game canvas while the menu overlay is up.

import { PALETTE as P, reducedMotion } from "./theme.js";

const W = 480, H = 270;
const HORIZON = 108, SAND_Y = 196;
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

let running = false, rafId = 0;

function drawPalm(g, baseX, baseY, height, lean, t, seed) {
  const sway = reducedMotion() ? 0 : Math.sin(t * 1.1 + seed) * 0.06 + Math.sin(t * 0.31 + seed * 2) * 0.03;
  // trunk: segments curving up with the lean
  g.fillStyle = P.silhouette;
  let cx = baseX, cy = baseY;
  const segs = 16;
  for (let i = 0; i < segs; i++) {
    const u = i / segs;
    cx = baseX + lean * u * u + sway * height * u * u * 1.6;
    cy = baseY - height * u;
    const wTrunk = Math.max(3, Math.round(6 - u * 3));
    g.fillRect(Math.round(cx - wTrunk / 2), Math.round(cy), wTrunk, Math.ceil(height / segs) + 1);
  }
  // crown: solid tapering fronds all the way around
  const crownX = cx, crownY = cy;
  for (let f = 0; f < 9; f++) {
    const base = -Math.PI * 1.05 + (f / 8) * Math.PI * 1.1;
    const ang = base + sway * (1.5 + (f % 3) * 0.3);
    const len = height * (0.34 + (f % 3) * 0.05);
    for (let u = 0.05; u <= 1; u += 0.04) {
      const fx = crownX + Math.cos(ang) * len * u;
      const fy = crownY + Math.sin(ang) * len * u * 0.6 + u * u * height * 0.17;
      const wF = u < 0.4 ? 3 : u < 0.75 ? 2 : 1;
      g.fillRect(Math.round(fx - wF / 2), Math.round(fy), wF, wF);
    }
  }
  // coconut cluster
  g.fillRect(Math.round(crownX - 3), Math.round(crownY + 2), 4, 4);
  g.fillRect(Math.round(crownX + 1), Math.round(crownY + 4), 4, 4);
}

function drawScene(g, t) {
  const sunX = 330;
  // sky
  g.fillStyle = P.skyDeep; g.fillRect(0, 0, W, 44);
  g.fillStyle = P.skyIndigo; g.fillRect(0, 44, W, HORIZON - 44);
  // peach glow + sun, Bayer ordered dithering
  g.fillStyle = P.peach;
  for (let y = HORIZON - 26; y < HORIZON; y++) {
    const p = (y - (HORIZON - 26)) / 26;
    for (let x = 0; x < W; x++) {
      const glow = Math.max(0, 7 - Math.abs(x - sunX) / 10);
      if (BAYER[y & 3][x & 3] < p * 6 + glow) g.fillRect(x, y, 1, 1);
    }
  }
  const sunR = 13;
  for (let dy = -sunR; dy <= 0; dy++) {
    const half = Math.floor(Math.sqrt(sunR * sunR - dy * dy));
    g.fillRect(sunX - half, HORIZON - 1 + dy, half * 2, 1);
  }
  g.fillRect(0, HORIZON - 1, W, 1);
  // stars
  g.fillStyle = P.foam;
  g.globalAlpha = 0.5;
  let sd = 9871;
  for (let i = 0; i < 34; i++) {
    sd = (sd * 16807) % 2147483647;
    const sx = sd % W, sy = (sd >> 4) % (HORIZON - 40);
    if ((i + Math.floor(t)) % 9 !== 0) g.fillRect(sx, sy, 1, 1);
  }
  g.globalAlpha = 1;

  // sea with rolling swell lines
  g.fillStyle = P.farWater; g.fillRect(0, HORIZON, W, SAND_Y - HORIZON);
  for (let row = 0; row < 4; row++) {
    const baseY = HORIZON + 14 + row * 20;
    const speed = 7 + row * 4, amp = 1 + row;
    g.fillStyle = row < 2 ? P.outerWater : P.waveFace;
    for (let x = 0; x < W; x += 2) {
      const y = baseY + Math.round(Math.sin((x + t * speed) * 0.05 + row * 2) * amp);
      g.fillRect(x, y, 2, 2 + row);
    }
  }
  // shorebreak foam edge licking the sand
  const tide = Math.sin(t * 0.55) * 7;
  g.fillStyle = P.foam;
  for (let x = 0; x < W; x += 2) {
    const y = SAND_Y - 4 + Math.round(Math.sin(x * 0.06 + t * 1.2) * 2 + tide * 0.4);
    if ((x + Math.floor(t * 6)) % 4 < 3) g.fillRect(x, y, 2, 2);
  }
  // sun glints
  g.fillStyle = P.peach;
  for (let x = sunX - 70; x < sunX + 70; x += 2) {
    if (((x * 13 + Math.floor(t * 5) * 7) % 71) < 2) {
      g.fillRect(x, HORIZON + 4 + ((x * 7) % 40), 1, 1);
    }
  }

  // sandy beach: silhouette-dark with speckle
  g.fillStyle = P.silhouette; g.fillRect(0, SAND_Y, W, H - SAND_Y);
  g.fillStyle = P.waterDeep;
  for (let y = SAND_Y; y < H; y += 1) {
    for (let x = (y * 3) % 5; x < W; x += 5) {
      if (((x * 11 + y * 17) % 23) < 2) g.fillRect(x, y, 1, 1);
    }
  }
  // wet sand sheen near the foam line
  g.fillStyle = P.outerWater;
  for (let x = 0; x < W; x += 2) {
    if ((x + Math.floor(t * 3)) % 6 < 2) g.fillRect(x, SAND_Y + 1, 2, 1);
  }
  // first light catching the sand
  g.fillStyle = P.peach;
  for (let y = SAND_Y + 2; y < SAND_Y + 26; y++) {
    const fade = 1 - (y - SAND_Y) / 26;
    for (let x = (y * 7) % 6; x < W; x += 6) {
      if (((x * 11 + y * 29) % 37) < 3 * fade) g.fillRect(x, y, 1, 1);
    }
  }

  // palms framing the scene, crowns up against the dawn sky
  drawPalm(g, 20, H + 4, 205, 40, t, 1);
  drawPalm(g, 58, H + 14, 148, 26, t, 3.7);
  drawPalm(g, 460, H + 4, 188, -36, t, 2.2);

  // pelicans
  g.fillStyle = P.silhouette;
  for (let b = 0; b < 3; b++) {
    const bx = (W + 40 - ((t * (7 + b * 2) + b * 160) % (W + 80))) | 0;
    const by = 54 + b * 10 + Math.round(Math.sin(t * 2 + b) * 2);
    const wing = Math.floor(t * 6 + b) % 2;
    g.fillRect(bx, by, 2, 1);
    if (wing) { g.fillRect(bx - 2, by - 1, 2, 1); g.fillRect(bx + 2, by - 1, 2, 1); }
    else { g.fillRect(bx - 2, by, 2, 1); g.fillRect(bx + 2, by, 2, 1); }
  }
}

export function startMenuScene(canvas) {
  const g = canvas.getContext("2d");
  g.imageSmoothingEnabled = false;
  running = true;
  const t0 = performance.now();
  const loop = () => {
    if (!running) return;
    drawScene(g, (performance.now() - t0) / 1000);
    if (reducedMotion()) return; // one still frame is plenty
    rafId = requestAnimationFrame(loop);
  };
  loop();
}

export function stopMenuScene() {
  running = false;
  cancelAnimationFrame(rafId);
}
