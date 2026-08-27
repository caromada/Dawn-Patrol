# Dawn Patrol 🌊

![Dawn Patrol demo: menu at a palm-lined beach, a ride on live buoy waves, and a judged score](docs/demo.gif)

**[Surf it here](https://caromada.github.io/Dawn-Patrol/)**

A retro pixel-art surf game where the ocean is real. You drop in on the peak and ride down the line, California Games style, with the curl chasing you toward the shoulder. Pick a real California break and the waves you paddle into are synthesized from the live directional wave spectrum of the nearest NOAA buoy, reconstructed through wave superposition with real oceanography: the full dispersion relation, energy-flux shoaling, and breaking at 0.78 times the water depth. Flat Tuesday at Lowers means a flat, frustrating game. Overhead Friday means the game is pumping. After every ride a judge scores you 0 to 10 on WSL criteria and the broadcast booth prints a one-line call. Built with plain HTML, CSS and JavaScript: no frameworks, no build step, no image or audio files, and it costs nothing to host.

## How to play

1. Pick a break: Lower Trestles down south, or head north for Steamer Lane, Mavericks, and Ocean Beach. The cards show the actual conditions at each buoy right now.
2. **PADDLE OUT** and you are sitting in the lineup, first person, watching the synthesized sets roll in at you from the horizon. **&larr; &rarr;** repositions you; the real lulls and sets from the buoy data are something you watch coming.
3. When your wave stands up in front of you and the marker flashes **PADDLE!**, hit **SPACE** to drop in. Late is better. Hold an arrow at takeoff to go left or right.
4. The camera cuts onto the wave, straight from the California Games playbook: the face fills the screen, whitewater sweeps in diagonally from the lip behind you, and the closer the curl gets the further the foam reaches overhead. Hold **&darr;** to race down the face for speed and **&uarr;** to climb back toward the lip: carving rail to rail is the pump. **X** snaps off the lip, and right at the lip with big speed it launches an air. **C** wraps a cutback from the shoulder, **F** floats over a breaking section, **SPACE** kicks out clean.
5. Stall mid-face in the pocket of a pitching wave for barrel time. Get swallowed by the foam ball and the judges will remember it.
6. Scores work like a WSL heat: your best two waves count as the heat total, the panel tells you what the next wave NEEDS, and your best heat is saved per break. The SHARE button sends your total and today's real conditions to whoever needs to know.
7. **M** toggles sound, **ESC** returns to the lineup select.

## The ocean is not decoration

- The telemetry strip along the top is live instrument data: buoy ID, significant wave height, peak period and direction, observation time, and data age.
- Every 30 minutes a GitHub Action fetches each station's raw NDBC spectral files (`.data_spec`, `.swdir`, `.swr1`, plus the met file), stores them as fetched, parses the newest observation, and commits a compact JSON. GitHub Pages redeploys on the commit, which is the same cadence the buoys report at.
- The synthesis takes the ~64 frequency bins of energy density S(f), keeps the components actually aimed at the beach (directional projection against the shore normal, softened by the r1 spread parameter), converts each bin to a sinusoid with amplitude sqrt(2 S df), and marches them over a beach profile. Wave number comes from Newton iterations on the full dispersion relation, shoaling gain from group-velocity flux conservation, and any crest taller than 0.78 times the local depth breaks into a whitewater bore that the game logic and renderer both consume.
- A 16 second groundswell rolls through as long-period corduroy with real lulls between sets. Short-period windswell shows up as chop. Combo swells produce the peaky crossed-up lineup that combo swells actually produce, because the interference is computed, not designed.

## The judge

Every ride logs a trace: takeoff height against the day's significant height, late-drop timing, maneuvers with quality grades, sections made, barrel time, speed profile, and how the ride ended. A deterministic judge scores it on WSL-style criteria (commitment and difficulty, combination, variety, speed-power-flow) with diminishing returns for repeating the same move, and a template bank in broadcast voice prints the call.

**AI booth mode**: paste your own Anthropic API key on the menu and Claude writes the commentary live instead, plus a coaching tip for your next wave, anchored to the deterministic score. One structured-output call per ride, validated against a JSON schema, retried once, cached by ride-trace hash so nothing is paid for twice. The key lives only in your browser's localStorage and is sent only to api.anthropic.com.

## Everything is drawn and synthesized in code

- The surfer is a full character drawn as color-legend grids in `js/sprites.js`: blond hair, tan, gold boardshorts, a 7 foot coral pin-tail gun, and an auto-generated 1px contour so he pops off any water. Ten poses from paddle to poised snap to rag-doll wipeout.
- The score digits, telemetry strip, and every in-game label use a hand-drawn 5x7 bitmap font in `js/hud.js`. No font files, no web fonts.
- The ride view was rebuilt after studying frame captures of the 1987 original: the face fills the screen under a layered crest line, drifting speckle up high, rows of comb ripples below, all streaming past at your actual board speed. The whitewater sweeps in diagonally in chunky three-tone blocks, your board carves a fading wake, and near the pocket the lip arcs right over your head. The lineup is first person, sets rolling in at you off the horizon. The title beach, its swaying palms, and the marquee logo are drawn procedurally on the same canvas every frame.
- All audio is Web Audio synthesis: the ocean is filtered looping noise that swells when waves break near you, and every cue from the pop-up blip to the score fanfare is an oscillator envelope.
- Score digits roll like a mechanical counter, commentary types out at 30 characters per second, and `prefers-reduced-motion` kills the particles and the digit roll while keeping the wave, because the wave is content.

## Architecture

```
index.html               shell, break picker, canvas
css/style.css            theme tokens, HUD chrome, reduced-motion rules
js/theme.js              the palette and motion constants, one source of truth
js/wave.js               spectral synthesis (pure, unit tested)
js/game.js               fixed-timestep loop, surfer state machine, renderer
js/judge.js              deterministic WSL scorer + commentary bank (pure, tested)
js/llm.js                the one structured LLM call, model names, caching
js/menu-scene.js         procedural beach with palms for the landing screen
js/sprites.js, hud.js    character-grid sprites, 5x7 bitmap font
js/audio.js, data.js     Web Audio chiptune, buoy JSON loader with demo fallback
data/buoys.json          latest parsed spectra, committed by the cron workflow
data/raw/                the NDBC files exactly as fetched, for reprocessing
scripts/fetch-buoys.mjs  parser, no dependencies, timeout and retry on every fetch
scripts/test-*.mjs       synthesis and judging invariants, run in CI on every refresh
.github/workflows/       the 30 minute buoy cron
```

## What was hard

- **The phase sign.** A surface built as sin(kx + wt) propagates toward deep water, and for a while the game's waves rolled politely away from the beach while the crest tracker chased them backward. One minus sign turned it into an ocean.
- **Crest tracking through interference.** With 20+ components superposed, local maxima appear, merge, and vanish frame to frame. Tracking "the wave you caught" by nearest-crest kept re-locking onto the next set wave outside, so rides never ended. The fix was a forward-biased search window plus a grace period where you coast on the bore if your crest momentarily dissolves into the pattern.
- **Making a spectrum feel like a surf spot.** Hs from the reconstruction had to match the buoy's own reported WVHT (it does, within a few percent, checked in CI against the live spectrum), but game feel needed exaggerated vertical scale, a hand-tuned pump-versus-trim speed loop, and a break-depth estimate so the lineup sits where the waves actually stand up.
- **Free hosting with live data.** NDBC sends no CORS headers, and GitHub Pages has no server, so the data plane became a cron workflow that commits the parsed spectrum and lets Pages redeploy. The game shows the data age in the telemetry strip so the freshness is honest, and falls back to a canned groundswell if the file is missing.
- **Dithering without moire.** Linear-modulo dithering for the sun glow produced diagonal rays across the sky. Classic 4x4 Bayer ordered dithering is the actual 16-bit technique for a reason.
- **Copying the masters, literally.** The first three attempts at the ride view (a side cross-section, then a wave wall seen from the beach) looked wrong in ways that were hard to name. Frame-stepping through a capture of the real California Games surfing event gave the answer: the camera belongs ON the wave, the face is the whole screen, and the broken water sweeps in diagonally from the lip. Copying that composition fixed in an afternoon what tweaking could not.

## Run it locally

```
python3 scripts/dev-server.py 8643
```

Open http://localhost:8643. To pull fresh buoy data: `node scripts/fetch-buoys.mjs`, and run the tests with `node scripts/test-wave.mjs` and `node scripts/test-judge.mjs`. No installs, no build.

If the scheduled workflow ever shows as disabled (GitHub pauses cron jobs after 60 days without repo activity), one click on **Actions &rarr; Refresh buoy data &rarr; Enable workflow** brings the ocean back.

Data: NOAA National Data Buoy Center realtime2 feeds. Not affiliated with the WSL. Surf reports are for surfing; this is for fun.
