// The judging panel: deterministic WSL-style scorer plus broadcast commentary
// from a template bank. Booth mode (optional LLM commentary) lives in llm.js;
// this module stays pure and unit-testable.
//
// WSL criteria this leans on: commitment and degree of difficulty,
// combination of major maneuvers, variety, and speed-power-flow.

export function hashTrace(t) {
  let h = 2166136261;
  const s = JSON.stringify(t);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function scoreRide(trace) {
  const { takeoffH, dayHs, takeoffQuality = 0.5, duration = 0, maneuvers = [],
    sectionsMade = 0, barrelTime = 0, avgSpeedRatio = 1, finish = "flats" } = trace;

  let s = 0.6; // stood up and went
  // Commitment and difficulty: wave size relative to the day, late-drop quality.
  s += Math.min(2.2, (takeoffH / Math.max(0.3, dayHs)) * 1.5) + takeoffQuality * 0.6;

  // Major maneuvers with diminishing returns per repeated type.
  const per = { snap: 1.5, cutback: 0.9, floater: 1.1 };
  const counts = {};
  let manPts = 0;
  for (const m of maneuvers) {
    const n = counts[m.type] = (counts[m.type] ?? 0) + 1;
    manPts += (per[m.type] ?? 0.5) * (m.quality ?? 0.5) * Math.pow(0.62, n - 1);
  }
  s += Math.min(3.6, manPts);
  const distinct = Object.keys(counts).length;
  if (distinct >= 3) s += 0.5; // variety
  else if (distinct >= 2) s += 0.2;

  s += Math.min(3.0, barrelTime * 1.4); // time behind the curtain
  s += sectionsMade * 0.3;
  s += Math.max(-0.6, Math.min(0.9, (avgSpeedRatio - 1) * 1.6)); // speed-power-flow

  if (finish === "kickout") s += 0.4;
  else if (finish === "clipped") s -= 0.4;
  else if (finish === "flats") s -= 0.6;
  else if (finish === "wipeout") s = Math.min(s * 0.45, 3.4);

  if (duration < 3) s = Math.min(s, 2.5); // a nothing ride cannot score

  return Math.max(0.1, Math.min(10, Math.round(s * 100) / 100));
}

const LINES = {
  0: [ // 0 - 2.9
    "Never found the open face on that one.",
    "Just a completion. The judges want more than a takeoff.",
    "That wave closed the door early at {break}.",
    "Straightened out early, and the scoreboard shows it.",
  ],
  1: [ // 3 - 4.9
    "Solid start off the top, needed more through the middle section.",
    "One good turn, then the wave shut down at {break}.",
    "Kept the speed but never really put it on rail.",
    "Safe surfing. That is a keeper score, not a heat winner.",
  ],
  2: [ // 5 - 6.9
    "Committed off the top, needed a bigger finish for the excellent range.",
    "Two strong sections linked with real flow. The panel likes it.",
    "Good rhythm through {n} sections, just shy of excellent.",
    "Power surfing in the pocket, lost a little in the transition.",
  ],
  3: [ // 7 - 8.9
    "Committed off the top and blew the tail out of the last section!",
    "That is how you surf {break}: speed, power, and a clean exit.",
    "Full-rail arcs front to back. The panel went straight to the sevens.",
    "Critical from the drop, and that final hit sealed it.",
  ],
  4: [ // 9+
    "Stand up in the booth! That is a near-perfect ride at {break}!",
    "Barreled, vertical, and out clean. Throw the chairs in the water!",
    "That is a statement wave. The judges barely had to talk.",
  ],
};

const MOVE_TAGS = {
  snap: "that hack off the lip",
  cutback: "the wrap back to the source",
  floater: "the glide over the section",
  barrel: "time behind the curtain",
};

export function commentary(trace, score, breakName) {
  const band = score < 3 ? 0 : score < 5 ? 1 : score < 7 ? 2 : score < 9 ? 3 : 4;
  const pool = LINES[band];
  const h = hashTrace(trace);
  let line = pool[h % pool.length]
    .replace("{break}", breakName)
    .replace("{n}", String(Math.max(1, trace.sectionsMade)));
  const best = trace.barrelTime > 0.8 ? "barrel"
    : trace.maneuvers?.slice().sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0))[0]?.type;
  if (best && !line.includes("section") && h % 3 === 0) {
    line = line.replace(/[.!]$/, `, and ${MOVE_TAGS[best]} did the damage.`);
  }
  return line;
}

// Booth-mode key management (the LLM call itself is in llm.js).
export const booth = {
  key: () => localStorage.getItem("dp_anthropic_key") || "",
  setKey: (k) => k ? localStorage.setItem("dp_anthropic_key", k) : localStorage.removeItem("dp_anthropic_key"),
  enabled: () => !!localStorage.getItem("dp_anthropic_key"),
};
