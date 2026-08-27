// Pixel sprites drawn in code, bug-race style: each frame is a character
// grid with a color legend, no image files. The surfer is a real person:
// sun-bleached hair, tan, gold boardshorts, coral board with a white nose.
// An automatic 1px contour is drawn around each figure so it reads crisp
// against water, foam, and sky alike.

const INK = {
  h: "#E8C86A", // hair, sun-bleached blond
  H: "#C39B3B", // hair shade
  s: "#E2A469", // skin
  S: "#B97C46", // skin shade
  g: "#FFB020", // boardshorts
  G: "#D07E10", // boardshorts shade
  B: "#FF5A47", // board deck
  b: "#C23A2B", // board rail shade
  W: "#F5FFFA", // board nose, highlights
  k: "#0E0F14", // eyes, contour
};

const GRIDS = {
  ride: [
    "..........hhhh..........",
    "........hhhhhhh.........",
    ".......hhHsksh..........",
    "......hh..ssss..........",
    "...........ss...........",
    "........ssssss..........",
    "......ss.ssssss.........",
    ".....ss..ssssss..ss.....",
    ".........Ssssss.ss......",
    ".........gggggg.........",
    "........ggg..ggg........",
    "........SS....SS........",
    "........ss.....ss...BB..",
    ".bBBBBBBBBBBBBBBBBBBBW..",
    "..bbbbbbbbbbbbbbbbbbb...",
  ],
  crouch: [
    "........................",
    "...........hhhh.........",
    ".........hhhhhhh........",
    "........hhHsksh.........",
    "..........ssss..........",
    "........ssssss..........",
    "......ss.ssssss.........",
    ".....ss..Sssssss........",
    ".........gggggg.........",
    "........ggg..ggg........",
    ".......SSS....SSS.......",
    ".......ss......ss.......",
    "......ss.......ss...BB..",
    ".bBBBBBBBBBBBBBBBBBBBW..",
    "..bbbbbbbbbbbbbbbbbbb...",
  ],
  snap: [
    "........hhhh............",
    "......hhhhhhh...........",
    "......hHsksh............",
    ".......ssss.........W...",
    "....ss.ssss........BB...",
    "...ss.ssssss......BB....",
    "......ssssss.....BB.....",
    "......Ssssss....BB......",
    ".......gggg....BB.......",
    "......ggg.gg..BB........",
    "......SS...ssBB.........",
    "......ss...sBB..........",
    ".....ss...BBB...........",
    "........BBB.............",
    "......BBb...............",
    ".....Bb.................",
  ],
  cutback: [
    "........................",
    "........hhhh............",
    "......hhhhhhh...........",
    "......hHsksh............",
    "........ssss............",
    "....s...ssss............",
    ".....ssssssssss.ss......",
    "........ssssss.s........",
    "........Sssss...........",
    "........ggggg...........",
    ".......ggg.ggg..........",
    ".......SS...SS..........",
    "..BB..ss.....ss.........",
    ".WBBBBBBBBBBBBBBBBBBb...",
    "...bbbbbbbbbbbbbbbbb....",
  ],
  floater: [
    ".....s.........s........",
    "......s.hhhh..s.........",
    ".......hhhhhhh..........",
    "......hhHsksh...........",
    "..........ssss..........",
    ".........ssss...........",
    "........ssssss..........",
    "........Ssssss..........",
    "........gggggg..........",
    ".......ggg..ggg.........",
    ".......SS....SS.........",
    "......ss......ss........",
    "......ss......ss....BB..",
    ".bBBBBBBBBBBBBBBBBBBBW..",
    "..bbbbbbbbbbbbbbbbbbb...",
  ],
  popup: [
    "........................",
    "...........hhhh.........",
    ".........hhhhhhh........",
    "........hhHsksh.........",
    "..........ssss..........",
    ".........ssssss.........",
    "........sssssss.s.......",
    "........Ssssssss........",
    ".........gggggg.........",
    "........ggg.ggg.........",
    ".......SSS...SSS........",
    ".......ss.....ss........",
    "......ss......ss....BB..",
    ".bBBBBBBBBBBBBBBBBBBBW..",
    "..bbbbbbbbbbbbbbbbbbb...",
  ],
  kick: [
    ".......hhhh..........W..",
    ".....hhhhhhh........BB..",
    ".....hHsksh........BB...",
    ".......ssss.......BB....",
    "....s..ssss......BB.....",
    ".....ssssss.....BB......",
    "......ssss.....BB.......",
    "......Sss.....BB........",
    "......ggg....BB.........",
    ".....ggg....BB..........",
    ".....SS....Bb...........",
    ".....ss...Bb............",
    "....ss..................",
    "........................",
  ],
  wipe1: [
    ".....ss....BB.......",
    "......s...BB........",
    "..hhhh...BB.........",
    ".hhhhhh.............",
    ".hsksh..ss..........",
    "..ssssss............",
    "...gggg.s...........",
    "..ggg.ss............",
    ".SS.................",
    ".ss......s..........",
  ],
  wipe2: [
    "........BB..........",
    ".....s.BB...........",
    "....s.hhhh..........",
    "...sshhhhhh.........",
    "....shsksh..........",
    "...ssssss...........",
    "..s.gggg............",
    "....ggg.s...........",
    "...SS....s..........",
    "...ss...............",
  ],
  sit: [
    ".....hhhh......",
    "....hhhhhh.....",
    "...hhHsksh.....",
    ".....ssss......",
    ".....ssss......",
    ".....Ssss......",
    ".....gggg......",
    "....s.ss.s.....",
    "....s.ss.s.....",
    ".BBBBBBBBBBBW..",
  ],
  sitback: [
    ".......hhhh.......",
    "......hhhhhh......",
    "......hhhhhh......",
    "......hHHHhh......",
    ".......ssss.......",
    ".....ssssssss.....",
    "....ss.ssss.ss....",
    "....ss.gggg.ss....",
    ".......gggg.......",
    "......Bssss B.....",
    ".....BBBBBBBB.....",
    "......bbbbbb......",
  ],
  paddle1: [
    "................",
    "......hhhh......",
    "..s..hhshh......",
    "..sssssssssssss.",
    ".bBBBBBBBBBBBBW.",
  ],
  paddle2: [
    "................",
    "......hhhh......",
    ".....hhshh...s..",
    "..sssssssssssss.",
    ".bBBBBBBBBBBBBW.",
  ],
};

// Precompute contour cells (empty cells 4-adjacent to a filled cell).
const OUTLINES = {};
for (const [name, g] of Object.entries(GRIDS)) {
  const rows = g.length, cols = g[0].length;
  const filled = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols && g[r][c] !== ".";
  const cells = [];
  for (let r = -1; r <= rows; r++) {
    for (let c = -1; c <= cols; c++) {
      if (filled(r, c)) continue;
      if (filled(r - 1, c) || filled(r + 1, c) || filled(r, c - 1) || filled(r, c + 1)) {
        cells.push([r, c]);
      }
    }
  }
  OUTLINES[name] = cells;
}

export function drawSprite(ctx, name, x, y, _colors, flip = false, scale = 1) {
  const g = GRIDS[name] || GRIDS.ride;
  const cols = g[0].length;
  const fx = (c) => (flip ? cols - 1 - c : c);
  ctx.fillStyle = INK.k;
  for (const [r, c] of OUTLINES[name] || []) {
    ctx.fillRect(Math.round(x + fx(c) * scale), Math.round(y + r * scale), scale, scale);
  }
  for (let r = 0; r < g.length; r++) {
    const row = g[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === ".") continue;
      ctx.fillStyle = INK[ch] || INK.k;
      ctx.fillRect(Math.round(x + fx(c) * scale), Math.round(y + r * scale), scale, scale);
    }
  }
}

export function spriteSize(name) {
  const g = GRIDS[name] || GRIDS.ride;
  return { w: g[0].length, h: g.length };
}
