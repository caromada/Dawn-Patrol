// Pixel sprites drawn in code: no image files. Same trick as bug-race:
// each frame is a character grid. '#' = surfer silhouette, 'B' = surfboard.
// The surfer is ALWAYS silhouette black: reads as any surfer.

const GRIDS = {
  sit: [
    "......##....",
    "......##....",
    ".....###....",
    ".....###....",
    "....#.##....",
    "....#.##....",
    ".....#.#....",
    "....BBBBB...",
  ],
  paddle1: [
    "............",
    "......###...",
    "..#...###...",
    "..############",
    "..BBBBBBBBBB.",
  ],
  paddle2: [
    "............",
    "......###...",
    "......###.#.",
    "..############",
    "..BBBBBBBBBB.",
  ],
  popup: [
    "......##....",
    "......##....",
    "...######...",
    "..#..###....",
    ".....###....",
    "....##.##...",
    "..BBBBBBBBB.",
  ],
  ride: [
    ".....##.....",
    ".....##.....",
    "..######....",
    ".#...##.....",
    ".....##.....",
    "....##.#....",
    "....#..#....",
    "...##..##...",
    ".BBBBBBBBBB.",
  ],
  crouch: [
    "............",
    "............",
    ".....##.....",
    ".....##.....",
    "..#####.#...",
    "...#.##.#...",
    "...##.##....",
    "..##...##...",
    ".BBBBBBBBBB.",
  ],
  snap: [
    "..BBBB......",
    ".....BBBB##.",
    ".......####.",
    ".....###....",
    "....##.##...",
    "....#...#...",
    "...##...##..",
    "............",
  ],
  cutback: [
    ".....##.....",
    ".....###....",
    "...#####....",
    "..#.###.....",
    "....##.#....",
    "...##...#...",
    "..BBBBBB....",
    "....BBBBBB..",
  ],
  floater: [
    "....##......",
    "..#.##.#....",
    "...####.....",
    "....##......",
    "...#..#.....",
    "...#..#.....",
    ".BBBBBBBBBB.",
    "............",
  ],
  wipe1: [
    "............",
    "....##.#....",
    "..#.###.....",
    "...####.#...",
    "..#.##......",
    "....#.......",
    "............",
    "............",
  ],
  wipe2: [
    "............",
    ".....#......",
    "...##.##....",
    "..#.###.....",
    "....###.#...",
    "...#.#......",
    "............",
    "............",
  ],
  kick: [
    ".....##.....",
    ".....##..B..",
    "..######.B..",
    ".#...##.BB..",
    "....##..B...",
    "...#.#.BB...",
    "...#..#B....",
    "............",
  ],
};

export function drawSprite(ctx, name, x, y, colors, flip = false, scale = 1) {
  const g = GRIDS[name] || GRIDS.ride;
  for (let r = 0; r < g.length; r++) {
    const row = g[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === ".") continue;
      ctx.fillStyle = ch === "B" ? colors.board : colors.body;
      const cc = flip ? row.length - 1 - c : c;
      ctx.fillRect(Math.round(x + cc * scale), Math.round(y + r * scale), scale, scale);
    }
  }
}

export function spriteSize(name) {
  const g = GRIDS[name] || GRIDS.ride;
  return { w: g[0].length, h: g.length };
}
