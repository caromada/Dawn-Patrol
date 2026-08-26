// Dawn Patrol: spectral wave synthesis.
// Turns a buoy's directional energy spectrum into a shoaling 1-D heightfield.
//
// elevation(x, t) = sum over components i of
//   a_i * g_i(x) * sin( phase_i(x) + 2*pi*f_i*t + phi_i )
// where a_i = sqrt(2 * S(f_i) * df)              amplitude from energy density
//       k solves the full dispersion relation    w^2 = g k tanh(k h)
//       g_i(x) = sqrt(Cg_deep / Cg(x))           shoaling from energy-flux conservation
//       phase_i(x) = integral of k_i dx          so wavelength shortens as depth drops
// Waves break where local height exceeds GAMMA * depth (McCowan's 0.78).

const G = 9.81;
export const GAMMA = 0.78;

// Mulberry32: deterministic phases per session seed.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Solve w^2 = g k tanh(k h) for k, Newton iteration from the deep-water guess.
export function waveNumber(f, h) {
  const w = 2 * Math.PI * f;
  let k = (w * w) / G; // deep-water limit
  for (let i = 0; i < 8; i++) {
    const th = Math.tanh(k * h);
    const fk = G * k * th - w * w;
    const dfk = G * th + G * k * h * (1 - th * th);
    k -= fk / dfk;
  }
  return k;
}

function groupVelocity(k, h) {
  const w = Math.sqrt(G * k * Math.tanh(k * h));
  const n = 0.5 * (1 + (2 * k * h) / Math.sinh(2 * k * h));
  return n * (w / k);
}

// Reduce the buoy's ~64 bins to renderable sinusoid components.
// Direction weighting: energy is projected on the shore-normal so swell
// aimed away from the beach doesn't count. r1 (spread) softens the cut.
export function componentsFromBins(bins, shoreNormal, { maxComponents = 28, seed = 1 } = {}) {
  const rand = rng(seed);
  const comps = [];
  for (let i = 0; i < bins.length; i++) {
    const b = bins[i];
    const df = i === 0 ? bins[1].f - bins[0].f : b.f - bins[i - 1].f;
    if (b.S <= 0) continue;
    let w = 1;
    if (b.dir != null) {
      const rel = ((b.dir - shoreNormal + 540) % 360) - 180; // deg off shore-normal
      const aligned = Math.cos((rel * Math.PI) / 180);
      const spread = b.r1 ?? 0.7; // low r1 = wide spread = direction matters less
      w = Math.max(0, aligned) * spread + (1 - spread) * 0.5;
    }
    const a = Math.sqrt(2 * b.S * df) * Math.sqrt(w);
    if (a < 0.008) continue;
    comps.push({ f: b.f, a, phi: rand() * 2 * Math.PI });
  }
  comps.sort((p, q) => q.a - p.a);
  return comps.slice(0, maxComponents);
}

// A shoaling wave field over a beach profile.
// x runs 0 (deep) -> L (shoreline). depth(x) tapers linearly to the shore.
export class WaveField {
  constructor(comps, { L = 420, dx = 2, dMax = 9, dMin = 0.35 } = {}) {
    this.comps = comps;
    this.L = L;
    this.dx = dx;
    this.n = Math.floor(L / dx) + 1;
    this.depths = new Float32Array(this.n);
    for (let j = 0; j < this.n; j++) {
      this.depths[j] = Math.max(dMin, dMax * (1 - (j * dx) / L));
    }
    // Per component, per node: shoal gain and cumulative phase.
    this.gain = comps.map(() => new Float32Array(this.n));
    this.cumPhase = comps.map(() => new Float32Array(this.n));
    this.omega = comps.map((c) => 2 * Math.PI * c.f);
    comps.forEach((c, i) => {
      const cg0 = groupVelocity(waveNumber(c.f, this.depths[0]), this.depths[0]);
      let ph = 0;
      for (let j = 0; j < this.n; j++) {
        const h = this.depths[j];
        const k = waveNumber(c.f, h);
        ph += k * dx;
        this.cumPhase[i][j] = ph;
        const cg = groupVelocity(k, h);
        this.gain[i][j] = Math.min(2.2, Math.sqrt(cg0 / cg));
      }
    });
  }

  depth(x) {
    const j = Math.min(this.n - 1, Math.max(0, x / this.dx));
    const j0 = Math.floor(j), j1 = Math.min(this.n - 1, j0 + 1), u = j - j0;
    return this.depths[j0] * (1 - u) + this.depths[j1] * u;
  }

  // Surface elevation (m) at cross-shore position x (m) and time t (s).
  elevation(x, t) {
    const j = Math.min(this.n - 1, Math.max(0, x / this.dx));
    const j0 = Math.floor(j), j1 = Math.min(this.n - 1, j0 + 1), u = j - j0;
    let e = 0;
    for (let i = 0; i < this.comps.length; i++) {
      const g = this.gain[i][j0] * (1 - u) + this.gain[i][j1] * u;
      const ph = this.cumPhase[i][j0] * (1 - u) + this.cumPhase[i][j1] * u;
      e += this.comps[i].a * g * Math.sin(ph - this.omega[i] * t + this.comps[i].phi);
    }
    return e;
  }

  // Sample the whole surface once (used per frame by renderer + crest scan).
  sample(t, out) {
    out = out || new Float32Array(this.n);
    for (let j = 0; j < this.n; j++) out[j] = 0;
    for (let i = 0; i < this.comps.length; i++) {
      const c = this.comps[i], w = this.omega[i], gi = this.gain[i], phi = this.cumPhase[i];
      const wtp = c.phi - w * t; // sin(kx - wt): propagates shoreward (+x)
      for (let j = 0; j < this.n; j++) out[j] += c.a * gi[j] * Math.sin(phi[j] + wtp);
    }
    return out;
  }

  // Shallow-water crest speed at x: how fast a broken/breaking front advances.
  crestSpeed(x) {
    return Math.sqrt(G * this.depth(x));
  }

  // Scan a sampled surface for crests; flag the ones steep/tall enough to break.
  // Returns [{x, eta, H, breaking, depth}]
  findCrests(surface) {
    const crests = [];
    for (let j = 2; j < this.n - 2; j++) {
      if (surface[j] > surface[j - 1] && surface[j] >= surface[j + 1] && surface[j] > 0.05) {
        // trough behind (seaward) of the crest
        let tr = surface[j];
        for (let b = j; b > Math.max(0, j - 40); b--) tr = Math.min(tr, surface[b]);
        const H = surface[j] - tr;
        const x = j * this.dx;
        const d = this.depths[j];
        crests.push({ x, eta: surface[j], H, depth: d, breaking: H > GAMMA * d });
      }
    }
    return crests;
  }

  // Significant wave height implied by the components in deep water (sanity checks).
  hsDeep() {
    let m0 = 0;
    for (const c of this.comps) m0 += (c.a * c.a) / 2;
    return 4 * Math.sqrt(m0);
  }
}
