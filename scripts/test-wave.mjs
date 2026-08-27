// Synthesis invariants against the committed real spectrum.
// Run: node scripts/test-wave.mjs
import { readFileSync } from "node:fs";
import { componentsFromBins, WaveField, waveNumber } from "../js/wave.js";

const data = JSON.parse(readFileSync(new URL("../data/buoys.json", import.meta.url)));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ": " + detail : ""}`);
  if (!ok) failures++;
};

// Dispersion relation: deep water k -> (2 pi f)^2 / g, shallow water c -> sqrt(gh)
{
  const f = 0.08, g = 9.81, w = 2 * Math.PI * f;
  const kDeep = waveNumber(f, 4000);
  check("deep-water dispersion", Math.abs(kDeep - (w * w) / g) / kDeep < 0.01);
  const h = 0.5, kSh = waveNumber(f, h);
  check("shallow-water speed ~ sqrt(gh)", Math.abs(w / kSh - Math.sqrt(g * h)) / Math.sqrt(g * h) < 0.05);
}

for (const st of data.stations) {
  const comps = componentsFromBins(st.bins, st.shoreNormal, { seed: 7 });
  check(`${st.id} has components`, comps.length >= 8, `${comps.length} comps`);
  const field = new WaveField(comps);

  // Directional projection discards some energy, so deep-water Hs from the
  // kept components must be positive but not exceed the buoy's full Hs.
  const hs = field.hsDeep();
  check(`${st.id} Hs sane`, hs > 0.2 * st.hs && hs <= st.hs * 1.05, `${hs.toFixed(2)}m vs buoy ${st.hs}m`);

  // Time-series sigma at the deep end should agree with component Hs (Hs = 4 sigma).
  let sum = 0, sum2 = 0, N = 2000;
  for (let i = 0; i < N; i++) {
    const e = field.elevation(4, i * 0.5);
    sum += e; sum2 += e * e;
  }
  const sigma = Math.sqrt(sum2 / N - (sum / N) ** 2);
  check(`${st.id} reconstruction Hs`, Math.abs(4 * sigma - hs) / hs < 0.15, `4σ=${(4 * sigma).toFixed(2)}m vs ${hs.toFixed(2)}m`);

  // Waves must break before the shoreline: some crest over a 20-min window
  // should exceed 0.78 * depth somewhere inshore.
  let broke = false;
  const buf = new Float32Array(field.n);
  for (let t = 0; t < 1200 && !broke; t += 2) {
    broke = field.findCrests(field.sample(t, buf)).some((c) => c.breaking);
  }
  check(`${st.id} produces breaking waves`, broke);

  // Shoaling: average crest height inshore (depth ~1.5m) >= deep water.
  check(`${st.id} shoal gain >= 1`, field.gain.every((g) => g[field.n - 1] >= g[0] * 0.95));
}

// Regression: NDBC 999-style sentinels in dir/r1 must never inflate energy
// or produce NaN (seen live on 46225, 2026-08-27 00:00Z).
{
  const bins = Array.from({ length: 20 }, (_, i) => ({
    f: 0.05 + i * 0.01, S: 0.8,
    dir: i % 3 === 0 ? 999 : 200,
    r1: i % 4 === 0 ? 999 : 0.8,
  }));
  const field = new WaveField(componentsFromBins(bins, 205, { seed: 3 }));
  const hs = field.hsDeep();
  let m0 = 0;
  for (let i = 0; i < bins.length; i++) m0 += bins[i].S * 0.01;
  const hsFull = 4 * Math.sqrt(m0);
  check("sentinel dir/r1 stay finite", Number.isFinite(hs), String(hs));
  check("sentinel dir/r1 never inflate Hs", hs <= hsFull * 1.05, `${hs.toFixed(2)} vs ${hsFull.toFixed(2)}`);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
