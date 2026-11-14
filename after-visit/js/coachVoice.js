// Prefer higher-quality English voices exposed by the browser. No API key required.
// Voice availability and pronunciation depend on the browser and operating system.
export function chooseCoachVoice(voices, language = 'en-US') {
  const english = voices.filter(v => /^en(?:[-_]|$)/i.test(v.lang));
  const score = v => {
    let n = v.lang.toLowerCase() === language.toLowerCase() ? 20 : 0;
    if (/natural|neural|premium|enhanced/i.test(v.name)) n += 100;
    if (/google.*english|samantha|aria|jenny|guy/i.test(v.name)) n += 40;
    if (v.default) n += 5;
    return n;
  };
  return [...english].sort((a,b) => score(b)-score(a))[0] || null;
}

export const goodRepMessage = n => `${n}. ${['Nice and steady.', 'Good work.', 'That’s it.', 'Nicely done.'][(n-1)%4]}`;

export function createCoachVoice({ synth = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance, language = 'en-US' } = {}) {
  let active = null, pending = null, voices = [];
  const refresh = () => { voices = synth?.getVoices?.() || []; };
  refresh();
  synth?.addEventListener?.('voiceschanged', refresh);
  function stop() {
    active = null; pending = null;
    synth?.cancel();
  }
  function play(text) {
    refresh(); // Some browsers expose voices only after a user gesture.
    const utterance = new Utterance(text);
    const voice = chooseCoachVoice(voices, language);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || language;
    utterance.rate = 0.96;
    utterance.pitch = 1;
    utterance.volume = 1;
    active = utterance;
    const finished = () => {
      if (active !== utterance) return;
      active = null;
      if (pending) { const text = pending; pending = null; play(text); }
    };
    utterance.onend = finished;
    utterance.onerror = finished;
    synth.speak(utterance);
  }
  return {
    speak(text, { interrupt = false } = {}) {
      if (!synth || !Utterance || !text) return;
      if (interrupt) stop();
      // Finish the current phrase and keep only the newest cue, avoiding stale coaching.
      if (active) { pending = text; return; }
      play(text);
    },
    stop,
    dispose() { stop(); synth?.removeEventListener?.('voiceschanged', refresh); },
  };
}
