# Dawn Patrol: Design (v1, GitHub Pages edition)

Date: 2026-08-26
Owner: Daniel Guzman
Deploy target: **GitHub Pages (public repo `Dawn-Patrol`), zero hosting cost.**

## What it is

A pixel-art, side-view surf timing game in the browser where the waves are
synthesized from live NOAA buoy directional wave spectra. Pick a real
California break; the sea state you surf is the sea state at that buoy right
now. After every ride a judge scores you 0-10 with WSL-style criteria and a
one-line broadcast call.

## Deltas from the original spec (forced by free static hosting)

The original plan assumed Vercel API routes. GitHub Pages serves static files
only, and NDBC does **not** send CORS headers (verified 2026-08-26), so:

1. **Data proxy → GitHub Actions cron.** A scheduled workflow (every 30 min)
   fetches `.data_spec`, `.swdir`, `.swr1`, `.txt`, `.spec` for each station,
   parses the latest observation, and commits a compact `data/buoys.json`.
   Pages redeploys automatically on commit. Buoys update ~half-hourly, so
   freshness is equivalent to the proxy design. The game also shows data age
   in the telemetry strip so staleness is honest.
2. **LLM judge → two modes.**
   - Default: a deterministic in-browser judge. Feature extraction from the
     ride trace (takeoff size, duration, sections, maneuvers, speed profile,
     finish) → weighted WSL-criteria score (commitment, difficulty,
     variety/combination, speed-power-flow) → commentary from a template bank
     in broadcast voice. No key, no server, works for everyone.
   - Optional: "booth mode": the player can paste their own Anthropic API key
     (stored in localStorage only, direct browser call with
     `anthropic-dangerous-direct-browser-access`). The LLM gets the ride trace
     plus the deterministic anchor score and writes the call. Off by default.
3. **WSL scraper + GBT calibration → deferred.** No server to run ONNX in and
   the scraper is a separate repo by design. The deterministic judge's scale
   is hand-calibrated to WSL score bands (2-4 completion, 5-6 solid with one
   good turn, 7-8 excellent combination, 9+ exceptional). GBT calibration can
   land later without changing the game's interface to the judge.

## Architecture (all static)

```
index.html            shell, break picker, canvas
css/style.css         palette, HUD, reduced-motion rules
js/data.js            load data/buoys.json (+ age display, demo fallback)
js/wave.js            spectral synthesis: bins -> components -> heightfield
                      (dispersion solve, shoaling, 0.78*depth breaking)
js/game.js            fixed-timestep loop, surfer states, ride trace logging
js/judge.js           deterministic judge + optional Claude booth mode
js/hud.js             telemetry strip, score roll, commentary ticker
js/main.js            wiring
data/buoys.json       latest parsed spectra (committed by the cron workflow)
scripts/fetch-buoys.mjs   Node, no deps; also runnable locally
scripts/test-wave.mjs     synthesis invariant tests (Hs reconstruction etc.)
.github/workflows/buoys.yml   cron */30, commits data, keeps Pages fresh
```

## Breaks and stations (verified publishing spectra)

| Break | NDBC station | Notes |
|---|---|---|
| Lower Trestles | 46253 (San Pedro South) | nearest full-spectra buoy |
| Blacks | 46225 (Torrey Pines Outer) | |
| Huntington | 46222 (San Pedro) | |

## Wave synthesis

`elevation(x,t) = Σ aᵢ·gᵢ(x)·sin(∫kᵢdx + 2πfᵢt + φᵢ)` with
`aᵢ = √(2·S(fᵢ)·df)`, k from the full dispersion relation ω² = gk·tanh(kh)
solved per depth node, shoaling gain from energy-flux conservation
(√(Cg₀/Cg)), directional weighting by cos(θᵢ − shore normal) so
offshore-traveling energy is discarded, phases random but fixed per session.
Break when local wave height exceeds 0.78·depth; broken crests become
whitewater sections in the game.

## Game scope (tight, per spec)

One break at a time, side view, one board. Paddle, time the pop-up, pump for
speed, hit sections (snap at the lip, cutback on the face, floater over foam),
kick out or get clipped. ~15 s rides, session high score. No 3D, no career
mode. Pixel look: 16-bit, pre-dawn palette, surfer always silhouette black,
internal low-res canvas scaled with `image-rendering: pixelated`, Silkscreen
HUD + mono telemetry, ≤4% scanline, `prefers-reduced-motion` kills particles
and the digit roll but keeps the wave.

## Known constraints (documented, accepted)

- GitHub disables cron workflows after ~60 days of repo inactivity; README
  documents the one-click re-enable, and the game falls back to the last
  committed spectrum (age shown) or a canned demo spectrum if data is absent.
- Scheduled workflows can be delayed minutes at busy times; harmless here.
