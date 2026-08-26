#!/usr/bin/env node
// Fetch NDBC realtime spectral files for our stations and emit data/buoys.json.
// No dependencies; run with `node scripts/fetch-buoys.mjs`.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://www.ndbc.noaa.gov/data/realtime2";

const STATIONS = [
  { id: "46253", name: "San Pedro South", breakName: "Lower Trestles", shoreNormal: 205 },
  { id: "46225", name: "Torrey Pines Outer", breakName: "Blacks", shoreNormal: 245 },
  { id: "46222", name: "San Pedro", breakName: "Huntington", shoreNormal: 200 },
];

// Every fetch: 15s timeout, one retry with backoff. Raw files are saved
// as fetched (data/raw/) before any parsing, so runs are reprocessable.
async function text(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`${res.status}`);
      const body = await res.text();
      const name = url.split("/").pop();
      mkdirSync(join(ROOT, "data", "raw"), { recursive: true });
      writeFileSync(join(ROOT, "data", "raw", name), body);
      return body;
    } catch (e) {
      if (attempt === 1) throw new Error(`${e.message} ${url}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// Parse one "value (freq)" spectral line file; returns {time, pairs:[[freq,val],...]}
// from the newest data row.
function parseSpectralFile(raw) {
  const line = raw.split("\n").find((l) => l && !l.startsWith("#"));
  if (!line) return null;
  const tok = line.trim().split(/\s+/);
  const [yy, mm, dd, hh, min] = tok.slice(0, 5).map(Number);
  const time = Date.UTC(yy, mm - 1, dd, hh, min);
  const pairs = [];
  // After the 5 date fields, .data_spec has a separation frequency first.
  let i = 5;
  if (tok[i] && !tok[i + 1]?.startsWith("(")) i += 1; // skip Sep_Freq (9.999 = n/a)
  for (; i + 1 < tok.length; i += 2) {
    const val = parseFloat(tok[i]);
    const freq = parseFloat(tok[i + 1].replace(/[()]/g, ""));
    if (Number.isFinite(val) && Number.isFinite(freq)) pairs.push([freq, val]);
  }
  return { time, pairs };
}

// Parse newest row of a column file (.txt / .spec), given its header names.
function parseColumnFile(raw) {
  const lines = raw.split("\n").filter((l) => l.trim());
  const header = lines[0].replace(/^#/, "").trim().split(/\s+/);
  const row = lines.find((l) => !l.startsWith("#"));
  if (!row) return null;
  const vals = row.trim().split(/\s+/);
  const out = {};
  header.forEach((h, i) => (out[h] = vals[i]));
  return out;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n < 99 ? n : null; // NDBC uses 99/999 for missing
}

async function fetchStation(st) {
  const [spec, swdir, swr1, met] = await Promise.all([
    text(`${BASE}/${st.id}.data_spec`),
    text(`${BASE}/${st.id}.swdir`).catch(() => null),
    text(`${BASE}/${st.id}.swr1`).catch(() => null),
    text(`${BASE}/${st.id}.txt`).catch(() => null),
  ]);
  const energy = parseSpectralFile(spec);
  if (!energy) throw new Error(`no spectral data for ${st.id}`);
  const dir = swdir ? parseSpectralFile(swdir) : null;
  const r1 = swr1 ? parseSpectralFile(swr1) : null;
  const dirMap = new Map(dir?.pairs ?? []);
  const r1Map = new Map(r1?.pairs ?? []);

  const bins = energy.pairs.map(([f, S]) => ({
    f,
    S, // m^2/Hz
    dir: dirMap.get(f) ?? null, // deg true, direction waves come FROM
    r1: r1Map.get(f) ?? null, // directional spread parameter 0..1
  }));

  // Integrate m0 for significant wave height, find peak period.
  let m0 = 0, peak = bins[0];
  for (let i = 0; i < bins.length; i++) {
    const df = i === 0 ? bins[1].f - bins[0].f : bins[i].f - bins[i - 1].f;
    m0 += bins[i].S * df;
    if (bins[i].S > peak.S) peak = bins[i];
  }
  const hs = 4 * Math.sqrt(m0);

  const m = met ? parseColumnFile(met) : null;
  return {
    id: st.id,
    name: st.name,
    breakName: st.breakName,
    shoreNormal: st.shoreNormal,
    obsTime: energy.time,
    hs: Math.round(hs * 100) / 100,
    tp: Math.round((1 / peak.f) * 10) / 10,
    peakDir: dirMap.get(peak.f) ?? null,
    met: m
      ? { wvht: num(m.WVHT), dpd: num(m.DPD), mwd: num(m.MWD), wspd: num(m.WSPD), wdir: num(m.WDIR), wtmp: num(m.WTMP) }
      : null,
    bins,
  };
}

const out = { fetchedAt: Date.now(), source: "NDBC realtime2", stations: [] };
for (const st of STATIONS) {
  try {
    out.stations.push(await fetchStation(st));
    console.log(`ok ${st.id} (${st.breakName})`);
  } catch (e) {
    console.error(`FAIL ${st.id}: ${e.message}`);
  }
}
if (!out.stations.length) {
  console.error("no stations fetched; keeping previous data file");
  process.exit(1);
}
mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data", "buoys.json"), JSON.stringify(out));
console.log(`wrote data/buoys.json (${out.stations.length} stations)`);
