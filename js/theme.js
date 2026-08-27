// Single source of truth for color and motion tokens (mirrored in style.css).
// The pacific-paradise set: midday in Indo/Hawaii, vibrant turquoise and gold.

export const PALETTE = {
  skyDeep: "#1B7FD4",     // zenith blue
  sky: "#45B8F0",         // tropical midday sky
  haze: "#A8E6F5",        // pale haze at the horizon
  farWater: "#0F6E9E",    // horizon water band
  outerWater: "#178FB5",  // open ocean
  waveFace: "#35D6C3",    // turquoise wave face
  waterDeep: "#0A5578",   // under the face
  foam: "#F5FFFA",        // whitewater, clouds
  accent: "#FFC845",      // sun gold, score highlights
  silhouette: "#0E0F14",  // the surfer, birds, rocks. Always silhouette.
  sand: "#EFCE8C",        // golden beach
  board: "#FF5A47",       // coral board under the silhouette
  palmTrunk: "#8A5A33",
  palmFrond: "#2E9E5B",
};

export const MOTION = {
  scoreRollMs: 500,   // mechanical counter reveal
  tickerCps: 30,      // commentary typewriter, chars per second
  foamDecayMs: 300,   // particle burst decay
  curlFrames: 6,      // hand-pixeled curl cycle length
};

export const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
