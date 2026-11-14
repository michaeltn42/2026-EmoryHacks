# After Visit: home PT sessions

**The real session page is `session.html`** (open http://localhost:8000/session.html). It runs the therapist's plan: side arm raise (precise mode, shows degrees), then mini squat (simple mode, no numbers). Each exercise records on its own, reps are scored and spoken, and the whole session is saved on the device for the therapist.

`index.html` is still the older one-exercise prototype described below. It becomes the patient dashboard in a later step.

**Or do it on a FaceTime call.** Patients can pick the second path: an AI coach that calls them on FaceTime (through Chert), talks them through the same plan, watches the camera, counts and scores reps out loud with the same tracker, and saves the session in the same format. See [coach-agent/README.md](coach-agent/README.md). `coach-test.html` is its test page: "Have my coach call my iPhone", or talk to the coach in the browser.

## Session page (`session.html`)

1. **Today's plan:** the exercises, reps and targets from the therapist, a safety note, camera tips, and a "Talk me through it" switch.
2. **Each exercise:** checks you're in the picture, counts 3-2-1, and starts recording on its own. Live skeleton (the measured joint turns salmon when your form slips), big angle and rep numbers, a bar that turns peach at the target, and a coach line. "Skip this one" and "End" are always there.
3. **Between exercises:** how each rep went (Good / Fair / Poor, with icons and words, not color alone) and what's next.
4. **Done:** a summary, then everything is saved on the phone: reps, scores, ~15 tracked frames a second, and one video per exercise.

## Prototype (`index.html`)

Pick an exercise, prop your phone or laptop camera up, and press **Start session**:

1. **Setup:** the screen says how to stand ("Face the camera" / "Sit side-on") and checks that you're in the frame.
2. **Recording starts automatically** after you've been in frame for 1.5 seconds, with a 3-2-1 countdown (or tap **Start now**).
3. **Live tracking:** MediaPipe Pose tracks 33 body points in the browser and draws your skeleton. The measured joint is highlighted with its angle, plus a bar showing how close you are to the target.
4. **Every rep is scored** good / fair / poor on range (did you reach the target angle?), hold time (for hold exercises), speed, and form (e.g. elbow straight, no leaning). Feedback is spoken: "2. Good rep." / "3. Raise your arm a little higher."
5. **When you finish:** a pain check (0–10 plus a note, typed or dictated), your rep table, and a **replay of the video with the skeleton redrawn from the saved tracking data**, next to an angle-over-time chart. Tap a rep or the chart to jump the video. Download the video and the tracking data (JSON).

Exercises: **side arm raise** (target 140°), **overhead reach and hold** (160°, hold 3 s), **seated knee extension** (165°, hold 2 s), **mini squat** (110°). You can change the target angle and reps before starting.

**Side = Auto:** both sides are tracked, and the app locks onto whichever side completes the first rep.

No backend, no install, nothing leaves the device unless you download it.

## Run it

The camera only works on `http://localhost` or an `https://` address, and ES modules don't load from `file://`, so serve the folder:

```cmd
cd after-visit
python -m http.server 8000
```

Open **http://localhost:8000** in Chrome or Edge. The first run downloads the pose model (~6 MB) from Google's CDN, so it needs internet.

**On an iPhone**, you need an https link. In a second terminal:

```cmd
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8000
```

Then open the printed `https://….trycloudflare.com` link in Safari.

## Tips

- Use good light and stand back so the whole limb is in view. Face the camera for arm exercises, and stand or sit side-on for knee exercises.
- Reps only start counting once you're in the starting position (arm down / knee bent / standing tall).

## Files

| File | What it does |
|---|---|
| `session.html`, `session.css`, `session.js` | the real session: plan → each exercise → between → done (saved) |
| `js/exerciseTracker.js` | runs one exercise: landmarks in, angle + rep events + logged frames out; auto-picks the moving side |
| `index.html`, `style.css`, `app.js` | the older one-exercise prototype: pick → live session → results |
| `js/exercises.js` | exercise definitions: which 3 body points form the angle, start zone, target, hold time, form rules. Add exercises here |
| `js/repCounter.js` | turns the angle stream into reps and scores each one |
| `js/analysis.js`, `js/geometry.js` | joint angles, body lean, side visibility |
| `js/tracker.js` | camera, MediaPipe loading, video recording |
| `js/draw.js` | skeleton and angle overlay |
| `js/review.js` | angle chart and finding the tracking frame for a video time |
| `js/plan.js` | the therapist's home plan: which exercises, reps, target angle, precise or simple mode |
| `js/sessionLog.js` | records a session: landmark frames, reps, scores, pain check, flagged reps, "needs attention" |
| `js/store.js` | saves sessions on the device (IndexedDB): records, frames and videos. Falls back to memory |
| `tests/` | `npm install` once, then `npm test` runs the unit tests. `fakePerson.mjs` is a synthetic body doing good and short reps |
| `coach-agent/` | the FaceTime coach (Chert + LiveKit + Gemini Live + MediaPipe); its own README |
| `coach-test.html` | test page for the coach, served by `coach-agent/call-server.mjs` |

## Saved data

Each session is saved on the device in three parts, so the session list stays fast:

- **Session record:** the plan exercises, each one's reps and scores, the pain check, plus derived `totals`, `flagged` (every rep that wasn't good, poor first) and `attention` (plain-language reasons the therapist should look, like "Pain 6 out of 10").
- **Frames:** per exercise, about 15 a second: `{ t, side, a, lm, c? }`. `t` is ms into that exercise's video, `a` is the measured angle, `lm` is the 33 landmarks as `[x, y, z, visibility]`, and `c` lists any form rules broken in that frame.
- **Blobs:** one video per exercise, plus an optional voice note.

`store().exportSession(id)` gives the record and frames as one JSON object (about 450 KB per minute of exercise), ready to upload to the backend later. `pushToServer` in `store.js` is a placeholder for that.

## Next steps (from the plan)

Dashboard with the 3 cards (including the choice between recording and a FaceTime coach session), saving sessions to the backend, the therapist review page, and progress across weeks. For the FaceTime coach: getting caller audio working on the Chert line (see its Known issues).


### Training voice

Browser training sessions prefer an English voice marked Natural, Neural, Premium, or Enhanced, then other known English voices and the available English fallback. Voices load asynchronously on some browsers; the coach refreshes its voice choice as they become available. Speech uses a relaxed pace and varied encouragement. Rep feedback finishes its sentence before the latest cue plays, while countdowns and session transitions can interrupt immediately. The existing spoken-feedback switch still turns coaching off. No external speech service or API key is required. Actual sound quality depends on the voices exposed by your browser and operating system; a neural-quality voice cannot be guaranteed on every device. This change applies to browser sessions, not the separate FaceTime agent.
