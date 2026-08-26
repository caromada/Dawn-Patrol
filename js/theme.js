// Single source of truth for color and motion tokens (mirrored in style.css).
// The pre-dawn set, per the design spec. Do not substitute defaults.

export const PALETTE = {
  skyIndigo: "#1A1F3C",   // pre-dawn sky
  skyDeep: "#12142E",     // zenith, derived from skyIndigo
  outerWater: "#2E4057",
  waveFace: "#4F7CAC",
  foam: "#EAF2E3",
  peach: "#F2B880",       // first light, horizon band, score highlights
  silhouette: "#0E0F14",  // surfer, cliff line, buoy
  waterDeep: "#243349",   // derived shade under the face
  farWater: "#232C46",    // horizon water band
};

export const MOTION = {
  scoreRollMs: 500,   // mechanical counter reveal
  tickerCps: 30,      // commentary typewriter, chars per second
  foamDecayMs: 300,   // particle burst decay
  curlFrames: 6,      // hand-pixeled curl cycle length
};

export const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
