(() => {
  const stage = document.querySelector("[data-turn]");
  if (!stage) return;

  const duration = Number(stage.dataset.duration || 60);
  const silenceLimit = Number(stage.dataset.silence || 2);
  const timer = stage.querySelector("[data-timer]");
  const meter = stage.querySelector("[data-meter]");
  const voiceLabel = stage.querySelector("[data-voice-label]");
  const silenceLabel = stage.querySelector("[data-silence-label]");
  const micList = stage.querySelector("[data-mic-list]");
  const micSelectedLabel = stage.querySelector("[data-mic-selected-label]");
  const micSummaryLevel = stage.querySelector("[data-mic-summary-level]");
  const openMicButton = stage.querySelector("[data-open-mic-picker]");
  const closeMicButton = stage.querySelector("[data-close-mic-picker]");
  const micDialog = stage.querySelector("[data-mic-dialog]");
  const micStatus = stage.querySelector("[data-mic-status]");
  const startButton = stage.querySelector("[data-start-turn]");
  const manualButton = stage.querySelector("[data-start-manual]");
  const redrawButton = stage.querySelector("[data-redraw-topic]");
  const completeButton = stage.querySelector("[data-manual-complete]");
  const form = stage.querySelector("[data-result-form]");
  const spokenInput = stage.querySelector("[data-spoken]");
  const completedInput = stage.querySelector("[data-completed]");
  const eliminatedInput = stage.querySelector("[data-eliminated]");

  const autoMicValue = "auto";
  const micStorageKey = "dont-stop-talking.mic-id";
  const speakingThreshold = 0.035;
  const barCount = 8;

  let audioContext;
  let analyser;
  let data;
  let stream;
  let previewAudioContext;
  let previewAnalyser;
  let previewData;
  let previewStream;
  let previewRaf = 0;
  let startedAt = 0;
  let lastVoiceAt = 0;
  let raf = 0;
  let running = false;
  let mode = "idle";
  let micSelectionAvailable = true;
  let micDevicesLoaded = false;
  let micDevices = [];
  let selectedMicID = readSavedMic();

  function readSavedMic() {
    try {
      return window.localStorage.getItem(micStorageKey) || autoMicValue;
    } catch {
      return autoMicValue;
    }
  }

  const saveMic = (value) => {
    try {
      if (value && value !== autoMicValue) {
        window.localStorage.setItem(micStorageKey, value);
      } else {
        window.localStorage.removeItem(micStorageKey);
      }
    } catch {
      // Selection persistence is best-effort.
    }
  };

  const audioContextConstructor = () => window.AudioContext || window.webkitAudioContext;

  const stopStream = (activeStream) => {
    if (activeStream) {
      activeStream.getTracks().forEach((track) => track.stop());
    }
  };

  const closeAudioContext = (context) => {
    if (context) {
      context.close();
    }
  };

  const stopPreview = () => {
    cancelAnimationFrame(previewRaf);
    stopStream(previewStream);
    closeAudioContext(previewAudioContext);
    previewStream = null;
    previewAudioContext = null;
    previewAnalyser = null;
    previewData = null;
  };

  const stopMic = () => {
    stopStream(stream);
    closeAudioContext(audioContext);
    stream = null;
    audioContext = null;
    analyser = null;
    data = null;
  };

  const labelForDevice = (device, index) => {
    const label = device.label?.trim();
    if (label) return label;
    if (device.deviceId === "default") return "System Default";
    if (device.deviceId === "communications") return "Communications";
    return `Microphone ${index + 1}`;
  };

  const descriptionForDevice = (device) => {
    if (device.deviceId === autoMicValue) return "Overrides other mics when connected";
    return "";
  };

  const selectedMicLabelText = () => {
    if (selectedMicID === autoMicValue) return "Auto-detect";
    const index = micDevices.findIndex((device) => device.deviceId === selectedMicID);
    if (index >= 0) return labelForDevice(micDevices[index], index);
    return "Selected microphone";
  };

  const setMeterLevel = (level) => {
    meter.style.inlineSize = `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%`;
  };

  const setMicStatus = (label, warning = false) => {
    if (!micStatus) return;
    micStatus.textContent = label;
    micStatus.classList.toggle("is-warning", warning);
  };

  const setMicControlsDisabled = (disabled) => {
    if (openMicButton) {
      openMicButton.disabled = disabled || !micSelectionAvailable;
    }
    if (!micList) return;
    for (const option of micList.querySelectorAll("[data-mic-option]")) {
      option.disabled = disabled || !micSelectionAvailable;
    }
  };

  const makeLevelMeter = () => {
    const level = document.createElement("span");
    level.className = "mic-level";
    level.dataset.micLevel = "";
    level.setAttribute("aria-hidden", "true");
    fillLevelMeter(level);
    return level;
  };

  const fillLevelMeter = (level) => {
    if (!level || level.children.length > 0) return;
    for (let index = 0; index < barCount; index += 1) {
      level.appendChild(document.createElement("span"));
    }
  };

  const updateLevelMeter = (levelElement, level) => {
    if (!levelElement) return;
    fillLevelMeter(levelElement);
    const activeBars = Math.ceil(Math.min(1, Math.max(0, level)) * barCount);
    const bars = Array.from(levelElement.children);
    for (const [index, bar] of bars.entries()) {
      bar.classList.toggle("is-active", index >= bars.length - activeBars);
    }
  };

  const updateSelectedMicLevel = (level) => {
    updateLevelMeter(micSummaryLevel, level);
    if (!micList) return;
    for (const option of micList.querySelectorAll("[data-mic-option]")) {
      const isSelected = option.dataset.deviceId === selectedMicID;
      option.classList.toggle("is-hearing", isSelected && level > 0.22);
      updateLevelMeter(option.querySelector("[data-mic-level]"), isSelected ? level : 0);
    }
  };

  const makeMicOption = (device, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mic-option";
    button.dataset.micOption = "";
    button.dataset.deviceId = device.deviceId;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", device.deviceId === selectedMicID ? "true" : "false");
    button.classList.toggle("is-selected", device.deviceId === selectedMicID);

    const copy = document.createElement("span");
    copy.className = "mic-option-copy";

    const name = document.createElement("strong");
    name.textContent = device.deviceId === autoMicValue ? "Auto-detect" : labelForDevice(device, index);

    const descriptionText = descriptionForDevice(device);

    copy.appendChild(name);
    if (descriptionText) {
      const description = document.createElement("span");
      description.textContent = descriptionText;
      copy.appendChild(description);
    }
    button.append(copy, makeLevelMeter());
    button.addEventListener("click", () => selectMic(device.deviceId));
    return button;
  };

  const syncMicSummary = () => {
    if (micSelectedLabel) {
      micSelectedLabel.textContent = selectedMicLabelText();
    }
    setMicStatus(selectedMicLabelText(), false);
  };

  const renderMicList = () => {
    if (!micList) return;
    const knownIDs = new Set([autoMicValue, ...micDevices.map((device) => device.deviceId)]);
    if (micDevicesLoaded && !knownIDs.has(selectedMicID)) {
      selectedMicID = autoMicValue;
      saveMic(autoMicValue);
    }

    micList.replaceChildren();
    micList.appendChild(makeMicOption({ deviceId: autoMicValue }, -1));
    for (const [index, device] of micDevices.entries()) {
      micList.appendChild(makeMicOption(device, index));
    }
    syncMicSummary();
    setMicControlsDisabled(running || mode !== "idle");
  };

  const audioConstraintFor = (deviceID) =>
    deviceID && deviceID !== autoMicValue ? { deviceId: { exact: deviceID } } : true;

  const requestStreamFor = (deviceID) => navigator.mediaDevices.getUserMedia({ audio: audioConstraintFor(deviceID) });

  const requestSelectedStream = async () => {
    const requestedID = selectedMicID;
    try {
      return await requestStreamFor(requestedID);
    } catch (error) {
      if (requestedID !== autoMicValue) {
        selectedMicID = autoMicValue;
        saveMic(autoMicValue);
        renderMicList();
        setMicStatus("Selected mic unavailable, using Auto-detect", true);
        return await requestStreamFor(autoMicValue);
      }
      throw error;
    }
  };

  const ensureDeviceAccess = async () => {
    const accessStream = await requestStreamFor(autoMicValue);
    stopStream(accessStream);
  };

  const volumeLevel = (activeAnalyser, activeData) => {
    activeAnalyser.getByteTimeDomainData(activeData);
    let sum = 0;
    for (const value of activeData) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    return Math.sqrt(sum / activeData.length);
  };

  const previewTick = () => {
    if (running || mode !== "idle" || !previewAnalyser || !previewData) return;
    const volume = volumeLevel(previewAnalyser, previewData);
    const displayLevel = Math.min(1, volume * 8);
    const hearing = volume > speakingThreshold;

    setMeterLevel(displayLevel);
    updateSelectedMicLevel(displayLevel);
    voiceLabel.textContent = hearing ? "Mic hearing" : "Mic ready";
    stage.classList.toggle("is-warning", false);
    stage.classList.toggle("is-manual", false);
    setMicStatus(hearing ? `${selectedMicLabelText()} hears input` : `${selectedMicLabelText()} listening`, false);
    previewRaf = requestAnimationFrame(previewTick);
  };

  const startPreview = async () => {
    if (running || mode !== "idle") return;
    if (!window.isSecureContext) {
      setMicStatus("Mic requires localhost or HTTPS", true);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicStatus("Mic unavailable", true);
      return;
    }
    stopPreview();
    setMeterLevel(0);
    updateSelectedMicLevel(0);
    setMicStatus(`Testing ${selectedMicLabelText()}`, false);

    try {
      previewStream = await requestSelectedStream();
      const AudioContextConstructor = audioContextConstructor();
      if (!AudioContextConstructor) throw new Error("audio context unavailable");
      previewAudioContext = new AudioContextConstructor();
      const source = previewAudioContext.createMediaStreamSource(previewStream);
      previewAnalyser = previewAudioContext.createAnalyser();
      previewAnalyser.fftSize = 1024;
      previewData = new Uint8Array(previewAnalyser.fftSize);
      source.connect(previewAnalyser);
      previewRaf = requestAnimationFrame(previewTick);
    } catch {
      stopPreview();
      setMeterLevel(0);
      updateSelectedMicLevel(0);
      voiceLabel.textContent = "Mic blocked";
      setMicStatus("Mic access blocked", true);
    }
  };

  const populateMics = async ({ requestPermission = false, startTest = false } = {}) => {
    if (!micList) return;
    if (!window.isSecureContext) {
      micSelectionAvailable = false;
      renderMicList();
      setMicControlsDisabled(running || mode !== "idle");
      setMicStatus("Mic requires localhost or HTTPS", true);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      micSelectionAvailable = false;
      renderMicList();
      setMicControlsDisabled(running || mode !== "idle");
      setMicStatus("Mic list unavailable", true);
      return;
    }

    micSelectionAvailable = false;
    setMicControlsDisabled(true);

    let accessBlocked = false;
    try {
      if (requestPermission) {
        try {
          await ensureDeviceAccess();
        } catch {
          accessBlocked = true;
        }
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      micDevices = devices.filter((device) => device.kind === "audioinput" && device.deviceId);
      micDevicesLoaded = true;
      renderMicList();

      const hasNamedMics = micDevices.some((device) => device.label && device.label.trim());
      if (accessBlocked) {
        setMicStatus("Mic access blocked", true);
      } else if (micDevices.length === 0) {
        setMicStatus("No microphones found", true);
      } else if (requestPermission || startTest || hasNamedMics) {
        await startPreview();
      } else {
        setMicStatus("Change to choose or test microphones", false);
      }
    } catch {
      renderMicList();
      voiceLabel.textContent = "Mic blocked";
      setMicStatus("Mic access blocked", true);
    } finally {
      micSelectionAvailable = true;
      setMicControlsDisabled(running || mode !== "idle");
    }
  };

  const selectMic = async (deviceID) => {
    if (running || mode !== "idle") return;
    selectedMicID = deviceID;
    saveMic(selectedMicID);
    renderMicList();
    await startPreview();
  };

  const openMicDialog = async () => {
    if (!micDialog || running || mode !== "idle") return;
    micDialog.hidden = false;
    renderMicList();
    await populateMics({ requestPermission: true, startTest: true });
    const selected = micList?.querySelector('[aria-selected="true"]');
    if (selected instanceof HTMLElement) {
      selected.focus();
    } else if (closeMicButton) {
      closeMicButton.focus();
    }
  };

  const closeMicDialog = ({ restoreFocus = true } = {}) => {
    if (!micDialog) return;
    micDialog.hidden = true;
    if (restoreFocus && openMicButton) {
      openMicButton.focus();
    }
  };

  const setStatus = (label, level, warning = false) => {
    voiceLabel.textContent = label;
    setMeterLevel(level);
    updateSelectedMicLevel(level);
    stage.classList.toggle("is-warning", warning);
    stage.classList.toggle("is-manual", mode === "manual");
  };

  const setStartedControls = () => {
    startButton.disabled = true;
    if (manualButton) manualButton.disabled = true;
    if (redrawButton) redrawButton.disabled = true;
    setMicControlsDisabled(true);
  };

  const setReadyControls = () => {
    startButton.disabled = false;
    startButton.textContent = "Start Talking";
    if (manualButton) manualButton.disabled = false;
    if (redrawButton) redrawButton.disabled = false;
    setMicControlsDisabled(false);
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
    stopPreview();
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

  const micTick = () => {
    if (!running || mode !== "mic") return;
    const now = performance.now();
    const elapsed = (now - startedAt) / 1000;
    updateTimer();

    const volume = volumeLevel(analyser, data);
    const speaking = volume > speakingThreshold;
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
    closeMicDialog({ restoreFocus: false });
    stopPreview();
    setStartedControls();
    startButton.textContent = "Listening";
    mode = "mic";
    setStatus("Listening", 0, false);
    try {
      if (!window.isSecureContext) {
        throw new Error("microphone requires secure context");
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("microphone unavailable");
      }
      stream = await requestSelectedStream();
      await populateMics({ startTest: false });
      setMicControlsDisabled(true);
      setMicStatus(selectedMicLabelText(), false);
      const AudioContextConstructor = audioContextConstructor();
      if (!AudioContextConstructor) throw new Error("audio context unavailable");
      audioContext = new AudioContextConstructor();
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
    closeMicDialog({ restoreFocus: false });
    stopPreview();
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
  if (openMicButton) {
    openMicButton.addEventListener("click", openMicDialog);
  }
  if (closeMicButton) {
    closeMicButton.addEventListener("click", () => closeMicDialog());
  }
  if (micDialog) {
    micDialog.addEventListener("click", (event) => {
      if (event.target === micDialog) {
        closeMicDialog();
      }
    });
    micDialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMicDialog();
      }
    });
  }
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => populateMics({ startTest: true }));
  }
  completeButton.addEventListener("click", () => finish(true, false, { fullDuration: true }));
  form.addEventListener("submit", () => {
    if (running) {
      spokenInput.value = String(elapsedSeconds());
    }
    running = false;
    mode = "idle";
    cancelAnimationFrame(raf);
    stopPreview();
    stopMic();
  });

  fillLevelMeter(micSummaryLevel);
  renderMicList();
  populateMics();
})();
