// Hand-drawn 5x7 bitmap font (no font files, no web fonts) plus HUD widgets:
// telemetry strip, rolling score counter, typewriter ticker.

const F = {
  "0": [14,17,19,21,25,17,14], "1": [4,12,4,4,4,4,14], "2": [14,17,1,2,4,8,31],
  "3": [31,2,4,2,1,17,14], "4": [2,6,10,18,31,2,2], "5": [31,16,30,1,1,17,14],
  "6": [6,8,16,30,17,17,14], "7": [31,1,2,4,8,8,8], "8": [14,17,17,14,17,17,14],
  "9": [14,17,17,15,1,2,12],
  A: [14,17,17,31,17,17,17], B: [30,17,17,30,17,17,30], C: [14,17,16,16,16,17,14],
  D: [28,18,17,17,17,18,28], E: [31,16,16,30,16,16,31], F: [31,16,16,30,16,16,16],
  G: [14,17,16,23,17,17,15], H: [17,17,17,31,17,17,17], I: [14,4,4,4,4,4,14],
  J: [7,2,2,2,2,18,12], K: [17,18,20,24,20,18,17], L: [16,16,16,16,16,16,31],
  M: [17,27,21,21,17,17,17], N: [17,25,21,19,17,17,17], O: [14,17,17,17,17,17,14],
  P: [30,17,17,30,16,16,16], Q: [14,17,17,17,21,18,13], R: [30,17,17,30,20,18,17],
  S: [15,16,16,14,1,1,30], T: [31,4,4,4,4,4,4], U: [17,17,17,17,17,17,14],
  V: [17,17,17,17,17,10,4], W: [17,17,17,21,21,21,10], X: [17,17,10,4,10,17,17],
  Y: [17,17,10,4,4,4,4], Z: [31,1,2,4,8,16,31],
  " ": [0,0,0,0,0,0,0], ".": [0,0,0,0,0,12,12], ",": [0,0,0,0,12,4,8],
  ":": [0,12,12,0,12,12,0], "-": [0,0,0,31,0,0,0], "/": [1,1,2,4,8,16,16],
  "°": [12,18,18,12,0,0,0], "!": [4,4,4,4,4,0,4], "?": [14,17,1,2,4,0,4],
  "'": [4,4,8,0,0,0,0], "+": [0,4,4,31,4,4,0], "(": [2,4,8,8,8,4,2],
  ")": [8,4,2,2,2,4,8], "%": [25,26,2,4,8,11,19], "<": [2,4,8,16,8,4,2],
  ">": [8,4,2,1,2,4,8], "=": [0,0,31,0,31,0,0], "*": [0,21,14,31,14,21,0],
  "▲": [0,4,4,14,14,31,0], "▼": [0,31,14,14,4,4,0],
};

export function drawText(ctx, str, x, y, color, scale = 1) {
  ctx.fillStyle = color;
  let cx = x;
  for (const raw of String(str)) {
    const ch = F[raw] ? raw : F[raw.toUpperCase()] ? raw.toUpperCase() : "?";
    const g = F[ch];
    for (let r = 0; r < 7; r++) {
      const row = g[r];
      for (let c = 0; c < 5; c++) {
        if (row & (16 >> c)) ctx.fillRect(cx + c * scale, y + r * scale, scale, scale);
      }
    }
    cx += 6 * scale;
  }
  return cx;
}

export const textWidth = (str, scale = 1) => String(str).length * 6 * scale;

export function drawTextCentered(ctx, str, cx, y, color, scale = 1) {
  drawText(ctx, str, Math.round(cx - textWidth(str, scale) / 2), y, color, scale);
}

// Mechanical-counter score reveal: digits roll for ~500ms then lock.
export class ScoreRoll {
  constructor(score, reducedMotion) {
    this.final = score.toFixed(2);
    this.start = performance.now();
    this.dur = reducedMotion ? 0 : 500;
  }
  text() {
    const el = performance.now() - this.start;
    if (el >= this.dur) return this.final;
    const p = el / this.dur;
    return this.final.split("").map((ch, i) => {
      if (ch === ".") return ".";
      const lock = (i / this.final.length) * 0.6 + 0.35;
      if (p > lock) return ch;
      return String(Math.floor((el / 40 + i * 3) % 10));
    }).join("");
  }
  done() { return performance.now() - this.start >= this.dur + 150; }
}

// Types out commentary at ~30 chars/sec.
export class Ticker {
  constructor(text, reducedMotion) {
    this.full = text.toUpperCase();
    this.start = performance.now();
    this.cps = reducedMotion ? 10000 : 30;
  }
  text() {
    const n = Math.floor(((performance.now() - this.start) / 1000) * this.cps);
    return this.full.slice(0, n);
  }
  done() { return this.text().length >= this.full.length; }
}

// Word-wrap for the bitmap font.
export function wrapText(str, maxChars) {
  const words = String(str).split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) { lines.push(cur.trim()); cur = w; }
    else cur += " " + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}
