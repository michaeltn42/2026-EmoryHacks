import { createCoachVoice, goodRepMessage } from './js/coachVoice.js';
// Bare-bones PT session: pick an exercise -> camera + pose tracking -> auto-start recording when you're
// in frame -> skeleton, live angle, target, rep scoring with spoken feedback -> pain check -> playback.
// Plain ES modules, no build step. Serve this folder over http://localhost or https (camera requirement).
import { EXERCISES as LIBRARY } from './js/exercises.js';
import { planExercises } from './js/plan.js';
import { readData, writeData, recordCompletion } from './js/dashboardData.js';
const EXERCISES = { ...LIBRARY, ...Object.fromEntries(planExercises().map(e => [e.id, e])) };
const sessionQueue = (new URLSearchParams(location.search).get('exercises') || '').split(',').filter(id => EXERCISES[id]);
let queuePosition = 0;
import { analyzeFrame, chooseSide } from './js/analysis.js';
import { RepCounter } from './js/repCounter.js';
import { makeSmoother, round } from './js/geometry.js';
import { drawPose, pack, unpack } from './js/draw.js';
import { frameAt, drawChart } from './js/review.js';
import { loadPose, openCamera, stopStream, Recorder, startPoseLoop } from './js/tracker.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${id}`)); scrollTo(0, 0); }
function toast(msg, ms = 3000) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), ms); }

// ---------------------------------------------------------------- voice
let voiceOn = true;
const coachVoice = createCoachVoice();
function speak(text, options) {
  if (!voiceOn) { coachVoice.stop(); return; }
  coachVoice.speak(text, options);
}
addEventListener('pagehide', () => coachVoice.stop());
$('#set-voice').addEventListener('change', e => {
  voiceOn = e.target.checked;
  if (!voiceOn) coachVoice.stop();
});
const Recog = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!Recog) $('#note-mic').hidden = true;
$('#note-mic').addEventListener('click', () => {
  const r = new Recog(); r.lang = navigator.language || 'en-US';
  $('#note-mic').textContent = '…';
  r.onresult = (e) => { $('#note').value = ($('#note').value + ' ' + e.results[0][0].transcript).trim(); };
  r.onend = r.onerror = () => { $('#note-mic').textContent = '🎙️'; };
  r.start();
});

// ---------------------------------------------------------------- 1. pick an exercise
let pickedId = sessionQueue[0] || 'shoulder-abduction';
function renderPicker() {
  const ul = $('#exercise-list'); ul.innerHTML = '';
  for (const [id, ex] of Object.entries(EXERCISES)) {
    if (sessionQueue.length && id !== sessionQueue[queuePosition]) continue;
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" class="ex ${id === pickedId ? 'selected' : ''}" aria-pressed="${id === pickedId}">
      <span class="icon" aria-hidden="true">${ex.icon}</span><b>${esc(ex.name)}</b>
      <small>${ex.reps} reps · target ${ex.target}°${ex.holdMs ? ` · hold ${ex.holdMs / 1000}s` : ''}</small><small>${esc(ex.view)}</small></button>`;
    li.firstElementChild.onclick = () => { pickedId = id; renderPicker(); };
    ul.appendChild(li);
  }
  const ex = EXERCISES[pickedId];
  $('#set-title').textContent = ex.name;
  $('#set-note').textContent = ex.note;
  $('#set-target').value = ex.target;
  $('#set-reps').value = ex.reps;
  $('#set-side').value = ex.side || 'auto';
}
renderPicker();

// ---------------------------------------------------------------- 2. live session
const video = $('#cam'), overlay = $('#overlay'), stage = $('#stage');
let S = null;   // the running session

function fitStage() {
  const wrap = stage.parentElement, vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const k = Math.min(wrap.clientWidth / vw, wrap.clientHeight / vh);
  stage.style.aspectRatio = 'auto';
  stage.style.width = `${Math.floor(vw * k)}px`; stage.style.height = `${Math.floor(vh * k)}px`;
  overlay.width = vw; overlay.height = vh;
}
addEventListener('resize', () => S?.stream && fitStage());

function setCoach(text, kind = '') { const el = $('#coach'); el.textContent = text; el.className = `coach ${kind}`; }

$('#settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  voiceOn = $('#set-voice').checked;
  speak("Let’s get comfortable and take this one step at a time.", { interrupt: true });          // iOS only allows speech that starts inside a tap
  const base = EXERCISES[pickedId];
  const target = Number($('#set-target').value) || base.target;
  const ex = { ...base, id: pickedId, target };
  S = {
    ex, reps: Math.max(1, Number($('#set-reps').value) || base.reps), sideSetting: $('#set-side').value,
    frames: [], started: false, finished: false, inFrameSince: null, countdown: null, readySaid: false,
  };
  // Auto side: track both sides and lock onto whichever completes the first rep (both arms are visible
  // when you face the camera, so visibility alone can't tell which one is exercising).
  const sides = S.sideSetting === 'auto' ? ['left', 'right'] : [S.sideSetting];
  S.locked = sides.length === 1;
  S.side = S.locked ? sides[0] : null;
  S.counters = Object.fromEntries(sides.map((sd) => [sd, new RepCounter(ex, { targetAngle: target })]));
  S.smoothers = Object.fromEntries(sides.map((sd) => [sd, makeSmoother(0.4)]));
  S.counter = S.locked ? S.counters[S.side] : null;
  $('#sess-title').textContent = ex.mode === 'simple' ? `${ex.name} — ${S.reps} reps` : `${ex.name} — ${S.reps} reps — target ${target}°`;
  $('#setup-text').textContent = ex.setup;
  $('#frame-check').textContent = 'Looking for you…'; $('#frame-check').className = 'frame-check';
  $('#setup').hidden = false;
  $('#m-target').textContent = `${target}°`; $('#m-reps').textContent = `0/${S.reps}`; $('#m-good').textContent = '0'; $('#m-angle').textContent = '–';
  const lo = Math.min(ex.rest, target) - 10, hi = Math.max(ex.rest, target) + 10;
  S.pct = (a) => Math.max(0, Math.min(100, ((ex.direction === 'increase' ? a - lo : hi - a) / (hi - lo)) * 100));
  $('#bar-target').style.left = `${S.pct(target)}%`; $('#bar-fill').style.width = '0';
  document.querySelectorAll('.metrics > div').forEach((el,i) => { if (i < 2) el.hidden = ex.mode === 'simple'; });
  show('session');
  setCoach('Opening the camera…');
  try {
    S.stream = await openCamera(video);
    fitStage();
    try { S.wake = await navigator.wakeLock?.request('screen'); } catch {}
  } catch (err) {
    alert("Couldn't open the camera. Allow camera access, and open the page from http://localhost or an https:// link.\n\n" + err.message);
    return backToPicker();
  }
  setCoach('Loading motion tracking…');
  try {
    const landmarker = await loadPose();
    S.stopLoop = startPoseLoop(video, landmarker, onPose);
    setCoach(ex.view);
    speak(`${ex.view}. Get your whole ${ex.joint.includes('knee') ? 'leg' : 'upper body'} in the frame.`);
  } catch (err) {
    console.error(err);
    setCoach('Motion tracking could not load. Check the internet connection and try again.', 'warn');
  }
});

function onPose(res, now) {
  if (!S || S.finished) return;
  const lms = res.landmarks?.[0];
  if (!lms) {
    drawPose(overlay, null);
    if (!S.started) inFrame(false, 'Step into the camera view');
    return;
  }
  const ex = S.ex, W = video.videoWidth, H = video.videoHeight;
  const per = {};
  for (const sd of Object.keys(S.counters)) {
    const fr = analyzeFrame(ex, sd, lms, W, H);
    per[sd] = { fr, angle: S.smoothers[sd].next(fr.angle) };
  }
  if (!S.locked) {   // show the side that is moving most right now
    const travel = (sd) => (per[sd].fr.visible && Number.isFinite(per[sd].angle) ? Math.abs(per[sd].angle - ex.rest) : -1);
    const l = travel('left'), r = travel('right');
    S.side = l > r + 8 ? 'left' : r > l + 8 ? 'right' : (S.side || chooseSide(ex, lms));
  }
  const { fr, angle } = per[S.side];
  const counter = S.counters[S.side];
  const active = counter.state === 'active';
  const broken = active ? ex.checks.find((c) => fr.checks[c.id]?.violated) : null;

  drawPose(overlay, lms, { highlight: { side: S.side, joint: ex.joint }, angle: ex.mode === 'simple' ? null : angle, mirror: true, status: broken ? 'warn' : 'ok' });
  if (Number.isFinite(angle)) {
    $('#m-angle').textContent = `${Math.round(angle)}°`;
    $('#bar-fill').style.width = `${S.pct(angle)}%`;
    $('#bar-fill').classList.toggle('hit', counter.beyond(angle, ex.target));
  }

  if (!S.started) {
    const ok = fr.visible;
    inFrame(ok, ok ? (S.locked ? `✓ We can see your ${S.side} side` : '✓ We can see you') : 'Move so your whole body is in the frame');
    return;
  }

  const t = now - S.t0;
  if (t - (S.frames.at(-1)?.t ?? -1e9) >= 66) S.frames.push({ t: Math.round(t), side: S.side, a: round(angle, 1), lm: pack(lms) });   // ~15 per second

  if (broken) setCoach(broken.label, 'warn');
  else if (active && ex.holdMs && counter.beyond(angle, ex.target)) {
    setCoach(`Hold… ${(Math.min(counter.current.heldMs, ex.holdMs) / 1000).toFixed(1)} / ${ex.holdMs / 1000}s`, 'good');
  }

  let ev = null;
  for (const [sd, c] of Object.entries(S.counters)) {
    const e = c.update({ t, angle: per[sd].angle, visible: per[sd].fr.visible, checks: per[sd].fr.checks });
    if (e?.type === 'rep' && !S.locked) {          // first full rep decides the side
      S.locked = true; S.side = sd; S.counter = c; S.counters = { [sd]: c };
      return handleEvent(e);
    }
    if (sd === S.side) ev = e;
  }
  if (ev) handleEvent(ev);
}

function handleEvent(ev) {
  if (ev.type === 'ready' && !S.readySaid) { S.readySaid = true; setCoach('Go! Start your first rep.', 'good'); speak('Whenever you’re ready.', { interrupt: true }); }
  if (ev.type !== 'rep') return;
  const r = ev.rep, c = S.counter, n = c.reps.length;
  $('#m-reps').textContent = `${n}/${S.reps}`;
  $('#m-good').textContent = c.reps.filter((x) => x.quality === 'good').length;
  if (r.quality === 'good') { setCoach(`Rep ${n}: good! ${r.peakAngle}°`, 'good'); speak(goodRepMessage(n)); }
  else { setCoach(`Rep ${n}: ${r.issues[0]} (${r.peakAngle}°)`, 'warn'); speak(`${n}. ${r.issues[0]}.`); }
  if (n >= S.reps) setTimeout(finish, 1200);
}

// In frame for 1.5 s -> 3-2-1 countdown -> recording starts on its own.
function inFrame(ok, text) {
  const el = $('#frame-check');
  el.textContent = text; el.className = `frame-check ${ok ? 'ok' : ''}`;
  if (!ok) {
    S.inFrameSince = null;
    if (S.countdown) { clearInterval(S.countdown); S.countdown = null; $('#countdown').hidden = true; }
    return;
  }
  S.inFrameSince ??= performance.now();
  if (!S.countdown && performance.now() - S.inFrameSince > 1500) {
    let n = 3;
    $('#countdown').textContent = n; $('#countdown').hidden = false; speak('3', { interrupt: true });
    S.countdown = setInterval(() => {
      n -= 1;
      if (n > 0) { $('#countdown').textContent = n; speak(String(n), { interrupt: true }); }
      else { clearInterval(S.countdown); S.countdown = null; $('#countdown').hidden = true; startRecording(); }
    }, 1000);
  }
}
$('#start-now').addEventListener('click', () => startRecording());

function startRecording() {
  if (!S || S.started) return;
  clearInterval(S.countdown); $('#countdown').hidden = true;
  S.recorder = new Recorder(S.stream);
  S.recorder.start();
  S.t0 = performance.now();
  S.started = true;
  $('#setup').hidden = true;
  $('#rec-dot').classList.add('on');
  S.timer = setInterval(() => ($('#rec-time').textContent = mmss(performance.now() - S.t0)), 500);
  setCoach('Recording. Get into the starting position.');
  speak(S.ex.mode === 'simple' ? `Let’s do ${S.reps} reps, nice and easy.` : `Let’s do ${S.reps} reps. Aim for ${S.ex.target} degrees, and take your time.`, { interrupt: true });
}

$('#end-btn').addEventListener('click', () => (S?.started ? finish() : backToPicker()));

function stopEverything() {
  coachVoice.stop();
  S.finished = true;
  S.stopLoop?.(); clearInterval(S.timer); clearInterval(S.countdown);
  stopStream(S.stream); S.wake?.release?.();
  $('#rec-dot').classList.remove('on'); $('#rec-time').textContent = '00:00'; $('#countdown').hidden = true;
}
function backToPicker() { if (S) stopEverything(); S = null; show('pick'); }

// ---------------------------------------------------------------- 3. results
let R = null;   // finished session data

async function finish() {
  if (!S || S.finished || !S.started) return;
  const durationMs = Math.round(performance.now() - S.t0);
  const blob = await S.recorder.stop();
  stopEverything();
  speak('You’re all done. Take a moment to rest. How much pain did you feel?', { interrupt: true });
  if (!S.counter) { S.counter = S.counters[S.side] || Object.values(S.counters)[0]; }
  const ex = S.ex, summary = S.counter.summary();
  R = {
    blob,
    data: {
      version: 1, recorded_at: new Date().toISOString(), exercise_id: ex.id, exercise: ex.name, side: S.side,
      joint: ex.joint, direction: ex.direction, rest: ex.rest, target_angle: ex.target, hold_ms: ex.holdMs,
      reps_target: S.reps, duration_ms: durationMs, summary, reps: S.counter.reps,
      pain: null, note: '',
      video_mime: blob?.type || null, video_size: [video.videoWidth, video.videoHeight],
      landmark_format: '[x, y, z, visibility]; x/y normalized 0-1 image coords (unmirrored); 33 MediaPipe Pose points',
      frames: S.frames,
    },
  };
  renderResults();
  $('#next-exercise').hidden = !sessionQueue.length;
  $('#next-exercise').textContent = queuePosition + 1 < sessionQueue.length ? 'Next exercise' : 'Back to dashboard';
}

function renderResults() {
  const d = R.data, s = d.summary;
  $('#res-title').textContent = d.exercise;
  $('#res-sub').textContent = `${d.side} side · target ${d.target_angle}° · ${mmss(d.duration_ms)}`;
  const stat = (k, v) => `<div class="stat"><small>${k}</small><b>${v ?? '–'}</b></div>`;
  $('#stats').innerHTML = stat('Good reps', `${s.goodReps}/${s.totalReps}`) + stat('Quality', `${s.qualityPct}%`) +
    stat('Best angle', s.bestPeakAngle != null ? `${s.bestPeakAngle}°` : null) + stat('Target', `${d.target_angle}°`) +
    stat('Avg rep', s.avgRepMs ? `${(s.avgRepMs / 1000).toFixed(1)}s` : null);
  $('#rep-rows').innerHTML = d.reps.map((r) => `<tr data-t="${r.startMs}"><td>${r.n}</td><td>${r.peakAngle}°</td><td>${mmss(r.startMs)}</td>
    <td class="q-${r.quality}">${r.quality}</td><td>${esc(r.issues.join('; ') || (d.hold_ms ? `held ${(r.heldMs / 1000).toFixed(1)}s` : ''))}</td></tr>`).join('')
    || '<tr><td colspan="5">No reps counted.</td></tr>';
  document.querySelectorAll('#rep-rows tr[data-t]').forEach((tr) => (tr.onclick = () => { rv.currentTime = Math.max(0, tr.dataset.t / 1000 - 0.3); rv.play(); }));
  $('#pain').value = 0; $('#pain-out').textContent = '0'; $('#note').value = ''; $('#pain-saved').hidden = true;

  const hasVideo = !!(R.blob && R.blob.size);
  $('#rv-stage').hidden = !hasVideo; $('#dl-video').hidden = !hasVideo;
  if (hasVideo) {
    rv.src = URL.createObjectURL(R.blob);
    rv.onloadedmetadata = () => {
      $('#rv-stage').style.aspectRatio = `${rv.videoWidth} / ${rv.videoHeight}`;
      rvOverlay.width = rv.videoWidth; rvOverlay.height = rv.videoHeight;
      if (rv.duration === Infinity) {   // Chrome's recorded webm has no duration until you seek
        rv.currentTime = 1e101;
        rv.addEventListener('timeupdate', () => { rv.currentTime = 0; }, { once: true });
      }
      drawReviewFrame();
    };
  }
  show('results');
  requestAnimationFrame(() => redrawChart(null));
}

const rv = $('#rv-video'), rvOverlay = $('#rv-overlay');
let toTime = null;
function redrawChart(playheadMs) {
  if (!R || !R.data.frames.some((f) => Number.isFinite(f.a))) { $('#chart').hidden = true; return; }
  $('#chart').hidden = false;
  toTime = drawChart($('#chart'), { frames: R.data.frames, reps: R.data.reps, target: R.data.target_angle,
    rest: R.data.rest, durationMs: R.data.duration_ms, playheadMs });
}
function drawReviewFrame() {
  if (!R) return;
  const f = frameAt(R.data.frames, rv.currentTime * 1000);
  drawPose(rvOverlay, f ? unpack(f.lm) : null, { highlight: { side: R.data.side, joint: R.data.joint }, angle: f?.a, mirror: false });
  redrawChart(rv.currentTime * 1000);
}
rv.addEventListener('seeked', drawReviewFrame);
rv.addEventListener('play', () => { const loop = () => { drawReviewFrame(); if (!rv.paused) requestAnimationFrame(loop); }; loop(); });
$('#chart').addEventListener('click', (e) => { if (toTime && rv.src) rv.currentTime = toTime(e.offsetX) / 1000; });
addEventListener('resize', () => R && $('#screen-results').classList.contains('active') && redrawChart(rv.currentTime * 1000));

$('#pain').addEventListener('input', (e) => ($('#pain-out').textContent = e.target.value));
$('#pain-form').addEventListener('submit', (e) => {
  e.preventDefault();
  R.data.pain = Number($('#pain').value);
  R.data.note = $('#note').value.trim();
  $('#pain-saved').hidden = false;
  try {
    writeData(recordCompletion(readData(), R.data));
    toast(R.data.summary.totalReps >= R.data.reps_target ? 'Pain check saved for this session. Exercise completion saved to your dashboard.' : 'Pain check saved for this session. Finish the prescribed reps to mark this exercise done.');
  } catch { toast('Device storage is unavailable. Download the tracking data to keep your session.'); }
});

function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => R.data.recorded_at.slice(0, 16).replace(/[:T]/g, '-');
$('#dl-video').addEventListener('click', () => download(R.blob, `${R.data.exercise_id}-${stamp()}.${R.blob.type.includes('mp4') ? 'mp4' : 'webm'}`));
$('#dl-data').addEventListener('click', () => download(new Blob([JSON.stringify(R.data)], { type: 'application/json' }), `${R.data.exercise_id}-${stamp()}.json`));
$('#again').addEventListener('click', () => { rv.pause(); R = null; S = null; show('pick'); });

$('#next-exercise').addEventListener('click', () => {
  if (R && $('#pain-saved').hidden && !confirm('Continue without saving your pain check and dashboard progress?')) return;
  rv.pause();
  queuePosition++;
  if (queuePosition >= sessionQueue.length) { location.href = 'index.html'; return; }
  pickedId = sessionQueue[queuePosition]; R = null; S = null; renderPicker(); show('pick');
  $('#set-title').focus();
});
