import { createCoachVoice, goodRepMessage } from './js/coachVoice.js';
// Home PT session: today's plan -> each exercise (camera, tracking, auto-recording, scoring) ->
// short break between exercises -> done, saved on this phone.
//
// Flow per exercise: setup (are you in frame?) -> 1.5 s in frame -> 3-2-1 -> recording starts on its own
// -> reps are counted and scored -> after the last rep the video is closed and the next exercise is offered.
import { DEMO_PLAN, planExercises } from './js/plan.js';
import { SessionLog } from './js/sessionLog.js';
import { ExerciseTracker } from './js/exerciseTracker.js';
import { store } from './js/store.js';
import { drawPose } from './js/draw.js';
import { loadPose, openCamera, stopStream, Recorder, startPoseLoop } from './js/tracker.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const icon = (id, cls = 'icon icon--sm') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const QUALITY = { good: ['i-check', 'Good'], fair: ['i-tilde', 'Fair'], poor: ['i-x', 'Poor'] };
const exIcon = (ex) => (ex.joint.includes('knee') ? 'i-squat' : 'i-arm');
const JOINT_WORD = { shoulder: 'shoulder', knee: 'knee', elbow: 'elbow', hip: 'hip' };

const SCREENS = ['plan', 'live', 'between', 'done'];
function show(name) {
  for (const s of SCREENS) $(`#screen-${s}`).hidden = s !== name;
  document.querySelector('meta[name="theme-color"]').content = name === 'live' ? '#0b1620' : '#F4F0E2';
  scrollTo(0, 0);
}

// ---------------------------------------------------------------- voice (chunk 3 makes this smarter)
let voiceOn = true;
const coachVoice = createCoachVoice();
function speak(text, options) {
  if (!voiceOn) { coachVoice.stop(); return; }
  coachVoice.speak(text, options);
}
addEventListener('pagehide', () => coachVoice.stop());
$('#voice').addEventListener('change', e => {
  voiceOn = e.target.checked;
  if (!voiceOn) coachVoice.stop();
});

// ---------------------------------------------------------------- 1. plan
const PLAN = DEMO_PLAN;
const EXS = planExercises(PLAN);

function renderPlan() {
  const minutes = Math.max(3, Math.round(EXS.reduce((s, e) => s + e.reps * 5 + 40, 0) / 60));
  $('#plan-sub').textContent = `${EXS.length} exercises from ${PLAN.therapist}. About ${minutes} minutes.`;
  $('#plan-list').innerHTML = EXS.map((ex, i) => `
    <li class="tile plan-item">
      <span class="badge-icon ${i % 2 ? 'badge-icon--peach' : 'badge-icon--blue'}">${icon(exIcon(ex), 'icon')}</span>
      <div>
        <h2>${esc(ex.name)}</h2>
        <div class="plan-item__facts">
          <span class="chip num">${ex.reps} reps</span>
          <span class="chip">${ex.mode === 'precise' ? `Raise to ${ex.target}°` : 'The camera counts your reps'}</span>
          <span class="chip">${esc(ex.view)}</span>
        </div>
        <p class="plan-item__how">${esc(ex.instruction)}</p>
      </div>
    </li>`).join('');
}
renderPlan();

function planError(msg) { const el = $('#plan-error'); el.textContent = msg; el.hidden = !msg; }

// ---------------------------------------------------------------- session state
let log = null;            // SessionLog for the whole session
let videos = {};           // exercise idx -> Blob
let idx = -1;              // current exercise
let T = null;              // ExerciseTracker for the current exercise (null between exercises)
let cam = null;            // { stream, stop, wake }
let rec = null;            // Recorder for the current exercise
let ui = {};               // per-exercise UI state
let active = false;        // a session is running (warn before leaving the page)

const video = $('#cam'), overlay = $('#overlay');

$('#start').addEventListener('click', async () => {
  planError('');
  voiceOn = $('#voice').checked;
  speak("Let’s get comfortable and take this one step at a time.", { interrupt: true });            // iOS only allows speech that starts inside a tap
  $('#start').disabled = true;
  log = new SessionLog({ plan: PLAN });
  videos = {};
  idx = -1;
  active = true;
  show('live');
  setCoach('Opening the camera…');
  try {
    const stream = await openCamera(video);
    cam = { stream };
    try { cam.wake = await navigator.wakeLock?.request('screen'); } catch {}
  } catch (err) {
    console.error(err);
    active = false;
    $('#start').disabled = false;
    show('plan');
    planError("We couldn't open the camera. Allow camera access for this page, then try again. On a phone, the page must open from an https:// link.");
    return;
  }
  sizeOverlay();
  startExercise(0);
  setCoach('Loading motion tracking…');
  try {
    const landmarker = await loadPose();
    cam.stop = startPoseLoop(video, landmarker, onPose);
    if (T) setCoach(T.ex.view);
  } catch (err) {
    console.error(err);
    setCoach('Motion tracking could not load. Check the internet connection, then end and try again.', 'warn');
  }
  $('#start').disabled = false;
});

function sizeOverlay() { overlay.width = video.videoWidth || 1280; overlay.height = video.videoHeight || 720; }

// ---------------------------------------------------------------- 2. live exercise
function startExercise(i) {
  idx = i;
  const ex = EXS[i];
  T = new ExerciseTracker(ex, log.beginExercise(ex));
  ui = { inFrameSince: null, countdown: null, readySaid: false, timer: null, ending: false };

  $('#screen-live').classList.toggle('simple', ex.mode === 'simple');
  $('#live-step').textContent = `Exercise ${i + 1} of ${EXS.length}`;
  $('#live-title').textContent = ex.name;
  $('#m-target').textContent = `${ex.target}°`;
  $('#m-angle').textContent = '–';
  $('#m-angle-label').textContent = 'Angle';
  $('#m-reps').textContent = `0/${ex.reps}`;
  $('#m-good').textContent = '0';
  $('#bar-target').style.left = `${T.targetProgress()}%`;
  $('#bar-fill').style.width = '0';
  $('#rep-dots').innerHTML = '';
  $('#rec').classList.remove('on');
  $('#rec-time').textContent = '0:00';
  $('#setup-text').textContent = ex.setup;
  $('#setup').hidden = false;
  frameCheck(false, 'Looking for you…');
  show('live');
  if (cam?.stop) {
    setCoach(ex.view);
    speak(`${ex.name}. ${ex.view}.`);
  }
}

function setCoach(text, kind = '') { const el = $('#coach'); el.textContent = text; el.className = `coach ${kind}`; }

function onPose(res, now) {
  if (!T) return;
  if (overlay.width !== video.videoWidth && video.videoWidth) sizeOverlay();
  const lms = res.landmarks?.[0] || null;
  const r = T.update(lms, video.videoWidth, video.videoHeight, now);
  const ex = T.ex;

  if (!r.seen) {
    drawPose(overlay, null);
    if (!T.recording) frameCheck(false, 'Step into the camera view');
    return;
  }

  const precise = ex.mode === 'precise';
  drawPose(overlay, lms, {
    highlight: r.side ? { side: r.side, joint: ex.joint } : null,
    angle: precise ? r.angle : undefined,
    mirror: true,
    status: r.broken ? 'warn' : 'ok',
  });
  if (r.angle != null) {
    if (precise) {
      $('#m-angle').textContent = `${Math.round(r.angle)}°`;
      if (r.side) $('#m-angle-label').textContent = `${r.side === 'left' ? 'Left' : 'Right'} ${JOINT_WORD[ex.joint[1]] || 'angle'}`;
    }
    $('#bar-fill').style.width = `${T.progress(r.angle)}%`;
    $('#bar-fill').classList.toggle('hit', r.atTarget);
  }

  if (!T.recording) {
    frameCheck(r.visible, r.visible ? 'We can see you' : `Move so your whole ${ex.joint.includes('knee') ? 'leg' : 'upper body'} is in the picture`);
    return;
  }

  if (r.broken) setCoach(r.broken.label, 'warn');
  else if (r.holding != null) setCoach(`Hold… ${(r.holding / 1000).toFixed(1)} of ${ex.holdMs / 1000} seconds`, 'good');

  for (const ev of r.events) onEvent(ev);
}

function onEvent(ev) {
  const ex = T.ex;
  if (ev.type === 'ready' && !ui.readySaid) {
    ui.readySaid = true;
    setCoach('Go! Start your first rep.', 'good');
    speak('Whenever you’re ready.', { interrupt: true });
    return;
  }
  if (ev.type !== 'rep') return;
  const rep = ev.rep, n = T.reps.length, good = T.reps.filter((x) => x.quality === 'good').length;
  $('#m-reps').textContent = `${n}/${ex.reps}`;
  $('#m-good').textContent = String(good);
  const [ic, word] = QUALITY[rep.quality];
  $('#rep-dots').insertAdjacentHTML('beforeend',
    `<li class="rep-dot rep-dot--${rep.quality}">${icon(ic)}<span class="num">${n}</span><span class="visually-hidden">${word}</span></li>`);

  const detail = ex.mode === 'precise' ? ` ${rep.peakAngle}°` : '';
  if (rep.quality === 'good') { setCoach(`Rep ${n}: good!${detail}`, 'good'); speak(goodRepMessage(n)); }
  else { setCoach(`Rep ${n}: ${rep.issues[0] || 'try again'}`, 'warn'); speak(`${n}. ${rep.issues[0] || 'Try again'}.`); }

  if (T.done && !ui.ending) { ui.ending = true; setTimeout(() => endExercise(), 1200); }
}

// In frame for 1.5 s -> 3-2-1 -> recording starts on its own.
function frameCheck(ok, text) {
  const el = $('#frame-check');
  el.textContent = text;
  el.classList.toggle('ok', ok);
  if (!ok) {
    ui.inFrameSince = null;
    if (ui.countdown) { clearInterval(ui.countdown); ui.countdown = null; $('#countdown').hidden = true; }
    return;
  }
  ui.inFrameSince ??= performance.now();
  if (!ui.countdown && performance.now() - ui.inFrameSince > 1500) {
    let n = 3;
    $('#countdown').textContent = n; $('#countdown').hidden = false; speak('3', { interrupt: true });
    ui.countdown = setInterval(() => {
      n -= 1;
      if (n > 0) { $('#countdown').textContent = n; speak(String(n), { interrupt: true }); }
      else startRecording();
    }, 1000);
  }
}

function startRecording() {
  if (!T || T.recording) return;
  clearInterval(ui.countdown); ui.countdown = null;
  $('#countdown').hidden = true;
  $('#setup').hidden = true;
  rec = new Recorder(cam.stream);
  rec.start();
  T.startRecording(performance.now());
  $('#rec').classList.add('on');
  ui.timer = setInterval(() => ($('#rec-time').textContent = mss(T ? T.elapsed(performance.now()) : 0)), 500);
  const ex = T.ex;
  setCoach('Recording. Get into the starting position.');
  speak(ex.mode === 'precise' ? `Let’s do ${ex.reps} reps. Aim for ${ex.target} degrees, and take your time.` : `Let’s do ${ex.reps} reps, nice and easy.`, { interrupt: true });
}
$('#start-now').addEventListener('click', () => startRecording());
$('#skip').addEventListener('click', () => endExercise({ skipped: true }));

/** Close the current exercise (keeping whatever was recorded) and go to the break or the end. */
async function endExercise({ skipped = false, endSession = false } = {}) {
  if (!T) return;
  const tr = T;
  T = null;                                        // stop processing frames
  clearInterval(ui.countdown); clearInterval(ui.timer);
  $('#countdown').hidden = true;
  $('#rec').classList.remove('on');
  let video = null;
  if (rec) {
    const blob = await rec.stop();
    rec = null;
    if (blob?.size) {
      videos[tr.log.idx] = blob;
      video = { mime: blob.type, width: overlay.width, height: overlay.height, bytes: blob.size };
    }
  }
  const nothing = !tr.recording || (skipped && !tr.reps.length);
  tr.finish(performance.now(), { video, skipped: skipped || nothing });

  if (!endSession && idx + 1 < EXS.length) return showBetween(tr);
  endRemaining();
}

$('#end').addEventListener('click', () => {
  if (!T) return;
  $('#confirm-end').showModal();
});
$('#confirm-keep').addEventListener('click', () => $('#confirm-end').close());
$('#confirm-end-btn').addEventListener('click', () => { $('#confirm-end').close(); endExercise({ endSession: true }); });

// ---------------------------------------------------------------- 3. between exercises
function showBetween(tr) {
  const done = tr.log.toRecord(), s = done.summary, ex = EXS[idx + 1];
  $('#between-step').textContent = `${idx + 1} of ${EXS.length} done`;
  $('#between-title').textContent = done.skipped ? `${done.name} skipped` : `${done.name} done`;
  $('#between-sub').textContent = done.skipped ? "That's okay. You can try it next time."
    : `${s.goodReps} of ${s.totalReps} good reps.${s.goodReps === s.totalReps && s.totalReps ? ' Lovely work!' : ''}`;
  $('#between-reps').innerHTML = done.reps.map((r) => {
    const [ic, word] = QUALITY[r.quality];
    return `<li class="status status--${r.quality}">${icon(ic)}Rep ${r.n}: ${word}</li>`;
  }).join('');
  $('#next-icon').setAttribute('href', `#${exIcon(ex)}`);
  $('#next-name').textContent = ex.name;
  $('#next-setup').textContent = ex.setup;
  $('#next').textContent = `Start ${ex.name.toLowerCase()}`;
  show('between');
  speak(done.skipped ? `Up next, ${ex.name}.` : `${done.name} done. ${s.goodReps} of ${s.totalReps} good. Up next, ${ex.name}.`);
}
$('#next').addEventListener('click', () => startExercise(idx + 1));
$('#next-skip').addEventListener('click', () => endRemaining());

/** Anything not started counts as skipped, then the session ends. */
function endRemaining() {
  for (let j = idx + 1; j < EXS.length; j++) {
    const later = new ExerciseTracker(EXS[j], log.beginExercise(EXS[j]));
    later.finish(performance.now(), { skipped: true });
  }
  finishSession();
}

// ---------------------------------------------------------------- 4. done
const allGood = (e) => e.summary.totalReps > 0 && e.summary.goodReps === e.summary.totalReps;
async function finishSession() {
  coachVoice.stop();
  cam?.stop?.(); stopStream(cam?.stream); cam?.wake?.release?.(); cam = null;
  drawPose(overlay, null);
  log.finish();
  active = false;
  const summary = log.toRecord();
  const t = summary.totals;
  $('#done-sub').textContent = t.reps ? `${t.good} of ${t.reps} reps were good.` : 'No reps were counted this time.';
  $('#done-list').innerHTML = summary.exercises.map((e) => `<li><span>${esc(e.name)}</span>${e.skipped
    ? '<span class="status status--fair">Skipped</span>'
    : allGood(e) ? `<span class="status status--good">${icon('i-check')}${e.summary.goodReps} of ${e.summary.totalReps} good</span>`
      : `<span class="status status--fair">${icon('i-tilde')}${e.summary.goodReps} of ${e.summary.totalReps} good</span>`}</li>`).join('');
  show('done');
  speak(t.reps ? `You’re all done. ${t.good} of ${t.reps} reps were good. Take a moment to rest.` : 'You’re all done. Take a moment to rest.', { interrupt: true });

  const saved = $('#saved');
  saved.className = 'saved';
  saved.textContent = 'Saving…';
  try {
    const st = store();
    await st.saveSession(log, { videos });
    st.keep();
    saved.innerHTML = `${icon('i-save')}${st.persistent ? 'Saved on this phone for your therapist' : 'Saved for now. Keep this tab open'}`;
  } catch (err) {
    console.error(err);
    saved.classList.add('err');
    saved.textContent = "Couldn't save this session. There may not be enough space on this phone.";
  }
  window.__lastSession = summary;     // handy for checking in DevTools
}
$('#again').addEventListener('click', () => show('plan'));

addEventListener('beforeunload', (e) => { if (active) { e.preventDefault(); e.returnValue = ''; } });
