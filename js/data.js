// Loads the buoy spectra committed by the GitHub Actions cron job.
// Falls back to a canned SW groundswell if the file is missing (first clone,
// file:// preview) so the game always boots.

const DEMO = {
  fetchedAt: 0,
  source: "demo spectrum (no live data)",
  stations: [
    {
      id: "DEMO", name: "Demo Groundswell", breakName: "Lower Trestles",
      shoreNormal: 205, obsTime: 0, hs: 1.6, tp: 15.4, peakDir: 200,
      met: { wtmp: 17.5 },
      bins: Array.from({ length: 40 }, (_, i) => {
        const f = 0.03 + i * 0.01;
        // Narrow 15s groundswell peak + a little windswell shoulder.
        const S = 4.2 * Math.exp(-(((f - 0.065) / 0.012) ** 2)) +
                  0.5 * Math.exp(-(((f - 0.16) / 0.05) ** 2));
        return { f, S, dir: 200, r1: 0.85 };
      }),
    },
  ],
};

export async function loadBuoys() {
  try {
    const res = await fetch("data/buoys.json", { cache: "no-cache", signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (!data.stations?.length) throw new Error("empty");
    return { ...data, live: true };
  } catch {
    return { ...DEMO, live: false };
  }
}

export function ageString(obsTime) {
  if (!obsTime) return "DEMO";
  const min = Math.max(0, Math.round((Date.now() - obsTime) / 60000));
  if (min < 60) return `${min}M AGO`;
  return `${Math.floor(min / 60)}H${String(min % 60).padStart(2, "0")} AGO`;
}

export const mToFt = (m) => m * 3.28084;

export function faceScale(hs) {
  // Rough surf-report face height from Hs, for the picker copy.
  const ft = mToFt(hs);
  if (ft < 1.5) return "FLAT";
  if (ft < 3) return "KNEE-WAIST";
  if (ft < 4.5) return "WAIST-CHEST";
  if (ft < 6) return "SHOULDER-HEAD";
  if (ft < 8) return "OVERHEAD";
  return "WELL OVERHEAD";
}
