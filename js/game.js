// Dawn Patrol game core: fixed-timestep loop, surfer state machine, renderer.
// The ocean is the WaveField built from the live buoy spectrum; everything on
// screen derives from it. Whole-pixel rendering only.

import { PALETTE as P, MOTION } from "./theme.js";
import { drawText, drawTextCentered, textWidth, ScoreRoll, Ticker, wrapText } from "./hud.js";
import { drawSprite } from "./sprites.js";
import { scoreRide, commentary, booth } from "./judge.js";
import { boothCommentary } from "./llm.js";
import { sfx, setSurfLevel } from "./audio.js";
import { ageString, mToFt } from "./data.js";

const W = 480, H = 270;          // internal pixel resolution
const SEA_Y = 152;               // screen y of mean sea level
const HORIZON = 100;             // screen y of the horizon
const PPM = 2.4;                 // pixels per meter, horizontal
const EPM = 24;                  // pixels per meter, elevation (readability boost)
const DT = 1 / 60;

const SPRITE_COLORS = { body: P.silhouette, board: P.board };

// 4x4 Bayer matrix for ordered dithering (values 0..15)
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export class Game {
  constructor(canvas, field, station, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.field = field;
    this.st = station;
    this.live = opts.live ?? true;
    this.rm = opts.reducedMotion ?? false;
    this.dayHs = station.hs;

    // Where do waves this size break? First node (from deep) where the day's
    // Hs, shoaled, exceeds GAMMA * depth. The lineup sits just outside it.
    let xBreak = field.L * 0.55;
    for (let j = 0; j < field.n; j++) {
      const g = field.gain.length ? field.gain.reduce((s, arr) => s + arr[j], 0) / field.gain.length : 1;
      if (this.dayHs * g > 0.78 * field.depths[j]) { xBreak = j * field.dx; break; }
    }
    this.xBreak = Math.min(field.L - 60, Math.max(60, xBreak));

    this.t = 0;                       // sim time, seconds
    this.surface = new Float32Array(field.n);
    this.crests = [];
    this.state = "lineup";
    this.px = this.xBreak - 16;       // player world x
    this.cam = 0;
    this.particles = [];
    this.fronts = [];                 // whitewater bores
    this.msg = null;                  // {text, until, color, scale}
    this.rides = 0;
    this.best = Number(localStorage.getItem("dp_best_" + station.id) || 0);
    this.keys = {};
    this.lastPump = { dir: 0, t: 0 };
    this._bound = { down: (e) => this.onKey(e, true), up: (e) => this.onKey(e, false) };
  }

  start() {
    addEventListener("keydown", this._bound.down);
    addEventListener("keyup", this._bound.up);
    this.running = true;
    this.acc = 0;
    this.last = performance.now();
    requestAnimationFrame((n) => this.frame(n));
    // If the browser throttles requestAnimationFrame (background tab,
    // power saving), this keeps the ocean moving at reduced rate.
    this.watchdog = setInterval(() => {
      if (this.running && performance.now() - this.last > 80) this.frame(performance.now());
    }, 100);
  }
  stop() {
    this.running = false;
    clearInterval(this.watchdog);
    removeEventListener("keydown", this._bound.down);
    removeEventListener("keyup", this._bound.up);
  }

  // Unified input: keyboard, and touch buttons call press() directly.
  onKey(e, down) {
    const map = {
      ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
      " ": "action", x: "snap", X: "snap", c: "cut", C: "cut", f: "float", F: "float",
      z: "up", Z: "up", Enter: "action",
    };
    const k = map[e.key];
    if (!k) return;
    e.preventDefault();
    if (down && !this.keys[k]) this.press(k);
    this.keys[k] = down;
  }

  press(k) {
    if (this.state === "lineup" && k === "action") this.tryCatch();
    else if (this.state === "riding") {
      if (k === "up" || k === "down") this.pump(k);
      else if (k === "snap") this.doSnap();
      else if (k === "cut") this.doCutback();
      else if (k === "float") this.doFloater();
      else if (k === "action") this.endRide("kickout");
    } else if (this.state === "scored" && k === "action" && this.scoredAt + 900 < performance.now()) {
      this.state = "lineup";
      this.rideView = false;
      this.px = this.xBreak - 16;
      this.scorePanel = null;
    }
  }

  frame(nowMs) {
    if (!this.running) return;
    this.acc += Math.min(100, nowMs - this.last);
    this.last = nowMs;
    while (this.acc >= 1000 * DT) { this.update(DT); this.acc -= 1000 * DT; }
    this.render();
    requestAnimationFrame((n) => this.frame(n));
  }

  // ---------- simulation ----------

  update(dt) {
    this.t += dt;
    this.field.sample(this.t, this.surface);
    this.crests = this.field.findCrests(this.surface);
    this.updateFronts(dt);

    if (this.state === "lineup") this.updateLineup(dt);
    else if (this.state === "riding") this.updateRiding(dt);
    else if (this.state === "wipeout") this.updateWipeout(dt);

    // particles
    for (const p of this.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 60 * dt; p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    // breaking noise level near the player
    let lvl = 0;
    for (const f of this.fronts) lvl = Math.max(lvl, f.energy * Math.exp(-Math.abs(f.x - this.px) / 60));
    setSurfLevel(lvl);
  }

  eta(x) {
    const j = Math.min(this.field.n - 1, Math.max(0, x / this.field.dx));
    const j0 = Math.floor(j), j1 = Math.min(this.field.n - 1, j0 + 1), u = j - j0;
    return this.surface[j0] * (1 - u) + this.surface[j1] * u;
  }

  updateFronts(dt) {
    // Spawn a whitewater bore where a crest is breaking and none exists yet.
    for (const c of this.crests) {
      if (!c.breaking) continue;
      if (this.fronts.some((f) => Math.abs(f.x - c.x) < 8)) continue;
      this.fronts.push({ x: c.x, energy: Math.min(1.6, c.H), age: 0 });
      this.burst(c.x, this.eta(c.x), 10, P.foam);
    }
    for (const f of this.fronts) {
      f.x += Math.sqrt(9.81 * (this.field.depth(f.x) + f.energy)) * dt;
      f.energy *= Math.exp(-0.10 * dt);
      f.age += dt;
    }
    this.fronts = this.fronts.filter((f) => f.energy > 0.12 && f.x < this.field.L - 4);
  }

  // The next catchable crest seaward of the player.
  incomingCrest() {
    let best = null;
    for (const c of this.crests) {
      if (c.x >= this.px - 1 || c.breaking) continue;
      if (c.H < Math.max(0.25, this.dayHs * 0.35)) continue;
      if (this.px - c.x > 70) continue;
      if (!best || c.x > best.x) best = c;
    }
    return best;
  }

  updateLineup(dt) {
    // paddle to reposition
    if (this.keys.left) this.px -= 9 * dt;
    if (this.keys.right) this.px += 9 * dt;
    this.px = Math.max(40, Math.min(this.xBreak + 10, this.px));
    this.cam = this.px - 90 / PPM * PPM; // keep player left-center
    this.cam = Math.max(0, Math.min(this.field.L - W / PPM, this.px - 200 / PPM));

    const inc = this.incomingCrest();
    this.catchable = inc;
    if (inc && this.px - inc.x < 26 && !this.setPinged) {
      this.setPinged = true;
      sfx.setBell();
      this.flash("OUTSIDE!", P.accent, 1);
    }
    if (!inc) this.setPinged = false;

    // whitewater rolls the player who is caught inside
    for (const f of this.fronts) {
      if (Math.abs(f.x - this.px) < 2 && f.energy > 0.5) {
        this.flash("CAUGHT INSIDE", P.foam, 1);
        this.px = Math.min(this.xBreak + 8, this.px + 12);
        this.burst(this.px, this.eta(this.px), 8, P.foam);
        sfx.wipeout();
        break;
      }
    }
  }

  tryCatch() {
    const inc = this.incomingCrest();
    if (!inc) { this.flash("NO WAVE", P.foam, 1); return; }
    const gap = this.px - inc.x;
    if (gap > 22) { this.flash("TOO EARLY", P.foam, 1); sfx.paddle(); return; }
    // Commit: quality peaks when the pop happens right at the crest.
    const quality = Math.max(0.15, 1 - Math.abs(gap - 6) / 12);
    sfx.popup();
    this.beginRide(inc, quality);
  }

  beginRide(crest, quality) {
    this.state = "riding";
    this.rideView = true;
    this.rideT = 0;
    this.waveX = crest.x;
    this.pos = 5;                       // meters down the line, ahead of the curl
    this.faceY = 0.05;                  // 0 = at the lip, 1 = bottom of the wave
    this.dropT = 0.8;                   // the committed drop off the peak
    this.carveZone = 0;
    this.snapCd = 0; this.cutCd = 0; this.floatCd = 0;
    this.spray = [];
    this.sprayPending = 0;
    // goes left at Blacks, right elsewhere, or steer it with the arrows held at takeoff
    this.rideLeft = this.keys.left ? true : this.keys.right ? false : this.st.id === "46225";
    this.v = this.field.crestSpeed(crest.x);
    this.stallT = 0;
    this.spriteState = "popup";
    this.spriteUntil = this.rideT + 0.35;
    this.trace = {
      takeoffH: Math.round(crest.H * 100) / 100,
      dayHs: this.dayHs,
      takeoffQuality: Math.round(quality * 100) / 100,
      duration: 0, maneuvers: [], sectionsMade: 0,
      barrelTime: 0, avgSpeedRatio: 1, finish: "flats",
    };
    this.speedSum = 0; this.speedN = 0;
    this.engulfT = 0;
    this.sectionWarned = false;
  }

  // Follow the crest we took off on: only consider crests just behind or a
  // little ahead of the last known position, so the tracker rides shoreward
  // with the wave instead of re-locking onto the next set wave outside.
  trackedCrest() {
    let best = null, bd = Infinity;
    for (const c of this.crests) {
      const ahead = c.x - this.waveX;
      if (ahead < -2 || ahead > 9) continue;
      const d = Math.abs(ahead - 0.3);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  pump(dir) {
    const d = dir === "up" ? 1 : -1;
    const since = this.rideT - this.lastPump.t;
    if (this.lastPump.dir !== d && since > 0.12 && since < 0.9) {
      // efficiency peaks mid-face
      const eff = this.pos > 1 && this.pos < 10 ? 1 : 0.4;
      this.v = Math.min(this.v + 0.72 * eff, 1.9 * this.field.crestSpeed(this.waveX));
      sfx.pump();
      if (!this.rm) this.burst(this.px, this.eta(this.px), 2, P.foam);
    }
    this.lastPump = { dir: d, t: this.rideT };
  }

  doSnap() {
    if (this.snapCd > this.rideT) return;
    this.snapCd = this.rideT + 0.9;
    const c = this.field.crestSpeed(this.waveX);
    if (this.pos > 14) { this.flash("TOO FAR OUT ON THE SHOULDER", P.foam, 1); return; }
    if (this.faceY > 0.55) { this.flash("GET UP THE FACE FIRST", P.foam, 1); return; }
    const q = Math.max(0.1, Math.min(1, (this.v / (1.4 * c)) * (1 - this.faceY)));
    this.trace.maneuvers.push({ type: "snap", quality: Math.round(q * 100) / 100 });
    this.v *= 0.75;
    this.faceY = Math.min(1, this.faceY + 0.3);
    this.sprayPending += 16;
    this.spriteState = "snap"; this.spriteUntil = this.rideT + 0.4;
    sfx.snap();
    this.burst(this.px, this.eta(this.px) + 0.8, this.rm ? 0 : 14, P.foam);
    this.flash(q > 0.65 ? "BIG SNAP!" : "SNAP", P.accent, q > 0.65 ? 2 : 1);
    if (this.v < 0.8 * c && q < 0.3) this.startWipeout("dug a rail");
  }

  doCutback() {
    if (this.cutCd > this.rideT) return;
    this.cutCd = this.rideT + 1.2;
    if (this.pos < 4) { this.flash("ALREADY IN THE POCKET", P.foam, 1); return; }
    const q = Math.min(1, this.pos / 14 + this.v / (2.5 * this.field.crestSpeed(this.waveX)));
    this.trace.maneuvers.push({ type: "cutback", quality: Math.round(q * 100) / 100 });
    this.pos = Math.max(2, this.pos - 8);
    this.v *= 0.86;
    this.faceY = Math.min(1, this.faceY + 0.2);
    this.sprayPending += 10;
    this.spriteState = "cutback"; this.spriteUntil = this.rideT + 0.5;
    sfx.cutback();
    this.flash("CUTBACK", P.accent, 1);
  }

  doFloater() {
    const cr = this.trackedCrest();
    if (!cr?.breaking && !this.sectionWarned) { this.flash("NO SECTION", P.foam, 1); return; }
    if (this.faceY > 0.45) { this.flash("CLIMB TO THE LIP", P.foam, 1); return; }
    if (this.floatCd > this.rideT) return;
    this.floatCd = this.rideT + 1.5;
    const q = Math.min(1, this.v / (1.4 * this.field.crestSpeed(this.waveX)));
    this.trace.maneuvers.push({ type: "floater", quality: Math.round(q * 100) / 100 });
    this.trace.sectionsMade += 1;
    this.pos += 5;
    this.faceY = 0.15;
    this.sprayPending += 8;
    this.engulfT = 0;
    this.spriteState = "floater"; this.spriteUntil = this.rideT + 0.6;
    sfx.floater();
    this.flash("FLOATER", P.accent, 1);
  }

  updateRiding(dt) {
    this.rideT += dt;
    this.trace.duration = Math.round(this.rideT * 10) / 10;
    let cr = this.trackedCrest();
    if (cr) {
      this.waveX = cr.x;
      this.lostT = 0;
    } else {
      // crest momentarily lost in the interference pattern: coast on the bore
      this.waveX += this.field.crestSpeed(this.waveX) * dt;
      this.lostT = (this.lostT ?? 0) + dt;
      cr = { x: this.waveX, H: 0.4, depth: this.field.depth(this.waveX), breaking: true, eta: this.eta(this.waveX) };
    }
    if (this.lostT > 1.6 || (this.lostT === 0 && cr.H < 0.2 && this.rideT > 2)) { this.endRide("flats"); return; }
    const c = this.field.crestSpeed(this.waveX);
    this.curH = cr.H; this.curRatio = cr.H / cr.depth; this.curBreaking = cr.breaking;

    // riding the face: up toward the lip bleeds speed, down the face builds it
    if (this.dropT > 0) {
      this.dropT -= dt;
      this.faceY = Math.min(0.8, this.faceY + 1.7 * dt);
      this.v += 1.7 * dt;
      this.sprayPending += 1;
    } else if (this.keys.up) {
      this.faceY = Math.max(0, this.faceY - 2.0 * dt);
      this.v -= 1.0 * dt;
    } else if (this.keys.down) {
      this.faceY = Math.min(1, this.faceY + 2.0 * dt);
      this.v += (1.5 + this.curRatio) * dt;
    } else {
      this.faceY += (0.55 - this.faceY) * 1.1 * dt;
    }
    // a full rail-to-rail carve is the real pump
    const zone = this.faceY < 0.38 ? -1 : this.faceY > 0.62 ? 1 : 0;
    if (zone !== 0 && zone !== this.carveZone) {
      if (this.carveZone !== 0) {
        this.v = Math.min(this.v + 0.7, 1.9 * c);
        sfx.pump();
        this.sprayPending += 4;
      }
      this.carveZone = zone;
    }

    // speed relaxes toward trim speed; position on the face follows.
    this.v += (0.9 * c - this.v) * 0.5 * dt;
    this.pos += (this.v - c) * dt;
    this.px = this.waveX + this.pos;
    this.speedSum += this.v / c; this.speedN++;

    // barrel: plunging crest with the surfer tucked in the pocket
    const ratio = cr.H / cr.depth;
    const inPocket = this.pos > 0.2 && this.pos < 3.2;
    if (ratio > 0.66 && inPocket && !cr.breaking) {
      this.trace.barrelTime += dt;
      this.barreled = true;
      if (Math.floor(this.trace.barrelTime * 5) !== Math.floor((this.trace.barrelTime - dt) * 5)) sfx.barrelTick();
    } else this.barreled = false;

    // section warning as the wave stands up to break
    if (ratio > 0.7 && !cr.breaking && !this.sectionWarned) {
      this.sectionWarned = true;
      sfx.section();
      this.flash("SECTION AHEAD!", P.accent, 2);
    }
    if (cr.breaking) this.sectionWarned = false;

    // consequences of the pocket: whitewater catches slow surfers
    if (cr.breaking && this.pos < 2.5) {
      this.engulfT += dt;
      if (this.engulfT > 1.0) {
        if (this.v < c * 0.95) this.startWipeout("swallowed by the foam ball");
        else this.endRide("clipped");
        return;
      }
    } else this.engulfT = Math.max(0, this.engulfT - dt);

    // caught too high when the lip throws: over the falls
    if (cr.breaking && this.faceY < 0.15 && this.pos < 2.5 && this.dropT <= 0) {
      this.startWipeout("went over with the lip");
      return;
    }
    if (this.pos > 26) { this.endRide("flats"); return; }       // outran it
    if (this.pos < -2) {
      // behind the crest: pitched if it is breaking, faded off the back if not
      if (cr.breaking) this.startWipeout("went over with the lip");
      else this.endRide("flats");
      return;
    }
    if (this.waveX > this.field.L - 28) { this.endRide("beach"); return; }

    // sprite selection
    if (this.rideT > (this.spriteUntil ?? 0)) {
      this.spriteState = this.barreled ? "crouch" : this.v > 1.4 * c ? "crouch" : "ride";
    }
    // camera leads toward shore
    this.cam = Math.max(0, Math.min(this.field.L - W / PPM, this.px - 170 / PPM));
  }

  startWipeout(why) {
    this.state = "wipeout";
    this.wipeT = 0;
    this.wipeWhy = why;
    this.trace.finish = "wipeout";
    sfx.wipeout();
    this.burst(this.px, this.eta(this.px), this.rm ? 0 : 18, P.foam);
  }

  updateWipeout(dt) {
    this.wipeT += dt;
    this.px += 3 * dt;
    if (this.faceY != null) {
      this.faceY = Math.min(1, this.faceY + 2 * dt);
      this.pos = Math.max(0, this.pos - 3 * dt);
    }
    if (this.wipeT > 1.3) this.judge();
  }

  endRide(finish) {
    this.trace.finish = finish === "beach" ? "beach" : finish;
    if (finish === "kickout") { sfx.kickout(); this.spriteState = "kick"; }
    this.judge();
  }

  judge() {
    this.trace.avgSpeedRatio = this.speedN ? Math.round((this.speedSum / this.speedN) * 100) / 100 : 1;
    const score = scoreRide(this.trace);
    const line = commentary(this.trace, score, this.st.breakName);
    this.rides++;
    if (score > this.best) {
      this.best = score;
      localStorage.setItem("dp_best_" + this.st.id, String(score));
    }
    this.state = "scored";
    this.scoredAt = performance.now();
    this.scorePanel = {
      roll: new ScoreRoll(score, this.rm),
      ticker: new Ticker(line, this.rm),
      score,
    };
    sfx.score(score < 4 ? 0 : score < 6 ? 1 : score < 8 ? 2 : 3);
    // booth mode: swap in the LLM line when it lands (never blocks scoring)
    if (booth.enabled()) {
      boothCommentary(booth.key(), this.trace, score, this.st.breakName).then((out) => {
        if (out && this.state === "scored" && this.scorePanel?.score === score) {
          this.scorePanel.ticker = new Ticker(out.commentary, this.rm);
          this.scorePanel.coach = out.coach || null;
          this.scorePanel.llm = true;
        }
      });
    }
  }

  flash(text, color, scale) {
    this.msg = { text, color, scale, until: performance.now() + 1100 };
  }

  burst(wx, eta, n, color) {
    if (this.rm) return;
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: wx + (Math.random() - 0.5) * 3, y: eta + Math.random() * 0.8,
        vx: (Math.random() - 0.5) * 14, vy: -(20 + Math.random() * 40),
        life: MOTION.foamDecayMs / 1000 * (0.6 + Math.random() * 0.8), color,
      });
    }
  }

  // ---------- rendering ----------

  sx(wx) { return Math.round((wx - this.cam) * PPM); }
  sy(eta) { return Math.round(SEA_Y - eta * EPM); }

  render() {
    const g = this.ctx;
    this.renderSky(g);
    if (this.rideView) this.renderWaveWall(g);
    else this.renderSideView(g);
    // barrel vignette
    if (this.barreled && this.state === "riding") {
      g.fillStyle = P.silhouette;
      g.globalAlpha = 0.35;
      g.fillRect(0, 0, W, 26); g.fillRect(0, H - 26, W, 26);
      g.globalAlpha = 1;
      drawTextCentered(g, "BARREL " + this.trace.barrelTime.toFixed(1) + "S", W / 2, 32, P.accent, 1);
    }

    this.renderHud(g);
  }

  renderSky(g) {
    const frame = Math.floor(this.t * 10);
    this._frame = frame;
    const sunX = Math.floor(W * 0.62);
    this._sunX = sunX;
    // tropical midday sky
    g.fillStyle = P.skyDeep; g.fillRect(0, 0, W, 34);
    g.fillStyle = P.sky; g.fillRect(0, 34, W, HORIZON - 34);
    // pale haze pooling at the horizon (Bayer blend)
    g.fillStyle = P.haze;
    for (let y = HORIZON - 16; y < HORIZON; y++) {
      const p = (y - (HORIZON - 16)) / 16;
      for (let x = 0; x < W; x++) {
        if (BAYER[y & 3][x & 3] < p * 14) g.fillRect(x, y, 1, 1);
      }
    }
    g.fillRect(0, HORIZON - 1, W, 1);
    // the sun, high and blazing: gold ring, hot core
    const sunY = 34, sunR = 10;
    for (let dy = -sunR - 3; dy <= sunR + 3; dy++) {
      for (let dx = -sunR - 3; dx <= sunR + 3; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 <= 36) { g.fillStyle = P.foam; g.fillRect(sunX + dx, sunY + dy, 1, 1); }
        else if (d2 <= sunR * sunR) { g.fillStyle = P.accent; g.fillRect(sunX + dx, sunY + dy, 1, 1); }
        else if (d2 <= (sunR + 3) * (sunR + 3) && BAYER[dy & 3][dx & 3] < 6) {
          g.fillStyle = P.accent; g.fillRect(sunX + dx, sunY + dy, 1, 1);
        }
      }
    }
    // trade-wind clouds drifting through
    g.fillStyle = P.foam;
    const CLOUDS = [[70, 46, 1.6], [240, 30, 1.1], [400, 58, 1.3], [150, 70, 0.8]];
    for (let ci = 0; ci < CLOUDS.length; ci++) {
      const [cx0, cy, sc] = CLOUDS[ci];
      const cx = ((cx0 + this.t * (3 + ci)) % (W + 90)) - 45;
      const rows = [[-4, 8], [-3, 16], [-2, 24], [-1, 30], [0, 32], [1, 28], [2, 18]];
      for (const [ry, rw] of rows) {
        const wRow = Math.round(rw * sc);
        g.fillRect(Math.round(cx - wRow / 2), cy + ry, wRow, 1);
      }
    }
    // frigatebirds riding the trades
    g.fillStyle = P.silhouette;
    for (let b = 0; b < 3; b++) {
      const bx = (W + 40 - ((this.t * (6 + b * 2) + b * 150) % (W + 80))) | 0;
      const by = 48 + b * 9 + Math.round(Math.sin(this.t * 2 + b) * 2);
      const wing = Math.floor(this.t * 6 + b) % 2;
      g.fillRect(bx, by, 2, 1);
      if (wing) { g.fillRect(bx - 2, by - 1, 2, 1); g.fillRect(bx + 2, by - 1, 2, 1); }
      else { g.fillRect(bx - 2, by, 2, 1); g.fillRect(bx + 2, by, 2, 1); }
    }
  }

  renderSideView(g) {
    // far water and distant swell lines (the same field, parallaxed)
    // backdrop extends below mean sea level so troughs never expose the void
    g.fillStyle = P.farWater; g.fillRect(0, HORIZON, W, SEA_Y - HORIZON + 60);
    g.fillStyle = P.outerWater;
    for (let i = 0; i < 3; i++) {
      const depthRow = HORIZON + 6 + i * 9;
      for (let x = 0; x < W; x += 2) {
        const wx = (x / PPM + this.cam) * (0.35 + i * 0.1) + i * 60;
        const e = this.eta(Math.max(0, Math.min(this.field.L - 1, wx)));
        g.fillRect(x, Math.round(depthRow - e * 3), 2, 1);
      }
    }

    // main heightfield surface with 16-bit face shading
    const yCol = new Int16Array(W);
    for (let x = 0; x < W; x++) {
      const wx = this.cam + x / PPM;
      yCol[x] = wx >= this.field.L ? H : this.sy(this.eta(wx));
    }
    for (let x = 0; x < W; x++) {
      const ySurf = yCol[x];
      if (ySurf >= H) continue;
      const slope = (yCol[x] - yCol[Math.max(0, x - 2)]) / 2; // + = front face dropping shoreward
      g.fillStyle = P.waveFace;
      g.fillRect(x, ySurf, 1, 14);
      // dithered seam into the mid water, then the deep shade
      g.fillStyle = P.outerWater;
      g.fillRect(x, ySurf + 14 + ((x + ySurf) & 1), 1, H);
      g.fillStyle = P.waterDeep;
      g.fillRect(x, ySurf + 44 + ((x & 1) << 1), 1, H);
      // streaks racing down the face
      if (slope > 0.4 && (x * 31 + this._frame * 3) % 47 < 2) {
        g.fillStyle = P.outerWater;
        g.fillRect(x, ySurf + 3, 1, 7);
      }
      // feathered lip highlight on steep faces
      if (Math.abs(slope) > 0.9) { g.fillStyle = P.foam; g.fillRect(x, ySurf, 1, 2); }
      // sun glints on the mellow water
      if (Math.abs(slope) < 0.3 && ((x * 13 + this._frame * 5) % 89) < 1 && Math.abs(x - this._sunX) < 90) {
        g.fillStyle = P.accent;
        g.fillRect(x, ySurf, 1, 1);
      }
    }

    // breaking crests: the rolled, pitching lip on a 6-frame cycle
    for (const c of this.crests) {
      const ratio = c.H / c.depth;
      if (ratio < 0.62) continue;
      const cx = this.sx(c.x), cy = this.sy(c.eta);
      if (cx < -30 || cx > W + 30) continue;
      const ph = ((this.t * 10 + c.x * 0.7) % MOTION.curlFrames) / MOTION.curlFrames;
      const R = Math.round(Math.min(16, 4 + c.H * 6));
      if (!c.breaking) {
        // feathering: spray blowing back off the lip
        g.fillStyle = P.foam;
        const n = 2 + Math.floor(ph * 3);
        for (let i = 0; i < n; i++) g.fillRect(cx - 2 - i * 2, cy - 1 - (i & 1), 2, 1);
      } else {
        // shadowed cavity under the throwing lip
        g.fillStyle = P.waterDeep;
        for (let dy = 2; dy < Math.round(R * 0.9); dy++) {
          const wl = Math.max(1, Math.round(R * 0.55 * (1 - Math.abs(dy - R * 0.45) / (R * 0.45))));
          g.fillRect(cx + 2, cy + dy, wl, 1);
        }
        // the lip itself: a foam ring thrown toward the beach
        g.fillStyle = P.foam;
        const prog = 0.55 + ph * 0.45;
        for (let a = -0.2; a < Math.PI * prog; a += 0.08) {
          const lx = cx + Math.round(Math.sin(a) * R);
          const ly = cy + Math.round((1 - Math.cos(a)) * R * 0.62);
          g.fillRect(lx, ly, 2, 2);
        }
        // spray off the tip
        if (!this.rm && (this._frame & 1) === 0) {
          g.fillRect(cx + R, cy + Math.round(R * 0.3), 1, 1);
          g.fillRect(cx + R + 2, cy + Math.round(R * 0.55), 1, 1);
        }
      }
    }

    // whitewater bores
    for (const f of this.fronts) {
      const fx = this.sx(f.x);
      if (fx < -20 || fx > W + 20) continue;
      const e = this.eta(f.x);
      const top = this.sy(e + f.energy * 0.5);
      const wpx = Math.round(6 + f.energy * 10);
      for (let i = -wpx; i < 4; i++) {
        const x = fx + i;
        if (x < 0 || x >= W) continue;
        const hgt = Math.round((1 - Math.abs(i) / (wpx + 2)) * (4 + f.energy * 8));
        const yTop = top + 2 - hgt + Math.abs(i >> 2);
        // solid rolling crown over dithered churn
        g.fillStyle = P.foam;
        g.fillRect(x, yTop, 1, Math.min(2, hgt));
        for (let yy = 2; yy < hgt; yy++) {
          if ((x + yy + (Math.floor(this.t * 8) % 2)) % 2 === 0) g.fillRect(x, yTop + yy, 1, 1);
        }
      }
    }

    // the buoy itself, riding its own data
    {
      const bx = this.sx(28), by = this.sy(this.eta(28));
      if (bx > -6 && bx < W + 6) {
        g.fillStyle = P.silhouette;
        g.fillRect(bx - 2, by - 4, 5, 4);
        g.fillRect(bx, by - 7, 1, 3);
        if (Math.floor(performance.now() / 1000) % 2 === 0) {
          g.fillStyle = P.accent; g.fillRect(bx, by - 8, 1, 1);
        }
      }
    }

    // golden beach rising at the far right of the world
    {
      const shoreX = this.sx(this.field.L - 14);
      if (shoreX < W + 30) {
        for (let x = Math.max(0, shoreX); x < W; x++) {
          const rise = Math.min(42, Math.round((x - shoreX) * 0.6));
          const top = SEA_Y - 4 - rise;
          g.fillStyle = P.sand;
          g.fillRect(x, top, 1, H);
          g.fillStyle = P.palmTrunk;
          for (let y = top; y < H; y += 3) {
            if (((x * 11 + y * 17) % 23) < 2) g.fillRect(x, y, 1, 1);
          }
          g.fillStyle = P.foam;
          if ((x + this._frame) % 3 !== 0) g.fillRect(x, top, 1, 1);
        }
      }
    }

    this.renderSurfer(g);

    // particles
    for (const p of this.particles) {
      g.fillStyle = p.color;
      g.fillRect(this.sx(p.x), this.sy(p.y), 1, 1);
    }

  }

  // The ride view: California Games style. The wave stands up across the
  // screen, curl and whitewater chasing from one side, open shoulder ahead.
  // Screen x maps to meters down the line; the sim still drives everything.
  renderWaveWall(g) {
    const yBase = 236;
    const Hpx = Math.max(26, Math.min(118, (this.curH ?? 1) * 52));
    const CURL_X = 92, PXPOS = 10;
    // water between the horizon and the wave
    g.fillStyle = P.farWater; g.fillRect(0, HORIZON, W, yBase - HORIZON);
    g.fillStyle = P.outerWater; g.fillRect(0, HORIZON + 22, W, 16);
    g.save();
    if (this.rideLeft) { g.translate(W, 0); g.scale(-1, 1); }
    const topAt = (x) => {
      const posAt = (x - CURL_X) / PXPOS;
      const taper = posAt < 0 ? 1 : 0.3 + 0.7 * Math.exp(-posAt / 16);
      const ripple = Math.sin(x * 0.045 + this.t * 2.6) * 2 + Math.sin(x * 0.02 - this.t * 1.8) * 2;
      return Math.round(yBase - Hpx * taper + ripple);
    };
    const dither = Math.floor(this.t * 10) % 2;
    for (let x = 0; x < W; x++) {
      const posAt = (x - CURL_X) / PXPOS;
      const topY = topAt(x);
      const hCol = yBase - topY;
      if (posAt < -1) {
        // broken wall behind the curl: churning whitewater
        g.fillStyle = P.waveFace; g.fillRect(x, topY, 1, hCol);
        g.fillStyle = P.foam;
        for (let y = topY - 2; y < yBase; y++) {
          if ((x + y + dither) % 2 === 0) g.fillRect(x, y, 1, 1);
        }
      } else {
        // open face: turquoise top, deeper water at the base
        g.fillStyle = P.waveFace; g.fillRect(x, topY, 1, Math.max(1, Math.round(hCol * 0.58)));
        g.fillStyle = P.outerWater; g.fillRect(x, topY + Math.round(hCol * 0.58), 1, hCol);
        // feathering lip near the curl and over a warning section down the line
        const inSection = this.sectionWarned && posAt > this.pos + 4 && posAt < this.pos + 12;
        if (posAt < 5 || inSection) {
          g.fillStyle = P.foam;
          g.fillRect(x, topY - 1, 1, 2 + ((x + Math.floor(this.t * 8)) % 2));
          if (inSection && (x + dither) % 3 === 0) g.fillRect(x, topY + 4, 1, 3);
        }
        // streaks racing down the face
        if ((x * 31 + Math.floor(this.t * 30)) % 41 < 2) {
          g.fillStyle = P.outerWater;
          g.fillRect(x, topY + 3, 1, Math.max(3, Math.round(hCol * 0.3)));
        }
      }
    }
    // flats in front of the wave
    g.fillStyle = P.outerWater; g.fillRect(0, yBase, W, H - yBase);
    g.fillStyle = P.waterDeep; g.fillRect(0, yBase + 16, W, H);
    g.fillStyle = P.foam;
    for (let x = 0; x < W; x += 2) {
      if ((x + Math.floor(this.t * 6)) % 5 < 2) g.fillRect(x, yBase + ((x * 7) % 3), 2, 1);
    }
    // the curl: a rolled barrel pitching over at the peak
    const R = Math.round(Hpx * 0.48);
    const ph = (Math.floor(this.t * 10) % MOTION.curlFrames) / MOTION.curlFrames;
    const cy0 = topAt(CURL_X);
    g.fillStyle = P.waterDeep;
    for (let dy = 4; dy < R; dy++) {
      const wl = Math.max(1, Math.round(R * 0.5 * (1 - Math.abs(dy - R * 0.5) / (R * 0.5))));
      g.fillRect(CURL_X + 3, cy0 + dy + 2, wl, 1);
    }
    g.fillStyle = P.foam;
    for (let a = -0.3; a < Math.PI * (0.6 + ph * 0.4); a += 0.05) {
      const lx = CURL_X + Math.round(Math.sin(a) * R);
      const ly = cy0 + Math.round((1 - Math.cos(a)) * R * 0.7);
      g.fillRect(lx, ly, 3, 3);
    }
    if (!this.rm && dither === 0) {
      g.fillRect(CURL_X + R + 2, cy0 + Math.round(R * 0.4), 2, 2);
      g.fillRect(CURL_X + R + 5, cy0 + Math.round(R * 0.7), 2, 2);
    }
    // the surfer on the face
    const sxp = Math.round(CURL_X + (this.pos ?? 3) * PXPOS);
    const topS = topAt(sxp);
    const syp = Math.round(topS + (this.faceY ?? 0.5) * (yBase - topS - 6)) - 14;
    let sprite = "ride";
    if (this.state === "wipeout") sprite = Math.floor(this.wipeT * 8) % 2 ? "wipe1" : "wipe2";
    else if (this.dropT > 0) sprite = "popup";
    else if (this.rideT < (this.spriteUntil ?? 0)) sprite = this.spriteState || "ride";
    else sprite = this.barreled || this.v > 1.5 * this.field.crestSpeed(this.waveX) ? "crouch" : "ride";
    drawSprite(g, sprite, sxp - 16, syp - 8, SPRITE_COLORS, false, 2);
    // spray off the board
    while (this.sprayPending > 0) {
      this.sprayPending--;
      if (!this.rm) this.spray.push({
        x: sxp - 8 + Math.random() * 10, y: syp + 15,
        vx: -(15 + Math.random() * 55), vy: -(25 + Math.random() * 65),
        life: 0.35 + Math.random() * 0.35,
      });
    }
    g.fillStyle = P.foam;
    for (const sp of this.spray) {
      sp.x += sp.vx / 60; sp.y += sp.vy / 60; sp.vy += 150 / 60; sp.life -= 1 / 60;
      g.fillRect(Math.round(sp.x), Math.round(sp.y), 2, 2);
    }
    this.spray = this.spray.filter((sp) => sp.life > 0 && sp.y < H - 4);
    g.restore();
  }


  renderSurfer(g) {
    const sx = this.sx(this.px);
    let sprite = "sit", flip = false;
    let sy = this.sy(this.eta(this.px)) - 7;
    if (this.state === "lineup") {
      sprite = this.keys.left || this.keys.right ? (Math.floor(this.t * 6) % 2 ? "paddle1" : "paddle2") : "sit";
      sy = this.sy(this.eta(this.px)) - (sprite === "sit" ? 14 : 8);
      flip = !!this.keys.left;
    } else if (this.state === "riding") {
      sprite = this.spriteState || "ride";
      sy = this.sy(this.eta(this.px)) - 16;
    } else if (this.state === "wipeout") {
      sprite = Math.floor(this.wipeT * 8) % 2 ? "wipe1" : "wipe2";
      sy = this.sy(this.eta(this.px)) - 12 + Math.round(Math.sin(this.wipeT * 9) * 2);
    } else if (this.state === "scored") {
      sprite = "sit";
      sy = this.sy(this.eta(this.px)) - 14;
    }
    drawSprite(g, sprite, sx - 16, sy - 6, SPRITE_COLORS, flip, 2);
  }

  renderHud(g) {
    // telemetry strip: the constant reminder that this ocean is not fake
    g.fillStyle = P.silhouette;
    g.fillRect(0, 0, W, 11);
    const obs = this.st.obsTime ? new Date(this.st.obsTime) : null;
    const obsStr = obs ? `${String(obs.getUTCHours()).padStart(2, "0")}${String(obs.getUTCMinutes()).padStart(2, "0")}Z` : "----";
    const tele = `${this.st.id} ${this.st.name.toUpperCase()} HS ${this.st.hs.toFixed(1)}M/${mToFt(this.st.hs).toFixed(0)}FT TP ${this.st.tp.toFixed(1)}S ${this.st.peakDir ?? "--"}° OBS ${obsStr} ${ageString(this.st.obsTime)}`;
    drawText(g, tele, 3, 2, P.foam, 1);
    if (this.live && Math.floor(performance.now() / 800) % 2 === 0) {
      g.fillStyle = P.accent;
      g.fillRect(W - 6, 4, 3, 3);
    }

    // bottom status row
    g.fillStyle = P.silhouette;
    g.fillRect(0, H - 12, W, 12);
    if (this.state === "riding") {
      const c = this.field.crestSpeed(this.waveX);
      const frac = Math.max(0, Math.min(1, this.v / (2.3 * c)));
      drawText(g, "SPD", 3, H - 10, P.foam, 1);
      g.fillStyle = P.outerWater; g.fillRect(26, H - 8, 50, 4);
      g.fillStyle = frac > 0.6 ? P.accent : P.waveFace; g.fillRect(26, H - 8, Math.round(50 * frac), 4);
      drawText(g, `${this.trace.maneuvers.length} MVS ${this.trace.sectionsMade} SEC`, 84, H - 10, P.foam, 1);
    } else if (this.state === "lineup") {
      const inc = this.incomingCrest();
      drawText(g, inc ? `SET ${Math.max(0, Math.round(this.px - inc.x))}M OUT  SPACE TO GO` : "WAIT FOR THE SET  </> TO MOVE", 3, H - 10, P.foam, 1);
    }
    drawText(g, `BEST ${this.best ? this.best.toFixed(2) : "-.--"}  W${this.rides}`, W - 3 - textWidth(`BEST 00.00  W00`), H - 10, P.accent, 1);

    // catch indicator over the incoming crest
    if (this.state === "lineup" && this.catchable) {
      const cx = this.sx(this.catchable.x);
      const gap = this.px - this.catchable.x;
      if (cx > -10 && cx < W) {
        drawTextCentered(g, "▼", cx, this.sy(this.catchable.eta) - 14, gap < 22 ? P.accent : P.foam, 1);
        if (gap < 22) drawTextCentered(g, "PADDLE!", cx, this.sy(this.catchable.eta) - 24, P.accent, 1);
      }
    }

    // flash message
    if (this.msg && performance.now() < this.msg.until) {
      drawTextCentered(g, this.msg.text, W / 2, 58, this.msg.color, this.msg.scale);
    }

    // score panel
    if (this.state === "scored" && this.scorePanel) {
      const pw = 300, ph = 96, px0 = (W - pw) / 2, py0 = 70;
      g.fillStyle = P.silhouette; g.globalAlpha = 0.88;
      g.fillRect(px0, py0, pw, ph);
      g.globalAlpha = 1;
      g.fillStyle = P.accent; g.fillRect(px0, py0, pw, 1); g.fillRect(px0, py0 + ph - 1, pw, 1);
      drawTextCentered(g, "JUDGES CALL", W / 2, py0 + 7, P.foam, 1);
      drawTextCentered(g, this.scorePanel.roll.text(), W / 2, py0 + 20, P.accent, 3);
      const lines = wrapText(this.scorePanel.ticker.text(), 46);
      lines.slice(0, 2).forEach((ln, i) => drawTextCentered(g, ln, W / 2, py0 + 50 + i * 10, P.foam, 1));
      if (this.scorePanel.llm) drawText(g, "AI BOOTH", px0 + 4, py0 + ph - 10, P.waveFace, 1);
      if (this.scorePanel.coach && this.scorePanel.ticker.done()) {
        drawTextCentered(g, "COACH: " + this.scorePanel.coach.toUpperCase().slice(0, 60), W / 2, py0 + ph + 6, P.waveFace, 1);
      }
      if (this.scorePanel.roll.done() && this.scorePanel.ticker.done()) {
        if (Math.floor(performance.now() / 600) % 2 === 0) {
          drawTextCentered(g, "SPACE: NEXT WAVE", W / 2, py0 + ph - 12, P.accent, 1);
        }
      }
    }
  }
}

export const INTERNAL = { W, H };
