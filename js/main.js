// Boot: load the buoy data, build the break picker, wire the UI, start the game.

import { loadBuoys, ageString, mToFt, faceScale } from "./data.js";
import { componentsFromBins, WaveField } from "./wave.js";
import { Game } from "./game.js";
import { reducedMotion } from "./theme.js";
import { booth } from "./judge.js";
import { initOnGesture, toggleMute, isMuted, sfx } from "./audio.js";
import { startMenuScene, stopMenuScene, setMenuStatus } from "./menu-scene.js";

const $ = (s) => document.querySelector(s);
let game = null;
let data = null;
let picked = null;

function dirArrow(deg) {
  if (deg == null) return "";
  const arrows = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return arrows[Math.round(((deg % 360) / 45)) % 8];
}

function buildPicker() {
  const wrap = $("#breaks");
  wrap.innerHTML = "";
  data.stations.forEach((st, i) => {
    const b = document.createElement("button");
    b.className = "break-card";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", "false");
    b.innerHTML =
      `<div class="bname">${st.breakName.toUpperCase()}</div>` +
      `<div class="stat">BUOY ${st.id} · ${st.name.toUpperCase()}</div>` +
      `<div class="big">${mToFt(st.hs).toFixed(1)}FT @ ${st.tp.toFixed(0)}S ${dirArrow(st.peakDir)}</div>` +
      `<div class="stat">${faceScale(st.hs)} · ${ageString(st.obsTime)}</div>` +
      (st.met?.wtmp != null ? `<div class="stat">WATER ${st.met.wtmp.toFixed(0)}°C</div>` : "");
    b.addEventListener("click", () => {
      picked = st;
      wrap.querySelectorAll(".break-card").forEach((el) => el.setAttribute("aria-checked", "false"));
      b.setAttribute("aria-checked", "true");
      $("#paddleOut").disabled = false;
    });
    wrap.appendChild(b);
    if (data.stations.length === 1 && i === 0) b.click();
  });
}

function startGame() {
  if (!picked) return;
  stopMenuScene();
  initOnGesture();
  const seed = (Date.now() % 100000) | 1; // phases random but fixed per session
  const comps = componentsFromBins(picked.bins, picked.shoreNormal ?? 200, { seed });
  const field = new WaveField(comps);
  game?.stop();
  game = new Game($("#game"), field, picked, {
    live: data.live && picked.obsTime > 0,
    reducedMotion: reducedMotion(),
  });
  $("#start").hidden = true;
  $("#screen").classList.add("playing");
  game.start();
  window.__game = game; // console debugging hook
  sfx.setBell();
}

function backToMenu() {
  game?.stop();
  game = null;
  $("#start").hidden = false;
  $("#screen").classList.remove("playing");
  startMenuScene($("#game"));
}

function wireUi() {
  $("#paddleOut").addEventListener("click", startGame);
  $("#backBtn").addEventListener("click", backToMenu);

  const muteBtn = $("#mute");
  const paintMute = () => {
    muteBtn.textContent = isMuted() ? "MUTE" : "SND";
    muteBtn.classList.toggle("off", isMuted());
  };
  muteBtn.addEventListener("click", () => { toggleMute(); paintMute(); });
  paintMute();
  addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") { toggleMute(); paintMute(); }
    if (e.key === "Escape" && game) backToMenu();
  });

  // booth mode
  const status = $("#boothStatus");
  const paintBooth = () => {
    status.textContent = booth.enabled()
      ? "BOOTH ON: CLAUDE IS CALLING YOUR RIDES."
      : "BOOTH OFF: TEMPLATE COMMENTARY.";
  };
  $("#boothSave").addEventListener("click", () => {
    booth.setKey($("#boothKey").value.trim());
    $("#boothKey").value = "";
    paintBooth();
  });
  paintBooth();

  // touch controls feed the same input path as the keyboard
  document.querySelectorAll("#touch button").forEach((b) => {
    const k = b.dataset.k;
    const down = (e) => { e.preventDefault(); if (game) { game.keys[k] = true; game.press(k); } };
    const up = (e) => { e.preventDefault(); if (game) game.keys[k] = false; };
    b.addEventListener("pointerdown", down);
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
  });
}

(async function boot() {
  startMenuScene($("#game"));
  setMenuStatus("READING THE PACIFIC: NOAA BUOY NETWORK");
  const t0 = performance.now();
  data = await loadBuoys();
  // let the loading strip breathe even on a fast cache hit
  const wait = Math.max(0, 900 - (performance.now() - t0));
  await new Promise((r) => setTimeout(r, wait));
  setMenuStatus(null);
  buildPicker();
  wireUi();
  if (!data.live) {
    const note = document.createElement("p");
    note.className = "dim";
    note.textContent = "LIVE DATA UNAVAILABLE. RUNNING THE CANNED DEMO SWELL.";
    $("#breaks").after(note);
  }
})();
