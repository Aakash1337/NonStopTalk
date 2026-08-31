import { cloudProgress, mergeCoachingSummaries } from "./cloud-progress.js";

const app = document.querySelector("#app");
const announcer = document.querySelector("#announcer");
const toast = document.querySelector("#toast");

let room = null;
let roomCode = "";
let socket = null;
let socketRoom = "";
let reconnectTimer = 0;
let reconnectDelay = 750;
let claimRefreshTimer = 0;
let clockOffset = 0;
let clockTimer = 0;
let controller = null;
let busy = false;
let routeGeneration = 0;
let coachingRun = null;
let pendingCoachingToken = null;
let coachEnginePromise = null;
let routeFocusRequested = false;
let practice = freshPracticeState();
let progressSessions = [];

const PRACTICE_SCENARIOS = [
  { id: "interview", name: "Interview answer", prompt: "Tell me about a time you solved a difficult problem." },
  { id: "presentation", name: "Presentation opening", prompt: "Open a presentation and make the audience care about your idea." },
  { id: "impromptu", name: "Impromptu response", prompt: "What is one everyday habit that deserves a redesign?" },
];
const PRACTICE_GOALS = [
  { id: "pace", name: "Intentional pace", detail: "Use complete thoughts and give important ideas room to land." },
  { id: "pauses", name: "Purposeful pauses", detail: "Replace rushed transitions with short, deliberate pauses." },
  { id: "energy", name: "Steady delivery", detail: "Keep your vocal level consistent without clipping." },
];
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/i;

document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
window.addEventListener("popstate", () => {
  routeFocusRequested = true;
  loadRoute();
});
window.addEventListener("pagehide", shutdown);

loadRoute();

async function loadRoute() {
  const generation = ++routeGeneration;
  stopRoomLifecycle();
  const finishingIntoProgress = practice.phase === "finishing" && /^\/progress\/?$/i.test(location.pathname);
  if (!finishingIntoProgress) stopCoachingLifecycle();
  room = null;
  updatePrimaryNavigation();
  if (/^\/practice\/?$/i.test(location.pathname)) {
    roomCode = "";
    document.title = "Practice · NonStopTalk";
    practice = freshPracticeState(practice.setup);
    renderPractice();
    focusRouteHeading();
    return;
  }
  if (/^\/progress\/?$/i.test(location.pathname)) {
    roomCode = "";
    document.title = "Progress · NonStopTalk";
    await renderProgress(generation);
    focusRouteHeading();
    return;
  }
  const match = location.pathname.match(/^\/room\/([A-HJ-NP-Z2-9]{6})\/?$/i);
  if (!match) {
    roomCode = "";
    document.title = "NonStopTalk";
    renderLanding();
    focusRouteHeading();
    return;
  }
  roomCode = match[1].toUpperCase();
  document.title = `${roomCode} · NonStopTalk`;
  app.innerHTML = `<section class="loading-card" role="status">Opening room ${escapeHTML(roomCode)}…</section>`;
  try {
    const payload = await api(`/api/rooms/${roomCode}/state`);
    if (generation !== routeGeneration) return;
    acceptRoom(payload.room);
    focusRouteHeading();
  } catch (error) {
    if (generation !== routeGeneration) return;
    renderLanding(error.message === "Room not found." ? "That room does not exist." : error.message);
    focusRouteHeading();
  }
}

function renderLanding(message = "") {
  app.innerHTML = `
    ${message ? notice(message, true) : ""}
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Play + practice</p>
        <h1>Find your voice.</h1>
        <p class="lede">Build speaking confidence with private, on-device coaching—or draw a topic and keep the words moving with friends.</p>
        <div class="action-row hero-buttons"><a class="button primary" href="/practice" data-route>Start practicing</a><a class="button ghost" href="/progress" data-route>View progress</a></div>
        <p class="hint">The online edition stores each room in its own Cloudflare Durable Object. The local Go edition still works independently.</p>
      </div>
      <div class="landing-actions">
        <form class="panel stack" data-create-room>
          <div class="panel-head"><h2>Create a room</h2><span class="tag">Host</span></div>
          <label>Your name <input name="name" maxlength="40" autocomplete="nickname" placeholder="Optional for a display-only host"></label>
          <button class="button primary" type="submit">Create room</button>
        </form>
        <form class="panel stack" data-join-room>
          <div class="panel-head"><h2>Join a room</h2><span class="tag">Player</span></div>
          <label>Room code <input name="code" minlength="6" maxlength="6" autocapitalize="characters" autocomplete="off" placeholder="ABC234" required></label>
          <label>Your name <input name="name" maxlength="40" autocomplete="nickname" required></label>
          <button class="button" type="submit">Join game</button>
        </form>
      </div>
    </section>`;
}

function freshPracticeState(setup = {}) {
  return {
    phase: "setup",
    setup: {
      scenario: setup.scenario || "interview",
      goal: setup.goal || "pauses",
      duration: Number(setup.duration) || 45,
      transcriptConsent: Boolean(setup.transcriptConsent),
      retainArtifacts: Boolean(setup.retainArtifacts),
      cloudSync: Boolean(setup.cloudSync),
    },
    error: "",
    report: null,
    advice: null,
    saved: false,
    transcriptUsed: false,
    live: null,
  };
}

function renderPractice() {
  if (practice.phase === "calibrating" || practice.phase === "permission") {
    renderPracticeCalibration();
    return;
  }
  if (practice.phase === "active" || practice.phase === "finishing") {
    renderPracticeLive();
    return;
  }
  if (practice.phase === "review") {
    renderPracticeReview();
    return;
  }
  renderPracticeSetup();
}

function renderPracticeSetup() {
  const speech = localSpeechCapability();
  const hasMicrophone = Boolean(navigator.mediaDevices?.getUserMedia);
  const canRecord = typeof window.MediaRecorder === "function";
  app.innerHTML = `
    <section class="coach-hero">
      <div>
        <p class="eyebrow">Private speaking lab</p>
        <h1>Practice with a signal, not a score.</h1>
        <p class="lede">Choose one delivery goal. NonStopTalk listens for timing and vocal-level patterns, gives one useful live cue, then helps you retry.</p>
      </div>
      <div class="privacy-card">
        <span class="device-badge"><span aria-hidden="true">●</span> On device</span>
        <h2>Your voice stays here.</h2>
        <p>Audio is analyzed live in this tab and never uploaded. Recording is off by default. A separate choice can back up only the compact metric summary to NonStopTalk's database.</p>
        <ul class="check-list"><li>AudioWorklet live analysis</li><li>No audio or captured-transcript upload</li><li>Local and cloud data controls</li></ul>
      </div>
    </section>
    ${practice.error ? notice(practice.error, true) : ""}
    <form class="coach-setup panel stack" data-coach-setup>
      <div class="section-head"><div><p class="eyebrow">Set your session</p><h2>One goal. One attempt.</h2></div><span class="step-mark">01 / 03</span></div>
      <div class="coach-fields">
        <label>Speaking scenario
          <select name="scenario">${PRACTICE_SCENARIOS.map((item) => `<option value="${item.id}" ${practice.setup.scenario === item.id ? "selected" : ""}>${escapeHTML(item.name)}</option>`).join("")}</select>
        </label>
        <label>Coaching goal
          <select name="goal">${PRACTICE_GOALS.map((item) => `<option value="${item.id}" ${practice.setup.goal === item.id ? "selected" : ""}>${escapeHTML(item.name)}</option>`).join("")}</select>
        </label>
        <label>Attempt length
          <select name="duration">${[30, 45, 60, 90].map((seconds) => `<option value="${seconds}" ${practice.setup.duration === seconds ? "selected" : ""}>${seconds} seconds</option>`).join("")}</select>
        </label>
      </div>
      <fieldset class="consent-card" aria-label="Optional transcript analysis" ${speech.supported ? "" : "disabled"}>
        <legend>Optional transcript analysis</legend>
        <label class="choice-row">
          <input type="checkbox" name="transcriptConsent" ${practice.setup.transcriptConsent && speech.supported ? "checked" : ""}>
          <span><strong>Use experimental on-device transcription</strong><small>${speech.supported ? "Adds pace and word-pattern evidence. Derived counts and filler/repetition patterns are saved; the full captured transcript is discarded unless you also select full-session retention below." : escapeHTML(speech.reason)}</small></span>
        </label>
      </fieldset>
      <fieldset class="consent-card" aria-label="Optional full session retention" ${canRecord ? "" : "disabled"}>
        <legend>Optional full session retention</legend>
        <label class="choice-row">
          <input type="checkbox" name="retainArtifacts" ${practice.setup.retainArtifacts && canRecord ? "checked" : ""}>
          <span><strong>Keep the recording and captured transcript when available</strong><small>${canRecord ? "Stores the browser-encoded attempt recording and, when local transcription is enabled and succeeds, its captured transcript for this site in this browser profile. Those artifacts are never uploaded. There is no automatic local expiry; Progress downloads them or deletes all local coaching data. Downloaded copies are yours to manage." : "This browser cannot create a local audio recording. Compact coaching summaries still work."}</small></span>
        </label>
      </fieldset>
      <fieldset class="consent-card" aria-label="Optional cloud summary backup">
        <legend>Optional cloud summary backup</legend>
        <label class="choice-row">
          <input type="checkbox" name="cloudSync" ${practice.setup.cloudSync ? "checked" : ""}>
          <span><strong>Back up this attempt's compact summary online</strong><small>Sends measurements, advice, and any derived word-pattern counts to NonStopTalk's database. It never sends audio or captured transcript text. Until accounts exist, access is tied to this browser and anonymous backups expire after 30 days without cloud use.</small></span>
        </label>
      </fieldset>
      <div class="coach-start-row">
        <div><p class="hint">Next: a four-second quiet + speaking calibration. Browser microphone permission is required.</p>${hasMicrophone ? "" : `<p class="notice error" role="alert">This browser does not expose microphone input.</p>`}</div>
        <button class="button primary coach-start" type="submit" data-coach-start ${hasMicrophone ? "" : "disabled"}>Calibrate microphone <span aria-hidden="true">→</span></button>
      </div>
    </form>`;
}

function renderPracticeCalibration() {
  const waiting = practice.phase === "permission";
  const stage = practice.calibrationStage || "quiet";
  const quiet = stage === "quiet";
  app.innerHTML = `
    <section class="coach-stage" data-coach-calibration aria-labelledby="calibration-title">
      <div class="stage-top"><span class="device-badge"><span aria-hidden="true">●</span> On device</span><span class="step-mark">02 / 03</span></div>
      <p class="eyebrow">Microphone calibration</p>
      <h1 id="calibration-title">${waiting ? "Allow microphone access." : quiet ? "Stay quiet for a moment." : "Now speak normally."}</h1>
      <p class="lede">${waiting ? practice.setup.retainArtifacts ? "Your browser will ask for permission. Your selected recording begins only after calibration and stays in this browser profile." : "Your browser will ask for permission. Audio is analyzed locally and is not recorded or uploaded." : quiet ? "We are learning the sound of your room so pauses are measured fairly. Calibration audio is not retained." : "Say: “I am ready to practice my speaking.” Calibration audio is not retained."}</p>
      <div class="calibration-track" aria-hidden="true"><span data-coach-calibration-bar style="width:${waiting ? 0 : quiet ? 30 : 70}%"></span></div>
      <p class="calibration-status" role="status" data-coach-calibration-status>${waiting ? "Waiting for permission…" : quiet ? "Measuring room level…" : "Measuring your speaking level…"}</p>
      <button class="button ghost" type="button" data-command="coach-cancel">Cancel</button>
    </section>`;
}

function updateCalibrationStage({ headingText, instructionsText, statusText, progress }) {
  let stage = document.querySelector("[data-coach-calibration]");
  if (!stage) {
    renderPractice();
    stage = document.querySelector("[data-coach-calibration]");
  }
  if (!stage) return;
  const heading = stage.querySelector("#calibration-title");
  const instructions = stage.querySelector(".lede");
  const status = stage.querySelector("[data-coach-calibration-status]");
  const bar = stage.querySelector("[data-coach-calibration-bar]");
  if (heading) heading.textContent = headingText;
  if (instructions) instructions.textContent = instructionsText;
  if (status) status.textContent = statusText;
  if (bar) bar.style.width = `${progress}%`;
  announce(`${headingText} ${statusText}`);
}

function showQuietCalibrationStage() {
  updateCalibrationStage({
    headingText: "Stay quiet for a moment.",
    instructionsText: "We are learning the sound of your room so pauses are measured fairly. Calibration audio is not retained.",
    statusText: "Measuring room level…",
    progress: 30,
  });
}

function showSpeakingCalibrationStage() {
  updateCalibrationStage({
    headingText: "Now speak normally.",
    instructionsText: "Say: “I am ready to practice my speaking.” Calibration audio is not retained.",
    statusText: "Measuring your speaking level…",
    progress: 50,
  });
}

function renderPracticeLive() {
  const scenario = scenarioById(practice.setup.scenario);
  const goal = goalById(practice.setup.goal);
  const live = practice.live || {};
  const remaining = Math.max(0, practice.setup.duration - Math.floor((live.elapsedMs || 0) / 1000));
  app.innerHTML = `
    <section class="practice-live" data-coach-live>
      <div class="stage-top"><span class="device-badge" title="${practice.analysisMode === "Analyser fallback" ? "Compatibility analysis uses an AnalyserNode on this device." : "Audio is measured off the main browser thread."}"><span aria-hidden="true">●</span> On device · ${practice.analysisMode === "Analyser fallback" ? "compatibility mode" : "AudioWorklet"}</span><span class="step-mark">03 / 03</span></div>
      <div class="practice-grid">
        <div class="prompt-stage">
          <p class="eyebrow">${escapeHTML(scenario.name)}</p>
          <h1>${escapeHTML(scenario.prompt)}</h1>
          <p class="goal-line"><strong>Focus:</strong> ${escapeHTML(goal.detail)}</p>
          <div class="coach-timer" data-coach-timer aria-label="${remaining} seconds remaining">${remaining}</div>
          <div class="coach-meter" aria-label="Live microphone level"><span data-coach-meter style="width:${Math.round((live.level || 0) * 100)}%"></span><i data-coach-threshold></i></div>
          <div class="live-stats" aria-label="Current measurements">
            <div><span data-coach-speaking>${formatPercent(live.speakingRatio)}</span><small>speaking</small></div>
            <div><span data-coach-pauses>${live.pauseCount ?? 0}</span><small>pauses</small></div>
            <div><span data-coach-level>${levelLabel(live.level)}</span><small>input</small></div>
          </div>
          <button class="button ghost" type="button" data-command="coach-stop" data-coach-stop>${practice.phase === "finishing" ? "Building review…" : "Finish attempt"}</button>
        </div>
        <aside class="coach-sidebar">
          <div class="coach-tip ${live.tip ? "is-visible" : ""}" data-coach-tip role="status" aria-live="polite">
            <p class="eyebrow">Live cue</p>
            <h2 data-coach-tip-text>${escapeHTML(live.tip?.text || "Listening for a useful pattern…")}</h2>
            <p data-coach-tip-evidence>${escapeHTML(live.tip?.evidence || "Tips appear only when the signal is consistent.")}</p>
          </div>
          <div class="privacy-card compact"><h3>Private by design</h3><p>${practice.setup.retainArtifacts ? "You chose to keep full session artifacts only in this browser profile." : `Audio is reduced to measurements in memory. ${practice.setup.transcriptConsent ? "The captured transcript is discarded after derived word-pattern analysis." : "Transcription is off."}`} ${practice.setup.cloudSync ? "After the attempt, only the compact summary will be backed up online." : "Cloud summary backup is off."}</p></div>
        </aside>
      </div>
    </section>`;
}

function renderPracticeReview() {
  const report = practice.report || {};
  const advice = normalizedAdvice(practice.advice, report);
  const transcript = report.transcriptMetrics;
  const grounding = practice.advice?.grounding;
  const retainedCopy = retainedArtifactCopy(practice.savedArtifacts);
  const storageCopy = coachingReviewStorageCopy(retainedCopy);
  app.innerHTML = `
    <section class="coach-review" data-coach-review>
      ${practice.artifactWarning ? notice(practice.artifactWarning, true) : ""}
      <div class="review-head">
        <div><p class="eyebrow">Attempt review</p><h1>Keep this. Change one thing.</h1></div>
        <span class="device-badge"><span aria-hidden="true">●</span> Analysis complete</span>
      </div>
      <div class="advice-grid">
        <article class="advice-card strength"><span>01 · Strength</span><h2>${escapeHTML(advice.strength)}</h2><p>${escapeHTML(advice.strengthEvidence)}</p></article>
        <article class="advice-card focus"><span>02 · Focus next</span><h2>${escapeHTML(advice.focus)}</h2><p>${escapeHTML(advice.focusEvidence)}</p></article>
        <article class="advice-card drill"><span>03 · Drill</span><h2>${escapeHTML(advice.drill)}</h2><p>${escapeHTML(advice.drillDetail)}</p></article>
      </div>
      <section class="panel evidence-panel">
        <div class="section-head"><div><p class="eyebrow">Evidence</p><h2>What the browser measured</h2></div><span>${escapeHTML(confidenceLabel(report.audioConfidence))}</span></div>
        <div class="metric-grid">
          ${reviewMetric(formatDuration(report.durationMs), "analyzed")}
          ${reviewMetric(formatPercent(report.speakingRatio), "speaking ratio")}
          ${reviewMetric(String(report.pauseCount ?? 0), "measured pauses")}
          ${reviewMetric(formatDuration(report.medianPauseMs), "median pause")}
          ${reviewMetric(formatDuration(report.longestSpeakingRunMs), "longest run")}
          ${reviewMetric(formatOptionalPercentage(report.levelConsistencyPct), "level consistency")}
          ${reviewMetric(formatOptionalPercentage(report.clippingPct), "clipping frames")}
          ${report.unknownMs > 0 ? reviewMetric(formatDuration(report.unknownMs), "unobserved audio") : ""}
        </div>
        ${renderCoachTimeline(report)}
        ${transcript ? `<div class="transcript-evidence"><div><span class="device-badge">On-device transcript</span><strong>${transcript.wordCount ?? 0} words · ${formatNumber(transcript.wordsPerMinute)} wpm</strong></div><p>${escapeHTML(formatTranscriptPatternSummary(transcript))} ${practice.savedArtifacts?.transcriptStored ? practice.savedArtifacts.transcriptMayBePartial ? "You opted to retain the captured transcript locally; finalization did not complete, so it may be partial." : "You opted to retain the captured transcript locally." : "The captured transcript has been discarded; these derived patterns are retained locally for analysis."}</p></div>` : `<p class="hint privacy-note">No transcript metrics were used or stored.${practice.savedArtifacts?.transcriptStored ? " A captured transcript artifact was retained locally at your request." : ""}</p>`}
        ${renderCoachGrounding(grounding)}
      </section>
      <div class="review-actions">
        <div><strong>${escapeHTML(storageCopy.title)}</strong><p class="hint">${escapeHTML(storageCopy.detail)}</p></div>
        <div class="action-row"><a class="button ghost" href="/progress" data-route>View progress</a><button class="button primary" type="button" data-command="coach-again">Try again <span aria-hidden="true">↻</span></button></div>
      </div>
    </section>`;
}

function coachingReviewStorageCopy(retainedCopy) {
  if (practice.saved) {
    const title = practice.cloudSaved
      ? "Saved locally and backed up online"
      : practice.artifactSaved
        ? "Summary and available selected artifacts saved locally"
        : "Saved for this site in this browser profile";
    const local = practice.artifactSaved
      ? retainedCopy
      : "Metrics, advice, and consented derived word patterns are kept locally—no full recording or captured transcript.";
    return {
      title,
      detail: `${local}${practice.cloudSaved ? " The online backup contains only the compact summary." : ""}`,
    };
  }
  if (practice.cloudSaved) {
    return {
      title: "Backed up online; local save failed",
      detail: "The compact summary is online for this anonymous browser identity, but no local summary, recording, or captured transcript was saved.",
    };
  }
  return {
    title: "Review ready; storage failed",
    detail: "The analysis is visible now, but this browser did not save a local record and no online backup completed.",
  };
}

function retainedArtifactCopy(artifacts = {}) {
  const transcriptCaveat = artifacts.transcriptMayBePartial ? " The captured transcript may be partial because finalization did not complete cleanly." : "";
  if (artifacts.audioStored && artifacts.transcriptStored) {
    return `The browser-encoded recording and captured transcript are stored only for this site in this browser profile.${transcriptCaveat}`;
  }
  if (artifacts.audioStored) return "The browser-encoded recording is stored only for this site in this browser profile; no captured transcript was saved.";
  if (artifacts.transcriptStored) return `The captured transcript is stored only for this site in this browser profile; no recording was saved.${transcriptCaveat}`;
  return "No full-session artifact was available to save.";
}

function renderCoachGrounding(grounding = {}) {
  const card = Array.isArray(grounding.retrieved) ? grounding.retrieved[0] : null;
  if (!card) return "";
  const terms = Array.isArray(card.matchedTerms) ? card.matchedTerms.slice(0, 5).join(", ") : "";
  const cardWasUsed = grounding.usedCardId === card.id;
  const provenance = cardWasUsed
    ? "This card shaped the retry drill through deterministic generation."
    : "This card was retrieved as context, but a higher-priority evidence rule supplied the retry drill.";
  return `<aside class="grounding-evidence" data-coach-grounding aria-label="Local RAG advice grounding">
    <div><span class="device-badge">Local RAG · retrieved</span><h3>${escapeHTML(card.title || "Curated coaching guidance")}</h3><small>${escapeHTML(card.source || "NonStopTalk Coaching Library")}</small></div>
    <div><p>${escapeHTML(card.excerpt || "")}</p><p class="hint">${escapeHTML(provenance)}${terms ? ` Matched locally: ${escapeHTML(terms)}.` : ""} No model or network call was used.</p></div>
  </aside>`;
}

function renderCoachTimeline(report) {
  const duration = Math.max(1, Number(report.durationMs) || 1);
  const segments = Array.isArray(report.segments) ? report.segments : [];
  const normalized = segments.map((segment) => {
    const start = Math.max(0, Number(segment.startMs ?? segment.start ?? 0));
    const end = Math.min(duration, Number(segment.endMs ?? segment.end ?? start));
    const kind = segment.kind === "unknown"
      ? "unknown"
      : segment.type === "pause" || segment.kind === "pause" || segment.kind === "silence" || segment.voiced === false
        ? "pause"
        : "voice";
    return { start, end, kind };
  });
  const voiceCount = normalized.filter((segment) => segment.kind === "voice").length;
  const quietCount = normalized.filter((segment) => segment.kind === "pause").length;
  const unknownCount = normalized.filter((segment) => segment.kind === "unknown").length;
  const summary = `${voiceCount} voice ${voiceCount === 1 ? "region" : "regions"}, ${quietCount} quiet ${quietCount === 1 ? "region" : "regions"}, and ${unknownCount} unobserved ${unknownCount === 1 ? "region" : "regions"} across ${formatDuration(duration)}.`;
  return `<div class="timeline-wrap" data-coach-timeline><div class="timeline-label"><span>Delivery timeline</span><span>voice <i class="voice-key"></i> quiet <i class="pause-key"></i> unobserved <i class="unknown-key"></i></span></div><p class="sr-only" id="coach-timeline-summary">${escapeHTML(summary)}</p><div class="speech-timeline" aria-label="Timeline of voice, quiet, and unobserved regions" aria-describedby="coach-timeline-summary">${normalized.map((segment) => {
    const label = `${segment.kind === "voice" ? "Voice" : segment.kind === "pause" ? "Quiet" : "Audio unobserved"}, ${formatDuration(segment.end - segment.start)}`;
    return `<span class="${segment.kind}" role="img" aria-label="${escapeHTML(label)}" style="left:${(segment.start / duration) * 100}%;width:${Math.max(.35, ((segment.end - segment.start) / duration) * 100)}%" title="${escapeHTML(label)}"></span>`;
  }).join("")}</div></div>`;
}

function reviewMetric(value, label) {
  return `<div class="review-metric"><strong>${escapeHTML(value)}</strong><span>${escapeHTML(label)}</span></div>`;
}

async function beginCoachingSession(values) {
  const generation = routeGeneration;
  const speech = localSpeechCapability();
  practice = freshPracticeState({
    scenario: String(values.scenario || "interview"),
    goal: String(values.goal || "pauses"),
    duration: clamp(Number(values.duration) || 45, 15, 180),
    transcriptConsent: values.transcriptConsent === "on" && speech.supported,
    retainArtifacts: values.retainArtifacts === "on" && typeof window.MediaRecorder === "function",
    cloudSync: values.cloudSync === "on",
  });
  practice.phase = "permission";
  renderPractice();
  const token = Symbol("coaching-run");
  pendingCoachingToken = token;
  let stream;
  let context;
  let run;
  try {
    const engine = await loadCoachEngine();
    if (pendingCoachingToken !== token || generation !== routeGeneration || !isPracticeRoute()) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      video: false,
    });
    if (pendingCoachingToken !== token || generation !== routeGeneration || !isPracticeRoute()) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error("This browser cannot analyze microphone audio.");
    context = new AudioContext();
    run = coachingRun = {
      token,
      generation,
      engine,
      stream,
      context,
      source: null,
      quietSamples: [],
      voiceSamples: [],
      calibrationStartedAt: performance.now(),
      analyzer: null,
      tipPolicy: null,
      startedAt: 0,
      lastTipAt: -Infinity,
      tipUntil: 0,
      transcript: "",
      transcriptFinalizationWarning: "",
      recognition: null,
      recorder: null,
      recordedChunks: [],
      discardRecording: false,
      updateTimer: 0,
      fallbackTimer: 0,
      calibrationTimer: 0,
      attemptTimer: 0,
      inputTrack: null,
      inputEndedHandler: null,
    };
    run.inputTrack = stream.getAudioTracks()[0] || null;
    run.inputEndedHandler = () => handleCoachingInputEnded(run);
    run.inputTrack?.addEventListener?.("ended", run.inputEndedHandler, { once: true });
    await context.resume();
    if (!isPendingCoachingRun(run)) {
      stopCoachingHardware(run);
      if (coachingRun === run) coachingRun = null;
      return;
    }
    run.source = context.createMediaStreamSource(stream);
    const attached = await attachCoachingMeter(run);
    if (!attached || !isPendingCoachingRun(run)) {
      stopCoachingHardware(run);
      if (coachingRun === run) coachingRun = null;
      return;
    }
    pendingCoachingToken = null;
    practice.analysisMode = run.analysisMode;
    run.calibrationStartedAt = performance.now();
    practice.phase = "calibrating";
    practice.calibrationStage = "quiet";
    practice.live = { elapsedMs: 0, level: 0, pauseCount: 0, speakingRatio: 0 };
    showQuietCalibrationStage();
    run.updateTimer = window.setInterval(updateCoachingUI, 100);
    run.calibrationTimer = window.setTimeout(() => {
      if (run !== coachingRun || practice.phase !== "calibrating") return;
      failCoachingRun(run, "Microphone analysis stopped during calibration. Check the input and try again.");
    }, 7_000);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (context?.state !== "closed") await context?.close().catch(() => {});
    if (pendingCoachingToken !== token || generation !== routeGeneration || !isPracticeRoute()) return;
    pendingCoachingToken = null;
    stopCoachingLifecycle();
    practice.phase = "setup";
    practice.error = microphoneErrorMessage(error);
    renderPractice();
    announce(practice.error);
  }
}

async function attachCoachingMeter(run) {
  if (!isPendingCoachingRun(run)) return false;
  if (run.context.audioWorklet && window.AudioWorkletNode) {
    try {
      await run.context.audioWorklet.addModule("/coach-audio-worklet.js");
      if (!isPendingCoachingRun(run)) return false;
      const node = new AudioWorkletNode(run.context, "coaching-meter");
      const silent = run.context.createGain();
      silent.gain.value = 0;
      node.port.onmessage = (event) => ingestCoachingFrame(event.data);
      run.source.connect(node).connect(silent).connect(run.context.destination);
      run.meterNode = node;
      run.silentNode = silent;
      run.analysisMode = "AudioWorklet";
      return true;
    } catch {
      // Use the same on-device analysis through an AnalyserNode on older browsers.
    }
  }
  if (!isPendingCoachingRun(run)) return false;
  const analyser = run.context.createAnalyser();
  analyser.fftSize = 2048;
  const samples = new Float32Array(analyser.fftSize);
  run.source.connect(analyser);
  run.analyser = analyser;
  run.analysisMode = "Analyser fallback";
  run.fallbackTimer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    let peak = 0;
    for (const sample of samples) {
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    ingestCoachingFrame({ rms: Math.sqrt(energy / samples.length), peak });
  }, 100);
  return true;
}

function isPendingCoachingRun(run) {
  return coachingRun === run
    && pendingCoachingToken === run.token
    && routeGeneration === run.generation
    && isPracticeRoute()
    && run.context?.state !== "closed";
}

function ingestCoachingFrame(frame) {
  const run = coachingRun;
  if (!run || !Number.isFinite(frame?.rms) || !Number.isFinite(frame?.peak)) return;
  const now = performance.now();
  if (practice.phase === "calibrating") {
    const elapsed = now - run.calibrationStartedAt;
    const sample = { rms: frame.rms, peak: frame.peak };
    if (elapsed < 2_000) run.quietSamples.push(sample);
    else run.voiceSamples.push(sample);
    practice.live.level = Math.min(1, frame.rms * 8);
    if (elapsed >= 2_000 && practice.calibrationStage !== "voice") {
      practice.calibrationStage = "voice";
      showSpeakingCalibrationStage();
    }
    if (elapsed >= 4_000 && !run.activating) activateCoachingAttempt(run);
    return;
  }
  if (practice.phase !== "active" || !run.analyzer) return;
  const elapsedMs = now - run.startedAt;
  run.analyzer.ingest({ atMs: elapsedMs, rms: frame.rms, peak: frame.peak });
  const snapshot = run.analyzer.snapshot(elapsedMs);
  const level = normalizedCoachLevel(frame.rms, run.calibration);
  const live = snapshotToLive(snapshot, elapsedMs, level, practice.live?.tip);
  if (elapsedMs >= 5_000 && now >= run.tipUntil && now - run.lastTipAt >= 10_000) {
    const candidate = normalizeTip(run.tipPolicy.evaluate(snapshot, elapsedMs), snapshot);
    if (candidate) {
      live.tip = candidate;
      run.lastTipAt = now;
      run.tipUntil = now + 5_000;
    }
  } else if (now >= run.tipUntil) {
    live.tip = null;
  }
  practice.live = live;
  if (elapsedMs >= practice.setup.duration * 1000) finishCoachingSession("timer").catch((error) => showToast(error.message));
}

async function activateCoachingAttempt(run) {
  if (run !== coachingRun || run.activating) return;
  run.activating = true;
  clearTimeout(run.calibrationTimer);
  try {
    run.calibration = run.engine.deriveCalibration({ quietSamples: run.quietSamples, voiceSamples: run.voiceSamples });
    run.analyzer = new run.engine.CoachingAnalyzer({
      calibration: run.calibration,
      goal: practice.setup.goal,
      targetDurationMs: practice.setup.duration * 1000,
    });
    run.tipPolicy = new run.engine.CoachingTipPolicy({ cooldownMs: 10_000 });
    run.startedAt = performance.now();
    run.attemptTimer = window.setTimeout(() => {
      if (run !== coachingRun || practice.phase !== "active") return;
      finishCoachingSession("timer").catch((error) => showToast(error.message));
    }, practice.setup.duration * 1_000);
    practice.phase = "active";
    practice.live = snapshotToLive(run.analyzer.snapshot(0), 0, 0, null);
    if (practice.setup.retainArtifacts) startArtifactRecorder(run);
    if (practice.setup.transcriptConsent) startLocalRecognition(run);
    renderPractice();
    announce("Calibration complete. Your practice attempt has started.");
  } catch (error) {
    stopCoachingLifecycle();
    practice.phase = "setup";
    practice.error = error?.message || "Calibration could not find a clear speaking level. Try again closer to the microphone.";
    renderPractice();
  }
}

function startLocalRecognition(run) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return;
  try {
    const recognition = new Recognition();
    if (!("processLocally" in recognition)) return;
    recognition.processLocally = true;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = document.documentElement.lang || "en-US";
    recognition.onresult = (event) => {
      if (run !== coachingRun) return;
      let text = "";
      for (let index = 0; index < event.results.length; index += 1) text += `${event.results[index][0]?.transcript || ""} `;
      run.transcript = text.trim().slice(0, 20_000);
      if (run.transcript) practice.transcriptUnavailable = false;
    };
    recognition.onerror = () => {
      if (run === coachingRun && !run.transcript.trim()) practice.transcriptUnavailable = true;
    };
    const track = run.stream.getAudioTracks()[0];
    recognition.start(track);
    run.recognition = recognition;
  } catch {
    practice.transcriptUnavailable = true;
  }
}

function startArtifactRecorder(run) {
  try {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    const mimeType = candidates.find((value) => window.MediaRecorder.isTypeSupported?.(value));
    const recorder = new MediaRecorder(run.stream, mimeType ? { mimeType } : undefined);
    run.recordedChunks = [];
    run.discardRecording = false;
    recorder.ondataavailable = (event) => {
      if (!run.discardRecording && event.data?.size) run.recordedChunks.push(event.data);
    };
    recorder.onerror = () => {
      if (run === coachingRun) practice.artifactWarning = "The browser could not retain this recording.";
    };
    recorder.start(1_000);
    run.recorder = recorder;
  } catch {
    run.recorder = null;
    practice.artifactWarning = "The browser could not retain this recording.";
  }
}

function stopArtifactRecorder(run) {
  const recorder = run.recorder;
  if (!recorder) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const chunks = run.recordedChunks.splice(0);
      const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
      run.discardRecording = true;
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.removeEventListener("stop", finish);
      recorder.removeEventListener("error", finish);
      run.recorder = null;
      resolve(chunks.length ? new Blob(chunks, { type }) : null);
    };
    const timeout = setTimeout(finish, 2_000);
    recorder.addEventListener("stop", finish, { once: true });
    recorder.addEventListener("error", finish, { once: true });
    try {
      if (recorder.state === "inactive") finish();
      else recorder.stop();
    } catch {
      finish();
    }
  });
}

function finishLocalRecognition(run) {
  const recognition = run.recognition;
  if (!recognition) return Promise.resolve(run.transcript);
  return new Promise((resolve) => {
    let settled = false;
    const priorOnEnd = recognition.onend;
    const priorOnError = recognition.onerror;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      recognition.onend = priorOnEnd;
      recognition.onerror = priorOnError;
      resolve(run.transcript);
    };
    recognition.onend = (event) => {
      try { priorOnEnd?.call(recognition, event); } finally { finish(); }
    };
    recognition.onerror = (event) => {
      if (run.transcript.trim()) {
        run.transcriptFinalizationWarning = "The captured transcript may be partial because on-device recognition ended with an error.";
      }
      try { priorOnError?.call(recognition, event); } finally { finish(); }
    };
    const timeout = setTimeout(() => {
      if (run.transcript.trim()) {
        run.transcriptFinalizationWarning = "The captured transcript may be partial because on-device recognition did not finish within two seconds.";
      }
      finish();
    }, 2_000);
    try { recognition.stop(); } catch { finish(); }
  });
}

async function finishCoachingSession(reason = "manual") {
  const run = coachingRun;
  if (!run || practice.phase !== "active") return;
  practice.phase = "finishing";
  updateCoachingUI();
  const endedAt = Math.min(performance.now() - run.startedAt, practice.setup.duration * 1000);
  const [capturedTranscript, audioBlob] = await Promise.all([
    finishLocalRecognition(run),
    practice.setup.retainArtifacts ? stopArtifactRecorder(run) : Promise.resolve(null),
  ]);
  const transcriptText = typeof capturedTranscript === "string" ? capturedTranscript.trim() : "";
  const transcriptMayBePartial = Boolean(transcriptText && run.transcriptFinalizationWarning);
  if (transcriptMayBePartial) practice.artifactWarning ||= run.transcriptFinalizationWarning;
  let report;
  let advice;
  try {
    report = run.analyzer.finish(endedAt, transcriptText);
    if (transcriptText && !report.transcriptMetrics && run.engine.analyzeTranscript) {
      report = { ...report, transcriptMetrics: run.engine.analyzeTranscript(transcriptText, endedAt) };
    }
    report = { ...report, stopReason: reason };
    advice = run.engine.buildAdvice(report);
  } catch (error) {
    run.transcript = "";
    stopCoachingHardware(run);
    coachingRun = null;
    practice = freshPracticeState(practice.setup);
    practice.error = "This attempt could not be analyzed. Please calibrate and try again.";
    if (isPracticeRoute()) renderPractice();
    throw error;
  }
  practice.report = report;
  practice.advice = advice;
  practice.transcriptUsed = Boolean(report.transcriptMetrics);
  run.transcript = "";
  stopCoachingHardware(run);
  coachingRun = null;
  const summary = buildCoachingSummary(report, advice);
  const artifact = practice.setup.retainArtifacts
    ? buildCoachingArtifact(summary.id, summary.createdAt, audioBlob, transcriptText, transcriptMayBePartial)
    : null;
  if (practice.setup.retainArtifacts && !artifact) {
    practice.artifactWarning ||= "No full recording or transcript artifact was available to save for this attempt.";
  }
  summary.artifacts = artifactMetadata(artifact);
  try {
    await saveCoachingSession(summary, artifact);
    practice.saved = true;
    practice.artifactSaved = Boolean(artifact);
    practice.savedArtifacts = summary.artifacts;
  } catch {
    practice.saved = false;
    practice.artifactSaved = false;
    practice.savedArtifacts = null;
    practice.artifactWarning ||= "This browser could not save the local coaching record.";
  }
  if (practice.setup.cloudSync) {
    try {
      await cloudProgress.save(summary);
      practice.cloudSaved = true;
    } catch {
      practice.cloudSaved = false;
      practice.artifactWarning ||= "The compact summary was saved locally, but its optional online backup did not complete.";
    }
  }
  if (/^\/progress\/?$/i.test(location.pathname)) {
    await renderProgress(routeGeneration);
    return;
  }
  if (!isPracticeRoute()) return;
  practice.phase = "review";
  renderPractice();
  announce("Your attempt review is ready.");
}

function stopCoachingLifecycle() {
  pendingCoachingToken = null;
  const run = coachingRun;
  if (run) stopCoachingHardware(run);
  coachingRun = null;
  if (practice.phase === "permission" || practice.phase === "calibrating" || practice.phase === "active" || practice.phase === "finishing") {
    practice = freshPracticeState(practice.setup);
  }
}

function handleCoachingInputEnded(run) {
  if (run !== coachingRun) return;
  if (practice.phase === "active") {
    practice.artifactWarning ||= "Microphone input ended before the selected duration.";
    finishCoachingSession("input-ended").catch((error) => showToast(error.message));
    return;
  }
  if (practice.phase === "permission" || practice.phase === "calibrating") {
    failCoachingRun(run, "Microphone input ended before calibration completed. Check the input and try again.");
  }
}

function failCoachingRun(run, message) {
  if (run !== coachingRun) return;
  stopCoachingLifecycle();
  practice.phase = "setup";
  practice.error = message;
  if (isPracticeRoute()) renderPractice();
  announce(message);
}

function stopCoachingHardware(run) {
  clearInterval(run.updateTimer);
  clearInterval(run.fallbackTimer);
  clearTimeout(run.calibrationTimer);
  clearTimeout(run.attemptTimer);
  run.inputTrack?.removeEventListener?.("ended", run.inputEndedHandler);
  run.recognition?.abort?.();
  if (run.recorder) {
    run.discardRecording = true;
    run.recordedChunks?.splice(0);
    run.recorder.ondataavailable = null;
    try { if (run.recorder.state !== "inactive") run.recorder.stop(); } catch { /* The recorder is already stopping. */ }
    run.recorder = null;
  }
  run.meterNode?.port?.close?.();
  run.stream?.getTracks().forEach((track) => track.stop());
  if (run.context?.state !== "closed") run.context?.close().catch(() => {});
}

function updateCoachingUI() {
  const run = coachingRun;
  if (!run) return;
  if (practice.phase === "calibrating") {
    const elapsed = performance.now() - run.calibrationStartedAt;
    const bar = document.querySelector("[data-coach-calibration-bar]");
    if (bar) bar.style.width = `${Math.min(100, elapsed / 40)}%`;
    return;
  }
  if (practice.phase !== "active" && practice.phase !== "finishing") return;
  const elapsed = Math.min(practice.setup.duration * 1000, Math.max(0, performance.now() - run.startedAt));
  if (practice.live) practice.live.elapsedMs = elapsed;
  const remaining = Math.max(0, practice.setup.duration - Math.floor(elapsed / 1000));
  setText("[data-coach-timer]", remaining);
  const timer = document.querySelector("[data-coach-timer]");
  if (timer) timer.setAttribute("aria-label", `${remaining} seconds remaining`);
  setText("[data-coach-speaking]", formatPercent(practice.live?.speakingRatio));
  setText("[data-coach-pauses]", practice.live?.pauseCount ?? 0);
  setText("[data-coach-level]", levelLabel(practice.live?.level));
  const meter = document.querySelector("[data-coach-meter]");
  if (meter) meter.style.width = `${Math.round((practice.live?.level || 0) * 100)}%`;
  const tip = document.querySelector("[data-coach-tip]");
  tip?.classList.toggle("is-visible", Boolean(practice.live?.tip));
  setText("[data-coach-tip-text]", practice.live?.tip?.text || "Listening for a useful pattern…");
  setText("[data-coach-tip-evidence]", practice.live?.tip?.evidence || "Tips appear only when the signal is consistent.");
}

function loadCoachEngine() {
  coachEnginePromise ||= import("./coach-engine.js");
  return coachEnginePromise;
}

function snapshotToLive(snapshot = {}, elapsedMs = 0, level = 0, tip = null) {
  return {
    elapsedMs,
    level,
    speakingRatio: Number(snapshot.speakingRatio) || 0,
    pauseCount: Number(snapshot.pauseCount) || 0,
    tip,
  };
}

function normalizeTip(candidate, snapshot) {
  if (!candidate) return null;
  if (typeof candidate === "string") return { text: candidate, evidence: tipEvidence(snapshot) };
  const text = candidate.text || candidate.message || candidate.tip;
  if (!text) return null;
  return { text: String(text), evidence: String(candidate.evidence || tipEvidence(snapshot)) };
}

function tipEvidence(snapshot = {}) {
  if (Number.isFinite(snapshot.longestSpeakingRunMs) && snapshot.longestSpeakingRunMs > 8_000) return `${formatDuration(snapshot.longestSpeakingRunMs)} without a reset pause.`;
  if (Number.isFinite(snapshot.clippingPct) && snapshot.clippingPct > 0) return `${formatNumber(snapshot.clippingPct)}% of frames reached the clipping range.`;
  return `Based on ${formatDuration(snapshot.durationMs || snapshot.elapsedMs || 0)} of stable signal.`;
}

function normalizedCoachLevel(rms, calibration = {}) {
  const quiet = Number(calibration.quietRms ?? calibration.noiseFloor ?? 0.01);
  const voice = Number(calibration.voiceRms ?? calibration.speechLevel ?? Math.max(.05, quiet * 4));
  return clamp((rms - quiet) / Math.max(.015, voice - quiet), 0, 1);
}

function normalizedAdvice(value = {}, report = {}) {
  const strength = Array.isArray(value.strengths) ? value.strengths[0] : value.strength;
  const priority = Array.isArray(value.priorities) ? value.priorities[0] : value.focus;
  const drill = value.nextAttempt || priority?.drill || value.drill;
  return {
    strength: strength?.title || (typeof strength === "string" ? strength : "") || "You completed a focused attempt.",
    strengthEvidence: strength?.evidence || strength?.message || value.strengthEvidence || `${formatPercent(report.speakingRatio)} of the attempt contained speech.`,
    focus: priority?.title || (typeof priority === "string" ? priority : "") || "Make the next attempt more deliberate.",
    focusEvidence: priority?.evidence || priority?.message || value.focusEvidence || `${report.pauseCount ?? 0} pauses were measured in this attempt.`,
    drill: drill?.title || "Retry with one change.",
    drillDetail: drill?.detail || drill?.message || drill?.instruction || (typeof drill === "string" ? drill : "") || value.drillDetail || "Repeat the same prompt and place one full breath between your main ideas.",
  };
}

function buildCoachingSummary(report, advice) {
  const normalized = normalizedAdvice(advice, report);
  return {
    analysisSchemaVersion: 2,
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    scenario: practice.setup.scenario,
    goal: practice.setup.goal,
    targetDurationMs: practice.setup.duration * 1000,
    metrics: {
      durationMs: finiteNumber(report.durationMs), voicedMs: finiteNumber(report.voicedMs),
      speakingRatio: finiteNumber(report.speakingRatio), pauseCount: finiteNumber(report.pauseCount),
      observedDurationMs: finiteNumber(report.observedDurationMs), unknownMs: finiteNumber(report.unknownMs),
      coverageRatio: finiteNumber(report.coverageRatio), maxSampleGapMs: finiteNumber(report.continuity?.maxSampleGapMs),
      medianPauseMs: finiteNumber(report.medianPauseMs), longestPauseMs: finiteNumber(report.longestPauseMs),
      longestSpeakingRunMs: finiteNumber(report.longestSpeakingRunMs), levelConsistencyPct: finiteNumberOrNull(report.levelConsistencyPct),
      clippingPct: finiteNumber(report.clippingPct), audioConfidence: String(report.audioConfidence || "unknown"),
      transcriptMetrics: sanitizeTranscriptMetrics(report.transcriptMetrics),
    },
    advice: normalized,
  };
}

function buildCoachingArtifact(id, createdAt, audioBlob, transcriptText, transcriptMayBePartial = false) {
  const transcript = typeof transcriptText === "string" ? transcriptText.trim() : "";
  if (!(audioBlob instanceof Blob) && !transcript) return null;
  return {
    id,
    createdAt,
    audioBlob: audioBlob instanceof Blob ? audioBlob : null,
    audioMimeType: audioBlob instanceof Blob ? audioBlob.type || "audio/webm" : "",
    transcript,
    transcriptMayBePartial: Boolean(transcript && transcriptMayBePartial),
  };
}

function artifactMetadata(artifact) {
  return {
    audioStored: Boolean(artifact?.audioBlob),
    audioBytes: finiteNumber(artifact?.audioBlob?.size),
    audioMimeType: String(artifact?.audioMimeType || ""),
    transcriptStored: Boolean(artifact?.transcript),
    transcriptMayBePartial: Boolean(artifact?.transcript && artifact?.transcriptMayBePartial),
  };
}

function sanitizeTranscriptMetrics(metrics) {
  if (!metrics) return null;
  return {
    wordCount: finiteNumber(metrics.wordCount), wordsPerMinute: finiteNumber(metrics.wordsPerMinute),
    fillerCount: finiteNumber(metrics.fillerCount), repeatedWordCount: finiteNumber(metrics.repeatedWordCount),
    fillerRatePer100Words: finiteNumber(metrics.fillerRatePer100Words),
    repetitionRatePer100Words: finiteNumber(metrics.repetitionRatePer100Words),
    fillerOccurrences: sanitizeWordPatterns(metrics.fillerOccurrences, "phrase"),
    repeatedWords: sanitizeWordPatterns(metrics.repeatedWords, "word"),
  };
}

function sanitizeWordPatterns(items, key) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 50).flatMap((item) => {
    const label = typeof item?.[key] === "string" ? item[key].trim().slice(0, 64) : "";
    return label ? [{ [key]: label, count: finiteNumber(item.count) }] : [];
  });
}

function finiteNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function finiteNumberOrNull(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
}

function localSpeechCapability() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return { supported: false, reason: "On-device transcription is unavailable here; acoustic coaching still works." };
  try {
    const probe = new Recognition();
    const supported = "processLocally" in probe;
    probe.abort?.();
    return supported
      ? { supported: true, reason: "Available" }
      : { supported: false, reason: "This browser cannot guarantee local-only transcription; it remains off." };
  } catch {
    return { supported: false, reason: "On-device transcription could not be initialized; acoustic coaching still works." };
  }
}

function scenarioById(id) { return PRACTICE_SCENARIOS.find((item) => item.id === id) || PRACTICE_SCENARIOS[0]; }
function goalById(id) { return PRACTICE_GOALS.find((item) => item.id === id) || PRACTICE_GOALS[0]; }
function isPracticeRoute() { return /^\/practice\/?$/i.test(location.pathname); }
function setText(selector, value) { const element = document.querySelector(selector); if (element) element.textContent = String(value); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function formatPercent(value) { return `${Math.round(clamp(Number(value) || 0, 0, 1) * 100)}%`; }
function formatNumber(value) { return Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : "0"; }
function formatOptionalPercentage(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${Math.round(Number(value))}%`; }
function formatTranscriptPatternSummary(metrics = {}) {
  const fillerCount = finiteNumber(metrics.fillerCount);
  const repeatedCount = finiteNumber(metrics.repeatedWordCount);
  const patterns = [
    ...(Array.isArray(metrics.fillerOccurrences) ? metrics.fillerOccurrences.map((item) => item?.phrase) : []),
    ...(Array.isArray(metrics.repeatedWords) ? metrics.repeatedWords.map((item) => item?.word) : []),
  ].filter((value) => typeof value === "string" && value.trim()).slice(0, 3);
  const counts = `${fillerCount} possible filler ${fillerCount === 1 ? "marker" : "markers"} and ${repeatedCount} immediate ${repeatedCount === 1 ? "repetition" : "repetitions"}.`;
  return patterns.length ? `${counts} Retained patterns: ${patterns.join(", ")}.` : counts;
}
function formatDuration(milliseconds) { return `${(Math.max(0, Number(milliseconds) || 0) / 1000).toFixed(milliseconds >= 10_000 ? 0 : 1)}s`; }
function levelLabel(value) { return value > .92 ? "High" : value > .35 ? "Clear" : "Low"; }
function confidenceLabel(value) { const text = String(value || "unknown"); return `${text.charAt(0).toUpperCase()}${text.slice(1)} signal confidence`; }
function microphoneErrorMessage(error) {
  if (error?.name === "NotAllowedError") return "Microphone permission was denied. Allow access in your browser settings, then try again.";
  if (error?.name === "NotFoundError") return "No microphone was found. Connect one and try again.";
  return error?.message || "The microphone could not be started.";
}

async function renderProgress(generation = routeGeneration) {
  app.innerHTML = `<section class="loading-card" role="status">Loading private progress…</section>`;
  let localSummaries = [];
  let cloudSummaries = [];
  let storageError = "";
  let cloudError = "";
  try {
    localSummaries = await readCoachingSummariesWithRetry();
  } catch {
    storageError = "Local progress storage is unavailable in this browser.";
  }
  const cloudEnabled = cloudProgress.isEnabled();
  if (cloudEnabled) {
    try {
      cloudSummaries = await cloudProgress.list();
    } catch {
      cloudError = "Online summary backup is temporarily unavailable. Your local history is still shown.";
    }
  }
  if (generation !== routeGeneration || !/^\/progress\/?$/i.test(location.pathname)) return;
  const summaries = mergeCoachingSummaries(localSummaries, cloudSummaries);
  progressSessions = summaries;
  const ratios = summaries.map(progressSpeakingRatio).filter((value) => value !== null);
  const averageRatio = ratios.length ? ratios.reduce((total, value) => total + value, 0) / ratios.length : null;
  const latest = summaries[0];
  const earlier = summaries[1];
  const latestRatio = progressSpeakingRatio(latest);
  const earlierRatio = progressSpeakingRatio(earlier);
  const change = latestRatio !== null && earlierRatio !== null ? latestRatio - earlierRatio : null;
  app.innerHTML = `
    <section class="progress-page" data-coach-progress>
      <div class="progress-hero">
        <div><p class="eyebrow">Private progress</p><h1>Your baseline, not a leaderboard.</h1><p class="lede">Track patterns against your own previous attempts. Summaries stay in this browser unless you explicitly enable compact online backup.</p></div>
        <a class="button primary" href="/practice" data-route>New practice</a>
      </div>
      ${storageError ? notice(storageError, true) : ""}
      ${cloudError ? notice(cloudError, true) : ""}
      <div class="progress-metrics">
        ${reviewMetric(String(summaries.length), `${summaries.length === 1 ? "attempt" : "attempts"} for this site`)}
        ${reviewMetric(averageRatio === null ? "—" : formatPercent(averageRatio), "average speaking ratio")}
        ${reviewMetric(change === null ? "—" : `${change >= 0 ? "+" : ""}${Math.round(change * 100)} pts`, "latest ratio shift")}
      </div>
      <section class="panel progress-history">
        <div class="section-head"><div><p class="eyebrow">Attempt history</p><h2>Evidence you can explain</h2></div><span>${summaries.length}</span></div>
        ${summaries.length ? `<div class="attempt-list">${summaries.map(renderProgressItem).join("")}</div>` : `<div class="empty-progress"><h2>No attempts yet.</h2><p>Complete a practice session and its metric summary will appear here.</p><a class="button" href="/practice" data-route>Build a baseline</a></div>`}
      </section>
      <section class="storage-controls">
        <div><h2>Your data, your controls.</h2><p class="hint">JSON exports contain metrics, advice, and derived word patterns. Opted-in recordings and captured transcripts always stay in the separate local artifact store.${cloudEnabled ? " Compact online backup is enabled for summaries you choose to sync." : " Online backup is off. You can explicitly check for a prior anonymous backup if this browser's preference was cleared."}</p></div>
        <div class="action-row">${cloudEnabled ? "" : `<button class="button ghost" type="button" data-command="coach-check-cloud">Check online backups</button>`}<button class="button ghost" type="button" data-command="coach-export" ${summaries.length ? "" : "disabled"}>Export JSON</button><button class="button danger ghost" type="button" data-command="coach-delete" ${summaries.length || cloudEnabled ? "" : "disabled"}>${cloudEnabled ? summaries.length ? "Delete local + cloud history" : "Disable online backup" : "Delete local history"}</button></div>
      </section>
    </section>`;
}

function progressSpeakingRatio(item) {
  const value = item?.metrics?.speakingRatio;
  if (!(["number", "string"].includes(typeof value)) || (typeof value === "string" && !value.trim())) return null;
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : null;
}

function renderProgressItem(item) {
  const scenario = scenarioById(item.scenario);
  const goal = goalById(item.goal);
  const metrics = item.metrics || {};
  return `<article class="attempt-row">
    <div><time datetime="${escapeHTML(item.createdAt)}">${escapeHTML(formatAttemptDate(item.createdAt))}</time><h3>${escapeHTML(scenario.name)}</h3><p>${escapeHTML(goal.name)}</p></div>
    <div class="attempt-numbers"><span><strong>${formatPercent(metrics.speakingRatio)}</strong> speaking</span><span><strong>${metrics.pauseCount ?? 0}</strong> pauses</span><span><strong>${formatDuration(metrics.durationMs)}</strong> analyzed</span></div>
    <div class="attempt-focus"><span>Next focus</span><p>${escapeHTML(item.advice?.focus || "Repeat and compare your delivery.")}</p>${renderArtifactActions(item)}</div>
  </article>`;
}

function renderArtifactActions(item) {
  const artifacts = item.artifacts || {};
  if (!artifacts.audioStored && !artifacts.transcriptStored) return "";
  const id = escapeHTML(item.id);
  return `<div class="artifact-actions" aria-label="Saved full session artifacts">
    ${artifacts.audioStored ? `<button class="button ghost small" type="button" data-command="coach-download-audio" data-session-id="${id}">Download recording</button>` : ""}
    ${artifacts.transcriptStored ? `<button class="button ghost small" type="button" data-command="coach-download-transcript" data-session-id="${id}">Download transcript</button>` : ""}
    ${artifacts.transcriptMayBePartial ? `<p class="hint">Captured transcript may be partial; local recognition did not finalize cleanly.</p>` : ""}
  </div>`;
}

function formatAttemptDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

const COACH_DB_NAME = "nonstoptalk-coaching";
const COACH_STORE = "session-summaries";
const COACH_ARTIFACT_STORE = "session-artifacts";
const COACH_DB_VERSION = 2;

function openCoachDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = indexedDB.open(COACH_DB_NAME, COACH_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(COACH_STORE)) {
        const store = database.createObjectStore(COACH_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!database.objectStoreNames.contains(COACH_ARTIFACT_STORE)) {
        const store = database.createObjectStore(COACH_ARTIFACT_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => fail(request.error || new Error("Could not open coaching history"));
    request.onblocked = () => fail(new Error("A previous NonStopTalk tab is blocking the coaching storage upgrade."));
  });
}

async function withCoachTransaction(storeNames, mode, callback) {
  const database = await openCoachDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeNames, mode);
      let result;
      try { result = callback(transaction); } catch (error) { reject(error); return; }
      const isRequest = typeof IDBRequest === "function" && result instanceof IDBRequest;
      transaction.oncomplete = () => resolve(isRequest ? result.result : result);
      transaction.onerror = () => reject(transaction.error || new Error("Coaching history operation failed"));
      transaction.onabort = () => reject(transaction.error || new Error("Coaching history operation was cancelled"));
    });
  } finally {
    database.close();
  }
}

function withCoachStore(storeName, mode, callback) {
  return withCoachTransaction([storeName], mode, (transaction) => callback(transaction.objectStore(storeName)));
}

function saveCoachingSession(summary, artifact) {
  const stores = artifact ? [COACH_STORE, COACH_ARTIFACT_STORE] : [COACH_STORE];
  return withCoachTransaction(stores, "readwrite", (transaction) => {
    transaction.objectStore(COACH_STORE).put(summary);
    if (artifact) transaction.objectStore(COACH_ARTIFACT_STORE).put(artifact);
  });
}

function readCoachingSummaries() {
  return withCoachStore(COACH_STORE, "readonly", (store) => store.getAll());
}

function readCoachingArtifact(id) {
  return withCoachStore(COACH_ARTIFACT_STORE, "readonly", (store) => store.get(id));
}

async function readCoachingSummariesWithRetry() {
  try {
    return await readCoachingSummaries();
  } catch {
    // A document reload can briefly abort an IndexedDB open while the prior
    // page's connection is closing. One bounded retry preserves local history
    // without hiding a persistent storage error.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return readCoachingSummaries();
  }
}

function clearCoachingSummaries() {
  return withCoachTransaction([COACH_STORE, COACH_ARTIFACT_STORE], "readwrite", (transaction) => {
    transaction.objectStore(COACH_STORE).clear();
    transaction.objectStore(COACH_ARTIFACT_STORE).clear();
  });
}

async function exportCoachingSummaries() {
  const sessions = /^\/progress\/?$/i.test(location.pathname) && progressSessions.length
    ? progressSessions
    : await readCoachingSummaries();
  const payload = JSON.stringify({
    product: "NonStopTalk",
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    privacy: "Coaching metrics, advice, and consented derived word patterns; no audio or captured transcript text.",
    sessions,
  }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `nonstoptalk-progress-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast(`${sessions.length} coaching ${sessions.length === 1 ? "summary" : "summaries"} exported.`);
}

async function downloadCoachingArtifact(id, kind) {
  const artifact = await readCoachingArtifact(String(id || ""));
  if (!artifact) throw new Error("That saved session artifact is unavailable.");
  let blob;
  let extension;
  if (kind === "audio") {
    if (!(artifact.audioBlob instanceof Blob)) throw new Error("This session has no saved recording.");
    blob = artifact.audioBlob;
    extension = audioFileExtension(artifact.audioMimeType || artifact.audioBlob.type);
  } else {
    if (!artifact.transcript) throw new Error("This session has no saved full transcript.");
    blob = new Blob([artifact.transcript], { type: "text/plain;charset=utf-8" });
    extension = "txt";
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `nonstoptalk-${kind}-${String(artifact.createdAt || "session").slice(0, 10)}-${String(artifact.id).slice(0, 8)}.${extension}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast(`${kind === "audio" ? "Recording" : "Transcript"} download started.`);
}

function audioFileExtension(mimeType = "") {
  const value = String(mimeType).toLowerCase();
  if (value.includes("ogg")) return "ogg";
  if (value.includes("mp4") || value.includes("aac")) return "m4a";
  if (value.includes("wav")) return "wav";
  return "webm";
}

function renderRoom() {
  if (!room) return;
  reconcileController();
  const viewer = room.viewer;
  const current = room.players[room.currentPlayer];
  const header = `
    <section class="room-head">
      <div>
        <p class="eyebrow">Room code</p>
        <div class="room-code">${escapeHTML(room.code)}</div>
      </div>
      <div class="action-row">
        <button class="button ghost small" type="button" data-command="copy-room">Copy invite</button>
        <a class="button ghost small" href="/" data-home>Home</a>
      </div>
    </section>`;

  if (!viewer.isMember) {
    app.innerHTML = `${header}
      <section class="panel stack" style="max-width:34rem;margin:2rem auto">
        <p class="eyebrow">Join ${escapeHTML(room.code)}</p>
        <h1 style="font-size:clamp(2.2rem,8vw,4.5rem)">Take a seat.</h1>
        <p class="room-meta">${room.players.length} of ${room.maxPlayers} seats are currently filled.</p>
        ${room.phase === "setup" ? `<form class="stack" data-join-current-room>
          <label>Your name <input name="name" maxlength="40" autocomplete="nickname" required autofocus></label>
          <button class="button primary" type="submit">Join room</button>
        </form>` : `<div class="notice info">A game is already in progress. Ask the host to start a new game before joining.</div>`}
      </section>`;
    return;
  }

  const claim = viewer.canClaimHost
    ? `<div class="notice info">The host disconnected. <button class="button small" data-command="claim-host">Claim host controls</button></div>`
    : viewer.hostDisconnected
      ? `<div class="notice info">The host disconnected. Host controls can be claimed shortly.</div>`
      : "";
  const content = room.phase === "setup"
    ? renderSetup()
    : room.phase === "finished"
      ? renderWinner()
      : renderGame(current);
  app.innerHTML = `${header}${claim}${content}`;
  updateClock();
}

function renderSetup() {
  const viewer = room.viewer;
  const selectedPack = room.topicPacks.find((pack) => pack.id === room.settings.topicPack);
  return `
    <section class="room-grid">
      <div class="panel">
        <div class="section-head"><div><p class="eyebrow">Lobby</p><h2>Players</h2></div><span>${room.players.length}/${room.maxPlayers}</span></div>
        <div class="player-list">${room.players.map(renderPlayer).join("") || `<p class="hint">No players yet.</p>`}</div>
        ${viewer.isHost ? `
          <form class="inline" data-room-action>
            <input type="hidden" name="type" value="add-player">
            <label>Local player <input name="name" maxlength="40" placeholder="Add someone on this screen"></label>
            <button class="button" type="submit">Add</button>
          </form>` : ""}
      </div>
      <aside class="panel">
        <div class="section-head"><div><p class="eyebrow">Scoreboard</p><h2>Starting line</h2></div></div>
        ${renderScores(false)}
        ${viewer.playerId ? `<form data-room-action><input type="hidden" name="type" value="leave"><button class="button ghost danger" type="submit">Leave room</button></form>` : ""}
      </aside>
      <div class="panel wide">
        <div class="section-head"><div><p class="eyebrow">Game setup</p><h2>${escapeHTML(selectedPack?.name || "Custom topics")}</h2></div><span>${room.topicCount} topics</span></div>
        ${viewer.isHost ? renderHostSettings() : renderSettingsSummary()}
      </div>
      ${viewer.isHost ? `
        <div class="panel wide">
          <div class="section-head"><div><p class="eyebrow">Topic generator</p><h2>Turn a theme into a draft</h2></div><span>Optional</span></div>
          <form class="stack" data-model-topics>
            <div class="topic-model-fields">
              <label>Theme
                <input name="theme" maxlength="200" autocomplete="off" placeholder="Example: strange inventions at a school science fair" required>
              </label>
              <label>Model tier
                <select name="tier">
                  <option value="routine">Routine · operator-selected GLM Flash when enabled</option>
                  <option value="escalated">Escalated · Gemma 4 31B when enabled</option>
                </select>
              </label>
            </div>
            <fieldset class="consent-card">
              <legend>One-request external processing consent</legend>
              <label class="choice-row">
                <input type="checkbox" name="externalConsent">
                <span><strong>Allow this theme to be sent for this generation request</strong><small>If the selected external provider is enabled, the normalized theme above is the only host or room content sent, alongside fixed generation instructions and settings. NonStopTalk never sends room names, tokens, audio, or transcript text. Provider policies differ: Google currently says Gemma 4 free-tier content may be used to improve its products. Leave this unchecked to prevent external contact; an externally configured request will be declined.</small></span>
              </label>
            </fieldset>
            <div class="action-row topic-model-actions"><button class="button" type="submit">Generate editable draft</button><p class="hint">Routine and escalated providers are separately configured by the site operator. One provider attempt at most; failures fall back to deterministic topics.</p></div>
          </form>
        </div>
        <div class="panel wide">
          <div class="section-head"><div><p class="eyebrow">Topic editor</p><h2>Custom list</h2></div><span>One per line</span></div>
          <form class="stack" data-room-action>
            <input type="hidden" name="type" value="custom-topics">
            <textarea name="topics" rows="7" maxlength="20000">${escapeHTML(room.topics.join("\n"))}</textarea>
            <div class="action-row" style="justify-content:flex-start"><button class="button" type="submit">Use custom list</button></div>
          </form>
        </div>
        <div class="panel wide action-row">
          <div><p class="eyebrow">Ready?</p><h2>${room.settings.duration}s to survive · ${room.settings.silence}s silence limit</h2></div>
          <button class="button primary" type="button" data-command="start-game">Start game</button>
        </div>` : `<div class="panel wide"><p class="hint">Waiting for the host to start the game.</p></div>`}
      ${renderHistory()}
    </section>`;
}

function renderPlayer(player, index) {
  const viewer = room.viewer;
  const canRename = viewer.isHost || viewer.playerId === player.id;
  const isYou = viewer.playerId === player.id;
  return `<div class="player-row">
    <div style="min-width:0;flex:1">
      ${canRename ? `<form class="inline" data-room-action>
        <input type="hidden" name="type" value="rename-player">
        <input type="hidden" name="playerId" value="${escapeHTML(player.id)}">
        <input name="name" maxlength="40" value="${escapeHTML(player.name)}" aria-label="Rename ${escapeHTML(player.name)}">
        <button class="button small" type="submit">Save</button>
      </form>` : `<span class="player-name">${escapeHTML(player.name)}</span>`}
      <div class="hint"><span class="presence ${player.online ? "online" : ""}">●</span> ${player.online ? "online" : "offline"}${isYou ? ` · <span class="you">you</span>` : ""}</div>
    </div>
    ${viewer.isHost ? `<div class="player-tools">
      ${index > 0 ? actionButton("move-player", "↑", { playerId: player.id, offset: -1 }, `Move ${player.name} up`) : ""}
      ${index < room.players.length - 1 ? actionButton("move-player", "↓", { playerId: player.id, offset: 1 }, `Move ${player.name} down`) : ""}
      ${player.online && !isYou ? actionButton("transfer-host", "Make host", { playerId: player.id }, `Make ${player.name} the host`) : ""}
      ${actionButton("remove-player", "×", { playerId: player.id }, `Remove ${player.name}`, "danger")}
    </div>` : ""}
  </div>`;
}

function renderHostSettings() {
  return `<form class="settings" data-room-action>
    <input type="hidden" name="type" value="settings">
    <label>Talk time (seconds)<input name="duration" type="number" min="10" max="300" value="${room.settings.duration}"></label>
    <label>Silence limit<input name="silence" type="number" min="1" max="10" value="${room.settings.silence}"></label>
    <label>Rounds<input name="rounds" type="number" min="1" max="10" value="${room.settings.rounds}"></label>
    <label class="pack">Topic pack<select name="topicPack">${room.settings.topicPack === "custom" ? `<option value="custom" selected>Custom · your list</option>` : ""}${room.topicPacks.map((pack) => `<option value="${pack.id}" ${pack.id === room.settings.topicPack ? "selected" : ""}>${escapeHTML(pack.name)} · ${escapeHTML(pack.difficulty)}</option>`).join("")}</select></label>
    <button class="button" type="submit">Apply settings</button>
    <p class="hint wide">The free online edition uses classic scoring. The optional AI judge remains available in the local Go edition.</p>
  </form>`;
}

function renderSettingsSummary() {
  return `<div class="grid">
    <div><p class="hint">Talk time</p><strong>${room.settings.duration}s</strong></div>
    <div><p class="hint">Silence limit</p><strong>${room.settings.silence}s</strong></div>
    <div><p class="hint">Rounds</p><strong>${room.settings.rounds}</strong></div>
    <div><p class="hint">Scoring</p><strong>Classic</strong></div>
  </div>`;
}

function renderGame(current) {
  const turn = room.activeTurn;
  const viewer = room.viewer;
  const canStart = viewer.isHost || viewer.playerId === current?.id;
  if (!turn) {
    const last = room.lastTurn;
    return `<section class="room-grid">
      <div class="panel wide" style="text-align:center;padding:clamp(2rem,7vw,6rem)">
        ${last ? `<p class="eyebrow">Turn scored</p><div class="score-callout">${escapeHTML(last.playerName)} earned ${last.score} points</div><p class="hint">${last.spokenSeconds} of ${last.duration} seconds${last.completed ? ` · ${room.completionBonus}-point completion bonus` : ""}</p>` : `<p class="eyebrow">Round ${room.currentRound}</p><h1 style="max-width:none;font-size:clamp(2.5rem,8vw,6rem)">${escapeHTML(current?.name || "Next player")} is up.</h1>`}
        ${canStart ? `<button class="button primary" type="button" data-command="start-turn">${last ? "Next turn" : "Draw topic"}</button>` : `<p class="hint">Waiting for ${escapeHTML(current?.name || "the next player")} or the host.</p>`}
      </div>
      <aside class="panel wide"><div class="section-head"><h2>Scoreboard</h2><span>${room.completedTurns.length} turns</span></div>${renderScores(true)}</aside>
    </section>`;
  }

  const isDriver = viewer.isHost || viewer.playerId === turn.playerId;
  const remaining = remainingSeconds(turn);
  return `<section class="room-grid">
    <div class="turn-card">
      <div class="turn-meta"><span>Round ${turn.round} of ${room.settings.rounds}</span><span>${escapeHTML(turn.playerName)}${viewer.playerId === turn.playerId ? " (you)" : ""}</span></div>
      <p class="eyebrow" style="margin-top:2rem">Topic</p>
      <h1>${escapeHTML(turn.topic)}</h1>
      <div class="timer" data-timer>${remaining}</div>
      <div class="meter" aria-hidden="true"><span data-meter></span></div>
      <p class="hint" data-voice>${turn.begunAt === null ? `Silence limit: ${turn.silence}s` : `${escapeHTML(turn.playerName)} is speaking`}</p>
      ${isDriver ? renderTurnControls(turn) : `<p class="hint">The score arrives when the turn ends.</p>`}
    </div>
    <aside class="panel"><div class="section-head"><h2>Scoreboard</h2><span>${room.completedTurns.length} turns</span></div>${renderScores(true)}</aside>
  </section>`;
}

function renderTurnControls(turn) {
  if (turn.begunAt === null) {
    return `<div class="action-row">
      <button class="button primary" type="button" data-command="start-mic">Start with microphone</button>
      <button class="button" type="button" data-command="start-manual">Manual timer</button>
      <button class="button ghost" type="button" data-command="redraw">Redraw topic</button>
      ${room.viewer.isHost ? `<button class="button ghost" type="button" data-command="mark-complete">Mark complete</button>` : ""}
    </div>`;
  }
  const runningLocally = controller?.turnId === turn.id;
  return `<div class="action-row">
    ${runningLocally ? "" : `<button class="button" type="button" data-command="resume-mic">Resume microphone</button><button class="button" type="button" data-command="resume-manual">Resume manual</button>`}
    <button class="button ghost" type="button" data-command="end-turn">End turn</button>
    ${room.viewer.isHost ? `<button class="button ghost" type="button" data-command="mark-complete">Mark complete</button>` : ""}
  </div>`;
}

function renderWinner() {
  return `<section class="winner">
    <p class="eyebrow">Winner</p>
    <h1>${escapeHTML(room.winner?.name || "Game over")}</h1>
    <p class="score-callout">${room.winner?.score ?? 0} points</p>
    <div style="max-width:34rem;margin:2rem auto">${renderScores(true)}</div>
    ${room.viewer.isHost ? `<button class="button primary" type="button" data-command="reset">Play again</button>` : `<p class="hint">Waiting for the host to set up another game.</p>`}
  </section>`;
}

function renderScores(withTools) {
  return `<div class="score-list">${room.standings.map((player, index) => `<div class="score-row">
    <span><strong>${index + 1}. ${escapeHTML(player.name)}</strong>${room.viewer.playerId === player.id ? ` <span class="you">you</span>` : ""}</span>
    <span>${player.score} pts</span>
    ${withTools && room.viewer.isHost ? `<span>${actionButton("score", "−5", { playerId: player.id, delta: -5 }, `Remove 5 points from ${player.name}`)} ${actionButton("score", "+5", { playerId: player.id, delta: 5 }, `Add 5 points to ${player.name}`)}</span>` : ""}
  </div>`).join("")}</div>`;
}

function renderHistory() {
  if (!room.history.length) return "";
  return `<div class="panel wide"><div class="section-head"><h2>Game history</h2><span>${room.history.length}</span></div><div class="history">${[...room.history].reverse().map((record) => `<div class="history-item"><strong>${escapeHTML(record.standings[0]?.name || "Nobody")} won</strong> · ${record.turns} turns · ${new Date(record.finishedAt).toLocaleString()}</div>`).join("")}</div></div>`;
}

function actionButton(type, label, values, aria, extraClass = "") {
  return `<button class="button small icon ${extraClass}" type="button" data-command="action" data-action-type="${escapeHTML(type)}" data-action-values="${escapeHTML(JSON.stringify(values))}" aria-label="${escapeHTML(aria)}">${escapeHTML(label)}</button>`;
}

async function handleSubmit(event) {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();
  if (busy) return;
  const values = Object.fromEntries(new FormData(form));
  try {
    setBusy(true);
    if (form.matches("[data-coach-setup]")) {
      beginCoachingSession(values).catch((error) => showToast(error.message));
    } else if (form.matches("[data-create-room]")) {
      const payload = await api("/api/rooms", { name: values.name }, "POST");
      navigate(`/room/${payload.room.code}`);
    } else if (form.matches("[data-join-room]")) {
      const code = String(values.code || "").trim().toUpperCase();
      if (!ROOM_CODE_PATTERN.test(code)) throw new Error("Enter a valid six-character room code.");
      await api(`/api/rooms/${code}/join`, { name: values.name }, "POST");
      navigate(`/room/${code}`);
    } else if (form.matches("[data-join-current-room]")) {
      const payload = await api(`/api/rooms/${roomCode}/join`, { name: values.name }, "POST");
      acceptRoom(payload.room);
    } else if (form.matches("[data-model-topics]")) {
      const code = roomCode;
      const generation = routeGeneration;
      const externalConsent = values.externalConsent === "on";
      const consentControl = form.querySelector('input[name="externalConsent"]');
      if (consentControl) consentControl.checked = false;
      const payload = await api("/api/v1/models/topics", {
        roomCode: code,
        theme: String(values.theme || "").trim(),
        tier: values.tier === "escalated" ? "escalated" : "routine",
        externalConsent,
      }, "POST");
      if (code !== roomCode || generation !== routeGeneration || room?.phase !== "setup" || !room?.viewer.isHost) return;
      if (!Number.isSafeInteger(payload.topicGeneration) || payload.topicGeneration < 1) {
        throw new Error("The generated topic draft could not be safely applied.");
      }
      await doAction({
        type: "custom-topics",
        topics: payload.topics,
        topicGeneration: payload.topicGeneration,
      });
      const externalName = payload.externalProvider === "gemma31"
        ? "Gemma 4 31B"
        : payload.externalModel === "glm-5.3-flash"
          ? "GLM 5.3 Flash"
          : "GLM 4.7 Flash";
      if (payload.external && payload.provider === "offline") {
        showToast(`${externalName} was contacted, but its result failed; ${payload.topics.length} offline topics were applied.`);
      } else {
        const source = payload.external
          ? externalName
          : payload.fallbackCode ? "the offline fallback" : "the offline generator";
        showToast(`${payload.topics.length} editable topics created with ${source}.`);
      }
    } else if (form.matches("[data-room-action]")) {
      await doAction(values);
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function handleClick(event) {
  const routeLink = event.target.closest("[data-route]");
  const isUnmodifiedPrimaryClick = event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  if (routeLink && isUnmodifiedPrimaryClick) {
    event.preventDefault();
    navigate(new URL(routeLink.href, location.href).pathname);
    return;
  }
  const home = event.target.closest("[data-home]");
  if (home) {
    event.preventDefault();
    navigate("/");
    return;
  }
  const button = event.target.closest("[data-command]");
  if (!button || busy) return;
  const command = button.dataset.command;
  try {
    setBusy(true);
    if (command === "copy-room") {
      await navigator.clipboard.writeText(`${location.origin}/room/${room.code}`);
      showToast("Invite link copied.");
    } else if (command === "action") {
      await doAction({ type: button.dataset.actionType, ...JSON.parse(button.dataset.actionValues || "{}") });
    } else if (command === "start-game") {
      await doAction({ type: "start-game" });
    } else if (command === "start-turn") {
      await doAction({ type: "start-turn", afterTurnId: room.lastTurn?.id || "" });
    } else if (command === "start-manual" || command === "resume-manual") {
      await startManual(command === "start-manual");
    } else if (command === "start-mic" || command === "resume-mic") {
      await startMicrophone(command === "start-mic");
    } else if (command === "redraw") {
      const turn = room?.activeTurn;
      if (!turn) return;
      await doAction({ type: "redraw-turn", turnId: turn.id });
    } else if (command === "end-turn") {
      await finishTurn(false, false);
    } else if (command === "mark-complete") {
      const turn = room?.activeTurn;
      if (!turn) return;
      await finishTurn(true, false, turn.duration);
    } else if (command === "reset") {
      await doAction({ type: "reset" });
    } else if (command === "claim-host") {
      await doAction({ type: "claim-host" });
    } else if (command === "coach-cancel") {
      stopCoachingLifecycle();
      practice = freshPracticeState(practice.setup);
      renderPractice();
    } else if (command === "coach-stop") {
      await finishCoachingSession("manual");
    } else if (command === "coach-again") {
      practice = freshPracticeState(practice.setup);
      renderPractice();
      document.querySelector("[data-coach-setup]")?.scrollIntoView({ block: "start" });
    } else if (command === "coach-export") {
      await exportCoachingSummaries();
    } else if (command === "coach-download-audio") {
      await downloadCoachingArtifact(button.dataset.sessionId, "audio");
    } else if (command === "coach-download-transcript") {
      await downloadCoachingArtifact(button.dataset.sessionId, "transcript");
    } else if (command === "coach-check-cloud") {
      const sessions = await cloudProgress.list();
      if (sessions.length) {
        cloudProgress.setEnabled(true);
        await renderProgress(routeGeneration);
        showToast(`${sessions.length} online coaching ${sessions.length === 1 ? "summary" : "summaries"} found.`);
      } else {
        showToast("No online coaching summaries were found for this browser.");
      }
    } else if (command === "coach-delete") {
      const cloudEnabled = cloudProgress.isEnabled();
      const scope = cloudEnabled
        ? "Disable online backup and delete every local coaching summary/artifact plus every compact summary backed up online for this browser?"
        : "Delete every coaching summary, recording, and transcript artifact stored for this NonStopTalk site in this browser profile?";
      if (window.confirm(scope)) {
        if (cloudEnabled) await cloudProgress.clear();
        await clearCoachingSummaries();
        progressSessions = [];
        await renderProgress(routeGeneration);
        showToast(cloudEnabled ? "Online backup disabled; local and online coaching history deleted." : "Local coaching history deleted.");
      }
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function startManual(notifyBegin) {
  const turn = room?.activeTurn;
  if (!turn) return;
  const code = roomCode;
  const generation = routeGeneration;
  if (notifyBegin && turn.begunAt === null) await doAction({ type: "begin-turn", turnId: turn.id });
  if (!isCurrentTurn(code, generation, turn.id)) return;
  stopController();
  controller = { turnId: turn.id, mode: "manual", submitting: false };
  renderRoom();
}

async function startMicrophone(notifyBegin) {
  const turn = room?.activeTurn;
  if (!turn) return;
  const code = roomCode;
  const generation = routeGeneration;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone input is unavailable. Use the manual timer.");
  let stream;
  let context;
  const releasePendingMicrophone = async () => {
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") await context.close().catch(() => {});
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!isCurrentTurn(code, generation, turn.id)) {
      await releasePendingMicrophone();
      return;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error("Audio monitoring is unavailable. Use the manual timer.");
    context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    if (!isCurrentTurn(code, generation, turn.id)) {
      await releasePendingMicrophone();
      return;
    }
    if (notifyBegin && turn.begunAt === null) {
      await doAction({ type: "begin-turn", turnId: turn.id });
    }
    if (!isCurrentTurn(code, generation, turn.id)) {
      await releasePendingMicrophone();
      return;
    }
    stopController();
    controller = {
      turnId: turn.id,
      mode: "mic",
      submitting: false,
      stream,
      context,
      analyser,
      samples: new Uint8Array(analyser.fftSize),
      lastVoiceAt: performance.now(),
      raf: 0,
    };
    renderRoom();
    monitorMicrophone();
  } catch (error) {
    await releasePendingMicrophone();
    if (stream && controller?.stream === stream) controller = null;
    if (code !== roomCode || generation !== routeGeneration) return;
    throw error;
  }
}

function isCurrentTurn(code, generation, turnId) {
  return code === roomCode && generation === routeGeneration && room?.activeTurn?.id === turnId;
}

function monitorMicrophone() {
  const active = controller;
  if (!active || active.mode !== "mic" || !room?.activeTurn || active.turnId !== room.activeTurn.id) return;
  active.analyser.getByteTimeDomainData(active.samples);
  let energy = 0;
  for (const sample of active.samples) {
    const centered = (sample - 128) / 128;
    energy += centered * centered;
  }
  const level = Math.sqrt(energy / active.samples.length);
  const normalized = Math.min(1, level * 8);
  const meter = document.querySelector("[data-meter]");
  if (meter) meter.style.width = `${Math.round(normalized * 100)}%`;
  if (level > 0.035) active.lastVoiceAt = performance.now();
  const silentFor = (performance.now() - active.lastVoiceAt) / 1000;
  const voice = document.querySelector("[data-voice]");
  if (voice) voice.textContent = silentFor > room.activeTurn.silence * 0.65 ? "Keep talking…" : "Voice detected";
  // Completion wins when the duration and silence thresholds are crossed in
  // the same animation frame.
  if (remainingSeconds(room.activeTurn) <= 0 && !active.submitting) {
    finishTurn(true, false, room.activeTurn.duration).catch((error) => showToast(error.message));
    return;
  }
  if (silentFor >= room.activeTurn.silence && !active.submitting) {
    finishTurn(false, true).catch((error) => showToast(error.message));
    return;
  }
  active.raf = requestAnimationFrame(monitorMicrophone);
}

async function finishTurn(completed, eliminated, forcedSpoken) {
  const turn = room?.activeTurn;
  if (!turn) return;
  if (controller?.submitting) return;
  if (controller) controller.submitting = true;
  const spokenSeconds = forcedSpoken ?? elapsedSeconds(turn);
  stopController();
  await doAction({ type: "submit-turn", turnId: turn.id, spokenSeconds, completed, eliminated });
}

function updateClock() {
  const turn = room?.activeTurn;
  const timer = document.querySelector("[data-timer]");
  if (!turn || !timer) return;
  const remaining = remainingSeconds(turn);
  timer.textContent = String(remaining);
  if (controller?.turnId === turn.id && remaining <= 0 && !controller.submitting) {
    finishTurn(true, false, turn.duration).catch((error) => showToast(error.message));
  }
}

function elapsedSeconds(turn) {
  if (turn.begunAt === null) return 0;
  return Math.max(0, Math.min(turn.duration, Math.floor((Date.now() + clockOffset - turn.begunAt) / 1000)));
}

function remainingSeconds(turn) {
  return Math.max(0, turn.duration - elapsedSeconds(turn));
}

async function doAction(action) {
  const code = roomCode;
  const generation = routeGeneration;
  const payload = await api(`/api/rooms/${code}/action`, action, "POST");
  if (code !== roomCode || generation !== routeGeneration) return;
  acceptRoom(payload.room);
}

function acceptRoom(next) {
  if (!next || next.code !== roomCode) return;
  // HTTP actions/state refreshes and WebSocket broadcasts race in normal use.
  // Never let an older HTTP snapshot roll the client back after a newer live
  // update has already rendered.
  if (room && next.version < room.version) return;
  const previous = room;
  const focusedDraft = captureFocusedDraft();
  const announcement = roomAnnouncement(previous, next);
  room = next;
  clockOffset = room.serverNow - Date.now();
  renderRoom();
  restoreFocusedDraft(focusedDraft);
  announce(announcement);
  if (room.viewer.isMember) connectSocket();
  if (!clockTimer) clockTimer = window.setInterval(updateClock, 200);
  clearTimeout(claimRefreshTimer);
  claimRefreshTimer = 0;
  if (room.viewer.hostClaimWaitMs > 0) {
    claimRefreshTimer = window.setTimeout(refreshRoomState, room.viewer.hostClaimWaitMs + 150);
  }
}

async function refreshRoomState() {
  const code = roomCode;
  const generation = routeGeneration;
  if (!code) return;
  try {
    const payload = await api(`/api/rooms/${code}/state`);
    if (code !== roomCode || generation !== routeGeneration) return;
    acceptRoom(payload.room);
  } catch (error) {
    showToast(error.message);
  }
}

function reconcileController() {
  if (controller && (!room.activeTurn || room.activeTurn.id !== controller.turnId)) stopController();
}

function stopController() {
  if (!controller) return;
  if (controller.raf) cancelAnimationFrame(controller.raf);
  controller.stream?.getTracks().forEach((track) => track.stop());
  if (controller.context && controller.context.state !== "closed") controller.context.close().catch(() => {});
  controller = null;
}

function stopRoomLifecycle() {
  stopController();
  disconnectSocket();
  clearInterval(clockTimer);
  clearTimeout(claimRefreshTimer);
  clockTimer = 0;
  claimRefreshTimer = 0;
}

function connectSocket() {
  if (!roomCode || !room?.viewer.isMember) return;
  if (socketRoom === roomCode && socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  disconnectSocket();
  socketRoom = roomCode;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const liveSocket = new WebSocket(`${protocol}//${location.host}/api/rooms/${roomCode}/socket`);
  socket = liveSocket;
  liveSocket.addEventListener("open", () => {
    if (socket !== liveSocket) return;
    reconnectDelay = 750;
    liveSocket.send(JSON.stringify({ type: "sync" }));
  });
  liveSocket.addEventListener("message", (event) => {
    if (socket !== liveSocket) return;
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "state" && payload.room?.code === roomCode) acceptRoom(payload.room);
    } catch {
      // Ignore malformed live messages and keep the room usable over HTTP.
    }
  });
  liveSocket.addEventListener("close", () => {
    if (socket !== liveSocket) return;
    socket = null;
    if (!room?.viewer.isMember || !roomCode) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => {
      refreshRoomState().finally(connectSocket);
    }, reconnectDelay);
    reconnectDelay = Math.min(10_000, reconnectDelay * 1.7);
  });
}

function disconnectSocket() {
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  const active = socket;
  socket = null;
  socketRoom = "";
  if (active && active.readyState < WebSocket.CLOSING) active.close(1000, "Navigating away");
}

async function api(path, body, method = "GET") {
  const options = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload = {};
  try { payload = await response.json(); } catch { /* A non-JSON edge error is handled below. */ }
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
    const error = new Error(message || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload.error?.code || "";
    error.requestId = payload.requestId || response.headers.get("X-Request-ID") || "";
    throw error;
  }
  return payload;
}

function navigate(path) {
  history.pushState({}, "", path);
  routeFocusRequested = true;
  loadRoute();
}

function focusRouteHeading() {
  if (!routeFocusRequested) return;
  routeFocusRequested = false;
  const heading = app.querySelector("h1");
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: false });
  announce(`${heading.textContent.trim()} page.`);
}

function updatePrimaryNavigation() {
  for (const link of document.querySelectorAll("[data-nav]")) {
    const href = new URL(link.href, location.href).pathname;
    const active = href === "/"
      ? location.pathname === "/" || /^\/room\//i.test(location.pathname)
      : location.pathname === href || location.pathname === `${href}/`;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll("button")) button.disabled = value;
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function notice(message, error = false) {
  return `<div class="notice ${error ? "error" : ""}"${error ? ` role="alert"` : ""}>${escapeHTML(message)}</div>`;
}

function captureFocusedDraft() {
  if (!room || !roomCode) return null;
  const control = document.activeElement;
  if (!isEditableControl(control) || !app.contains(control)) return null;
  const key = editableControlKey(control);
  if (!key) return null;
  let selectionStart = null;
  let selectionEnd = null;
  let selectionDirection = null;
  try {
    selectionStart = control.selectionStart;
    selectionEnd = control.selectionEnd;
    selectionDirection = control.selectionDirection;
  } catch {
    // Number inputs and selects do not expose a text selection.
  }
  return {
    code: roomCode,
    phase: room.phase,
    generation: routeGeneration,
    key,
    value: control.value,
    checked: "checked" in control ? control.checked : null,
    selectionStart,
    selectionEnd,
    selectionDirection,
  };
}

function restoreFocusedDraft(draft) {
  if (!draft || draft.code !== roomCode || draft.phase !== room?.phase || draft.generation !== routeGeneration) return;
  const control = Array.from(app.querySelectorAll("input, select, textarea"))
    .find((candidate) => isEditableControl(candidate) && editableControlKey(candidate) === draft.key);
  if (!control) return;
  control.value = draft.value;
  if (draft.checked !== null && "checked" in control) control.checked = draft.checked;
  control.focus({ preventScroll: true });
  if (draft.selectionStart === null || typeof control.setSelectionRange !== "function") return;
  try {
    control.setSelectionRange(draft.selectionStart, draft.selectionEnd, draft.selectionDirection);
  } catch {
    // The restored control may not support a text selection.
  }
}

function isEditableControl(control) {
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) return false;
  if (control.disabled || control.readOnly) return false;
  return !(control instanceof HTMLInputElement) || !["hidden", "button", "submit", "reset", "image"].includes(control.type);
}

function editableControlKey(control) {
  if (!control.name) return "";
  const form = control.form;
  if (!form || !app.contains(form)) return "";
  if (form.matches("[data-join-current-room]")) return `join-current:${control.name}`;
  if (!form.matches("[data-room-action]")) return "";
  const action = formFieldValue(form, "type");
  const target = formFieldValue(form, "playerId") || formFieldValue(form, "id");
  return `room-action:${action}:${target}:${control.name}`;
}

function formFieldValue(form, name) {
  const field = form.elements.namedItem(name);
  return field && "value" in field ? String(field.value) : "";
}

function roomAnnouncement(previous, next) {
  if (!previous) {
    if (!next.viewer.isMember) return `Room ${next.code} is ready to join.`;
    return next.phase === "setup" ? `Room ${next.code} lobby loaded.` : `Room ${next.code} loaded.`;
  }
  if (previous.phase !== next.phase) {
    if (next.phase === "finished") return `${next.winner?.name || "The winner"} wins with ${next.winner?.score ?? 0} points.`;
    if (next.phase === "playing") return `Game started. ${next.players[next.currentPlayer]?.name || "The first player"} is up next.`;
    return "The room returned to game setup.";
  }
  if (previous.lastTurn?.id !== next.lastTurn?.id && next.lastTurn) {
    return `${next.lastTurn.playerName} earned ${next.lastTurn.score} points.`;
  }
  if (previous.activeTurn?.id !== next.activeTurn?.id && next.activeTurn) {
    return `${next.activeTurn.playerName}'s turn. Topic: ${next.activeTurn.topic}`;
  }
  if (!previous.viewer.hostDisconnected && next.viewer.hostDisconnected) {
    return "The host disconnected. Host controls can be claimed after the grace period.";
  }
  if (!previous.viewer.canClaimHost && next.viewer.canClaimHost) return "Host controls can now be claimed.";
  return "";
}

function announce(message) {
  if (!message || !announcer) return;
  const generation = routeGeneration;
  announcer.textContent = "";
  queueMicrotask(() => {
    if (generation === routeGeneration) announcer.textContent = message;
  });
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function shutdown() {
  stopRoomLifecycle();
  stopCoachingLifecycle();
}
