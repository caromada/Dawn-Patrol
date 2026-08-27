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
    this.wake = [];
    this.man = null; // active maneuver tween
    // point breaks peel right; steer it yourself with an arrow held at takeoff
    this.rideLeft = this.keys.left ? true : false;
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
    this.v *= 0.78;
    this.man = { type: "snap", t0: this.rideT, dur: 0.5, fromPos: this.pos, fromFace: this.faceY };
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
    this.v *= 0.88;
    this.man = { type: "cutback", t0: this.rideT, dur: 0.75, fromPos: this.pos, toPos: Math.max(2, this.pos - 8), fromFace: this.faceY };
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
    this.engulfT = 0;
    this.man = { type: "floater", t0: this.rideT, dur: 0.65, fromPos: this.pos, toPos: this.pos + 5, fromFace: this.faceY };
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
    // an active maneuver owns the board: eased arcs, not teleports
    if (this.man) {
      const u = Math.min(1, (this.rideT - this.man.t0) / this.man.dur);
      const ease = u * u * (3 - 2 * u);
      if (this.man.type === "cutback") {
        this.pos = this.man.fromPos + (this.man.toPos - this.man.fromPos) * ease;
        this.faceY = Math.max(0.02, this.man.fromFace - Math.sin(Math.PI * u) * 0.34);
        this.sprayPending += 2;
      } else if (this.man.type === "snap") {
        const up = Math.sin(Math.PI * Math.min(1, u * 1.3)) * 0.3;
        this.faceY = Math.max(0, this.man.fromFace - up + (u > 0.55 ? (u - 0.55) * 0.75 : 0));
        this.pos = this.man.fromPos + Math.sin(Math.PI * u) * 0.7;
        this.sprayPending += u < 0.5 ? 4 : 1;
      } else if (this.man.type === "floater") {
        this.pos = this.man.fromPos + (this.man.toPos - this.man.fromPos) * u;
        this.faceY = Math.min(this.man.fromFace, 0.1);
        this.sprayPending += 1;
      }
      if (u >= 1) this.man = null;
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
    if ((Math.floor(this.rideT * 60) & 1) === 0) {
      this.wake.push({ p: this.pos, f: this.faceY });
      if (this.wake.length > 30) this.wake.shift();
    }

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

  // The lineup, first person: you sit facing the horizon and the synthesized
  // swells roll in at you. Far lines are the next sets; the closest line is
  // the one you catch. No beach, no diagrams, just you and the incoming ocean.
  renderSideView(g) {
    const t = this.t;
    const OC_TOP = HORIZON;             // renderSky painted down to here
    const OC_BOT = H - 14;
    const maxD = 95;                    // how far out you can read the sets

    // open ocean in perspective: deep far, turquoise near
    const g1 = OC_TOP + 30, g2 = OC_TOP + 88;
    g.fillStyle = P.farWater; g.fillRect(0, OC_TOP, W, g1 - OC_TOP);
    g.fillStyle = P.outerWater; g.fillRect(0, g1, W, g2 - g1);
    g.fillStyle = P.waveFace; g.fillRect(0, g2, W, H - g2);
    g.fillStyle = P.outerWater;
    for (let y = g1; y < g1 + 5; y++) for (let x = 0; x < W; x++) if (BAYER[y & 3][x & 3] < 6) g.fillRect(x, y, 1, 1);
    g.fillStyle = P.waveFace;
    for (let y = g2; y < g2 + 5; y++) for (let x = 0; x < W; x++) if (BAYER[y & 3][x & 3] < 6) g.fillRect(x, y, 1, 1);
    // drifting chop texture, bigger as it nears
    const drift2 = Math.floor(t * 10);
    for (let i = 0; i < 90; i++) {
      const u = ((i * 53) % 90) / 90;
      const yy = OC_TOP + 4 + Math.round(Math.pow(u, 1.5) * (OC_BOT - OC_TOP - 8));
      const xx = ((i * 131 + 9000 - drift2 * (1 + Math.round(u * 3))) % (W + 20)) - 10;
      g.fillStyle = i % 5 === 0 ? P.foam : P.haze;
      g.fillRect(xx, yy, u > 0.5 ? 2 : 1, 1);
    }
    // the buoy, blinking way out near the horizon
    {
      const bx = 96 + Math.round(Math.sin(t * 0.4) * 2);
      const by = OC_TOP + 7 + Math.round(Math.sin(t * 0.9) * 1);
      g.fillStyle = P.silhouette;
      g.fillRect(bx, by, 3, 3); g.fillRect(bx + 1, by - 2, 1, 2);
      if (Math.floor(t) % 2 === 0) { g.fillStyle = P.accent; g.fillRect(bx + 1, by - 3, 1, 1); }
    }

    // every crest seaward of you is a swell line rolling in
    const lineY = (d) => OC_TOP + 2 + Math.pow(1 - d / maxD, 1.7) * (OC_BOT - 26 - OC_TOP);
    const sorted = this.crests.filter((c) => c.x < this.px && this.px - c.x < maxD)
      .sort((a, b) => (this.px - b.x) - (this.px - a.x));
    for (const c of sorted) {
      const d = this.px - c.x;
      const u = 1 - d / maxD;
      const yL = Math.round(lineY(d));
      const amp = Math.max(1, Math.round(c.H * (1.5 + u * 9)));
      const isTarget = this.catchable && Math.abs(c.x - this.catchable.x) < 2;
      const tall = Math.round(amp * (u > 0.7 ? 1.5 : 1));
      for (let x = 0; x < W; x++) {
        const yy = yL + Math.round(Math.sin(x * 0.025 + c.x * 0.6 + t * 0.6) * (1 + u * 2));
        // the swell: bright crest, shaded face, dark base so it has body
        g.fillStyle = P.outerWater;
        g.fillRect(x, yy, 1, tall);
        g.fillStyle = P.waterDeep;
        g.fillRect(x, yy + tall, 1, Math.max(1, tall >> 1));
        g.fillStyle = u > 0.4 ? P.haze : P.foam;
        if ((x + drift2) % (u > 0.5 ? 2 : 4) === 0) g.fillRect(x, yy - 1, 1, 1);
        if (u > 0.55) { g.fillStyle = P.haze; if (BAYER[yy & 3][x & 3] < 5) g.fillRect(x, yy + 1, 1, 2); }
        if (c.breaking) {
          g.fillStyle = P.foam;
          g.fillRect(x, yy - 2, 1, 2 + ((x * 7 + drift2) % 3));
        }
      }
      if (isTarget) {
        const gap = this.px - c.x;
        const cxm = W / 2;
        drawTextCentered(g, "▼", cxm, yL - 16, gap < 22 ? P.accent : P.foam, 1);
        if (gap < 22) drawTextCentered(g, "PADDLE!", cxm, yL - 26, P.accent, 1);
        else drawTextCentered(g, Math.round(gap) + "M", cxm, yL - 26, P.foam, 1);
      }
    }

    // whitewater already rolling toward you
    for (const f of this.fronts) {
      const d = this.px - f.x;
      if (d <= 0 || d > maxD) continue;
      const u = 1 - d / maxD;
      const yL = Math.round(lineY(d));
      const th = Math.max(2, Math.round(f.energy * (2 + u * 8)));
      for (let x = 0; x < W; x += 2) {
        const yy = yL + Math.round(Math.sin(x * 0.05 + t * 2) * 2);
        const n = (x * 31 + (yy + Math.floor(t * 8)) * 17) % 23;
        if (n < 12) { g.fillStyle = P.foam; g.fillRect(x, yy - th, 2, th + 2); }
        else if (n < 15) { g.fillStyle = P.haze; g.fillRect(x, yy - th, 2, th); }
      }
    }

    // you, sitting on the board, bobbing on the actual surface
    const bob = Math.round(this.eta(this.px) * 5);
    const paddling = this.keys.left || this.keys.right;
    const lean = paddling ? (this.keys.left ? -2 : 2) : 0;
    drawSprite(g, "sitback", W / 2 - 27 + lean, H - 62 + bob, null, false, 3);
    // paddle splash
    if (paddling && !this.rm) {
      g.fillStyle = P.foam;
      for (let i = 0; i < 4; i++) {
        const sxp2 = W / 2 + (this.keys.left ? -34 : 30) + ((Math.floor(t * 20) + i * 5) % 10);
        g.fillRect(sxp2, H - 34 + ((i * 7 + Math.floor(t * 14)) % 8), 2, 2);
      }
    }
  }

  // The ride view, straight from the California Games playbook: the camera
  // is ON the wave. The face fills the screen, crest line across the top,
  // whitewater chasing from the side, and the texture streams past at the
  // speed you are actually surfing.
  renderWaveWall(g) {
    const t = this.t;
    const Hm = this.curH ?? 1;
    const crestBase = 96 - Math.round(Math.min(20, Hm * 10)) - Math.round((this.faceY ?? 0.5) * 7);
    const faceBot = H - 14;
    const CX0 = 56, PX = 13;
    g.save();
    if (this.rideLeft) { g.translate(W, 0); g.scale(-1, 1); }

    // the ocean behind the wave, and its horizon
    g.fillStyle = P.farWater; g.fillRect(0, 62, W, crestBase + 6 - 62);
    g.fillStyle = P.haze; g.fillRect(0, 62, W, 1);
    g.fillStyle = P.foam;
    for (let x = 0; x < W; x += 2) {
      if (((x + 9000 - Math.floor(t * 8)) * 17) % 83 < 2) g.fillRect(x, 68 + ((x * 13) % 16), 2, 1);
    }

    const crestAt = (x) => Math.round(crestBase + Math.sin(x * 0.045 + t * 1.7) * 2 + Math.sin(x * 0.011 - t * 0.9) * 2);

    // the face: banded gradient columns under a layered crest line
    for (let x = 0; x < W; x++) {
      const cy = crestAt(x);
      const h = faceBot - cy;
      const b1 = cy + 8;
      const b2 = cy + Math.round(h * 0.45);
      g.fillStyle = P.waveFace; g.fillRect(x, cy, 1, b1 - cy);
      g.fillStyle = P.outerWater; g.fillRect(x, b1, 1, b2 - b1);
      g.fillStyle = P.waterDeep; g.fillRect(x, b2, 1, faceBot - b2 + 14);
      g.fillStyle = P.outerWater;
      for (let y = b1; y < b1 + 4; y++) if (BAYER[y & 3][x & 3] < 6) g.fillRect(x, y, 1, 1);
      g.fillStyle = P.waterDeep;
      for (let y = b2; y < b2 + 4; y++) if (BAYER[y & 3][x & 3] < 6) g.fillRect(x, y, 1, 1);
      // crest: foam edge, broken foam dashes, then a sparkle line
      g.fillStyle = P.foam;
      g.fillRect(x, cy - 2, 1, 3 + ((x + Math.floor(t * 12)) % 5 === 0 ? 1 : 0));
      if ((x + ((x / 7) | 0)) % 7 < 3) g.fillRect(x, cy + 3, 1, 1);
      g.fillStyle = P.haze;
      if ((x + Math.floor(t * 20)) % 4 < 2) g.fillRect(x, cy + 7, 1, 1);
    }

    // face texture, straight off the C64: drifting speckle on the upper
    // face, rows of little comb ripples lower down, all moving at board speed
    const vNorm = Math.min(1.8, (this.v ?? 4) / 4.5);
    const flow = Math.floor(t * (30 + 55 * vNorm));
    for (let i = 0; i < 80; i++) {
      const yy = crestBase + 12 + ((i * 37) % Math.round((faceBot - crestBase) * 0.5));
      const xx = ((i * 131 + 9000 - flow) % (W + 20)) - 10;
      g.fillStyle = i % 6 === 0 ? P.accent : P.haze;
      g.fillRect(xx, yy, i % 3 === 0 ? 2 : 1, 1);
    }
    for (let row = 0; row < 5; row++) {
      const baseY = crestBase + Math.round((faceBot - crestBase) * (0.5 + row * 0.115));
      for (let k3 = 0; k3 < 12; k3++) {
        const xx = ((k3 * 47 + row * 29 + 9000 - flow) % (W + 40)) - 20;
        const yy = baseY + ((k3 * 13 + row * 7) % 6);
        g.fillStyle = P.haze;
        for (let fin = 0; fin < 3; fin++) {
          g.fillRect(xx + fin * 4, yy, 1, 2);
          g.fillRect(xx + fin * 4 + 1, yy + 2, 1, 2);
        }
        if (k3 % 4 === 0) { g.fillStyle = P.foam; g.fillRect(xx + 1, yy, 1, 2); }
      }
    }

    // the broken water: sweeps in diagonally from the lip, chunky foam
    // blocks boiling, reaching further out the closer the curl gets
    const surferX = Math.round(CX0 + (this.pos ?? 4) * PX);
    let danger = Math.max(0, 1 - (this.pos ?? 6) / 6);
    if (this.state === "wipeout") danger = Math.min(1.6, danger + this.wipeT * 1.4);
    for (let y = crestBase - 6; y < faceBot + 14; y += 2) {
      const u2 = Math.max(0, (y - crestBase) / (faceBot - crestBase));
      const diag = (1 - u2) * (30 + danger * 100) + (this.state === "wipeout" ? danger * 120 * u2 : 0);
      const rag = Math.sin(y * 0.22 + t * 2.6) * 5 + Math.sin(y * 0.06 - t * 1.2) * 8;
      const wEdge = Math.max(4, Math.round(CX0 - 24 + diag + rag));
      for (let x = 0; x < wEdge; x += 2) {
        const n = ((x >> 1) * 31 + ((y >> 1) + Math.floor(t * 7)) * 17) % 29;
        if (n < 12) g.fillStyle = P.foam;
        else if (n < 17) g.fillStyle = P.haze;
        else if (n < 20) g.fillStyle = P.waveFace;
        else continue;
        g.fillRect(x, y, 2, 2);
      }
    }

    // a section throwing foam down the line: get over it or around it
    if (this.sectionWarned) {
      const sx0 = Math.round(CX0 + (this.pos + 7) * PX);
      for (let x = sx0 - 26; x < sx0 + 26; x++) {
        if (x < 0 || x >= W) continue;
        const cy = crestAt(x);
        const reach = 1 - Math.abs(x - sx0) / 26;
        const depth = Math.round(reach * (26 + 10 * Math.sin(x * 0.31 + t * 4)));
        g.fillStyle = P.foam;
        for (let y = cy; y < cy + Math.max(4, depth); y++) {
          if (((x * 13 + (y + Math.floor(t * 12)) * 7) % 17) < 9) g.fillRect(x, y, 1, 1);
        }
      }
    }

    // the wake the board carves, fading out behind you
    if (this.wake && this.wake.length > 1) {
      for (let i2 = 0; i2 < this.wake.length; i2++) {
        const wpt = this.wake[i2];
        const wxp = Math.round(CX0 + wpt.p * PX);
        if (wxp < 0 || wxp >= W) continue;
        const cyW = crestAt(wxp);
        const wyp = Math.round(cyW + 4 + wpt.f * (faceBot - cyW - 6));
        const fade = i2 / this.wake.length;
        if ((i2 & 1) === 0 || fade > 0.5) {
          g.fillStyle = fade > 0.55 ? P.foam : P.haze;
          g.fillRect(wxp - 2, wyp - 1, 2, 2);
        }
      }
    }

    // the surfer on the face (and above the lip mid-snap)
    const cyS = crestAt(surferX);
    const boardY = Math.round(cyS + 4 + (this.faceY ?? 0.5) * (faceBot - cyS - 6));
    let sprite = "ride";
    let air = 0;
    let flipS = false;
    if (this.state === "wipeout") sprite = Math.floor(this.wipeT * 8) % 2 ? "wipe1" : "wipe2";
    else if (this.dropT > 0) sprite = "popup";
    else if (this.man) {
      const u = Math.min(1, (this.rideT - this.man.t0) / this.man.dur);
      sprite = this.man.type;
      if (this.man.type === "cutback") flipS = u > 0.22 && u < 0.78; // facing back through the turn
      if (this.man.type === "snap" && this.faceY < 0.25) air = 18;   // boosting over the lip
    }
    else if (this.rideT < (this.spriteUntil ?? 0)) sprite = this.spriteState || "ride";
    else sprite = this.barreled || this.v > 1.5 * this.field.crestSpeed(this.waveX) ? "crouch" : "ride";

    // the lip: a canopy over your head. It creeps in from the foam side as
    // you near the pocket and wraps into a full tube when you are barreled.
    const pocket = Math.max(0, 1 - (this.pos ?? 8) / 4.5);
    if (pocket > 0.25 && (this.state === "riding" || this.state === "scored")) {
      const wrap = Math.min(1, (pocket - 0.25) * 0.9 + (this.barreled ? 0.5 : 0));
      const bx = surferX + 6;
      const by2 = boardY + 6;
      const R2 = Math.round(40 + Hm * 18 + wrap * 12);
      const aEnd = Math.PI * 1.04; // buried into the foam wall
      const aStart = Math.PI * (1.04 - 0.85 * wrap);
      for (let ring = 0; ring < 4; ring++) {
        g.fillStyle = ring < 2 ? P.foam : ring === 2 ? P.haze : P.waveFace;
        const rr = R2 + ring * 3;
        for (let a = aStart; a <= aEnd; a += 0.02) {
          const lx = bx + Math.round(Math.cos(a) * rr);
          const ly = by2 - Math.round(Math.sin(a) * rr);
          if (ly > crestBase - 14) g.fillRect(lx, ly, 3, 3);
        }
      }
      // drips falling off the canopy
      g.fillStyle = P.foam;
      for (let i = 0; i < 3; i++) {
        const a2 = aStart + (aEnd - aStart) * (0.2 + i * 0.3);
        const lx = bx + Math.round(Math.cos(a2) * R2);
        const ly = by2 - Math.round(Math.sin(a2) * R2);
        const fall = (Math.floor(t * 30) + i * 9) % 22;
        g.fillRect(lx, ly + fall, 2, 3);
      }
    }

    // hard white wake right at the tail when you have speed
    if (this.state === "riding" && (this.v ?? 0) > 0.95 * this.field.crestSpeed(this.waveX)) {
      g.fillStyle = P.foam;
      for (let k4 = 0; k4 < 5; k4++) {
        g.fillRect(surferX - 34 - k4 * 5, boardY + 2 + ((k4 + Math.floor(t * 16)) % 3) - 1, 4, 2);
      }
    }
    drawSprite(g, sprite, surferX - 36, boardY - 40 - air, null, flipS, 3);

    // spray off the board
    while (this.sprayPending > 0) {
      this.sprayPending--;
      if (!this.rm) this.spray.push({
        x: surferX - 14 + Math.random() * 20, y: boardY - 2,
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
      drawText(g, inc ? `SET ${Math.max(0, Math.round(this.px - inc.x))}M OUT  SPACE TO GO` : "READ THE HORIZON  </> TO REPOSITION", 3, H - 10, P.foam, 1);
    }
    drawText(g, `BEST ${this.best ? this.best.toFixed(2) : "-.--"}  W${this.rides}`, W - 3 - textWidth(`BEST 00.00  W00`), H - 10, P.accent, 1);

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
