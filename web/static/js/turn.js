(() => {
  const stage = document.querySelector("[data-turn]");
  if (!stage) return;

  const duration = Number(stage.dataset.duration || 60);
  const silenceLimit = Number(stage.dataset.silence || 2);
  const timer = stage.querySelector("[data-timer]");
  const meter = stage.querySelector("[data-meter]");
  const voiceLabel = stage.querySelector("[data-voice-label]");
  const silenceLabel = stage.querySelector("[data-silence-label]");
  const startButton = stage.querySelector("[data-start-turn]");
  const manualButton = stage.querySelector("[data-start-manual]");
  const redrawButton = stage.querySelector("[data-redraw-topic]");
  const completeButton = stage.querySelector("[data-manual-complete]");
  const form = stage.querySelector("[data-result-form]");
  const spokenInput = stage.querySelector("[data-spoken]");
  const completedInput = stage.querySelector("[data-completed]");
  const eliminatedInput = stage.querySelector("[data-eliminated]");

  let audioContext;
  let analyser;
  let data;
  let stream;
  let startedAt = 0;
  let lastVoiceAt = 0;
  let raf = 0;
  let running = false;
  let mode = "idle";

  const setStatus = (label, level, warning = false) => {
    voiceLabel.textContent = label;
    meter.style.inlineSize = `${Math.round(level * 100)}%`;
    stage.classList.toggle("is-warning", warning);
    stage.classList.toggle("is-manual", mode === "manual");
  };

  const setStartedControls = () => {
    startButton.disabled = true;
    if (manualButton) manualButton.disabled = true;
    if (redrawButton) redrawButton.disabled = true;
  };

  const setReadyControls = () => {
    startButton.disabled = false;
    startButton.textContent = "Start Talking";
    if (manualButton) manualButton.disabled = false;
    if (redrawButton) redrawButton.disabled = false;
  };

  const stopMic = () => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    if (audioContext) {
      audioContext.close();
    }
    stream = null;
    audioContext = null;
  };

  const elapsedSeconds = () => Math.min(duration, Math.max(0, Math.round((performance.now() - startedAt) / 1000)));

  const updateTimer = () => {
    const elapsed = elapsedSeconds();
    const remaining = Math.max(0, Math.ceil(duration - (performance.now() - startedAt) / 1000));
    timer.textContent = String(remaining);
    return elapsed;
  };

  const submitResult = (spokenSeconds, completed, eliminated) => {
    running = false;
    mode = "idle";
    cancelAnimationFrame(raf);
    stopMic();
    spokenInput.value = String(spokenSeconds);
    completedInput.value = completed ? "true" : "false";
    eliminatedInput.value = eliminated ? "true" : "false";
    form.requestSubmit();
  };

  const finish = (completed, eliminated, options = {}) => {
    const elapsed = running ? elapsedSeconds() : Number(spokenInput.value || 0);
    const spokenSeconds = options.fullDuration ? duration : elapsed;
    submitResult(spokenSeconds, completed, eliminated);
  };

  const level = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    return Math.sqrt(sum / data.length);
  };

  const micTick = () => {
    if (!running || mode !== "mic") return;
    const now = performance.now();
    const elapsed = (now - startedAt) / 1000;
    updateTimer();

    const volume = level();
    const speaking = volume > 0.035;
    if (speaking) {
      lastVoiceAt = now;
      setStatus("Speaking", Math.min(1, volume * 8), false);
      silenceLabel.textContent = `Silence limit: ${silenceLimit}s`;
    } else {
      const silentFor = (now - lastVoiceAt) / 1000;
      const left = Math.max(0, silenceLimit - silentFor);
      setStatus("Silence", Math.min(1, volume * 8), left <= 1);
      silenceLabel.textContent = `Silence left: ${left.toFixed(1)}s`;
      if (silentFor >= silenceLimit) {
        finish(false, true);
        return;
      }
    }

    if (elapsed >= duration) {
      finish(true, false);
      return;
    }
    raf = requestAnimationFrame(micTick);
  };

  const manualTick = () => {
    if (!running || mode !== "manual") return;
    const elapsed = updateTimer();
    setStatus("Manual timing", 1, false);
    silenceLabel.textContent = "Host controlled";

    if (elapsed >= duration) {
      finish(true, false);
      return;
    }
    raf = requestAnimationFrame(manualTick);
  };

  const start = async () => {
    if (running) return;
    setStartedControls();
    startButton.textContent = "Listening";
    mode = "mic";
    setStatus("Listening", 0, false);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("microphone unavailable");
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      data = new Uint8Array(analyser.fftSize);
      source.connect(analyser);
      running = true;
      startedAt = performance.now();
      lastVoiceAt = startedAt;
      raf = requestAnimationFrame(micTick);
    } catch {
      running = false;
      mode = "idle";
      stopMic();
      setReadyControls();
      setStatus("Mic blocked", 0, true);
      silenceLabel.textContent = "Manual mode ready";
    }
  };

  const startManual = () => {
    if (running) return;
    mode = "manual";
    running = true;
    startedAt = performance.now();
    setStartedControls();
    setStatus("Manual timing", 1, false);
    silenceLabel.textContent = "Host controlled";
    raf = requestAnimationFrame(manualTick);
  };

  startButton.addEventListener("click", start);
  if (manualButton) manualButton.addEventListener("click", startManual);
  completeButton.addEventListener("click", () => finish(true, false, { fullDuration: true }));
  form.addEventListener("submit", () => {
    if (running) {
      spokenInput.value = String(elapsedSeconds());
    }
    running = false;
    mode = "idle";
    cancelAnimationFrame(raf);
    stopMic();
  });
})();
