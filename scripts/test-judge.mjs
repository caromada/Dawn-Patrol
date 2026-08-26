// Judge invariants: the scale must behave like a WSL panel.
// Run: node scripts/test-judge.mjs
import { scoreRide, commentary } from "../js/judge.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " . " + detail : ""}`);
  if (!ok) failures++;
};

const base = {
  takeoffH: 1.2, dayHs: 1.3, takeoffQuality: 0.7, duration: 12,
  maneuvers: [], sectionsMade: 0, barrelTime: 0, avgSpeedRatio: 1.1, finish: "kickout",
};

const plain = scoreRide(base);
check("plain completion lands low-mid", plain >= 2 && plain <= 5, String(plain));

const twoTurns = scoreRide({ ...base, maneuvers: [{ type: "snap", quality: 0.8 }, { type: "cutback", quality: 0.7 }] });
check("two solid turns beat a completion", twoTurns > plain + 1, `${twoTurns} vs ${plain}`);

const excellent = scoreRide({
  ...base,
  maneuvers: [{ type: "snap", quality: 0.95 }, { type: "floater", quality: 0.8 }, { type: "cutback", quality: 0.8 }],
  sectionsMade: 2, barrelTime: 0.8, avgSpeedRatio: 1.5,
});
check("excellent ride reaches the 7s", excellent >= 7, String(excellent));
check("nothing exceeds 10", excellent <= 10);

const wipe = scoreRide({ ...base, maneuvers: [{ type: "snap", quality: 0.9 }], finish: "wipeout" });
check("wipeout caps the score", wipe <= 3.4, String(wipe));
check("wipeout still scores something", wipe > 0);

const spam = scoreRide({ ...base, maneuvers: Array(8).fill({ type: "snap", quality: 0.9 }) });
const varied = scoreRide({
  ...base,
  maneuvers: [{ type: "snap", quality: 0.9 }, { type: "cutback", quality: 0.9 }, { type: "floater", quality: 0.9 }],
});
check("variety beats spamming one move", varied >= spam - 0.3, `${varied} vs ${spam}`);

const short = scoreRide({ ...base, duration: 1.5, maneuvers: [{ type: "snap", quality: 1 }] });
check("a 1.5s ride cannot score big", short <= 2.5, String(short));

const det1 = scoreRide(base), det2 = scoreRide(base);
check("scoring is deterministic", det1 === det2);

const line = commentary(excellentTrace(), excellent, "Lower Trestles");
check("commentary is one short line", typeof line === "string" && line.length > 10 && line.length < 120, line);
check("no em dashes in commentary", !line.includes(String.fromCharCode(8212)));

function excellentTrace() {
  return { ...base, maneuvers: [{ type: "snap", quality: 0.95 }], sectionsMade: 2, barrelTime: 1 };
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
