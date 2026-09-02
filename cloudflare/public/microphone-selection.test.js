import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_MICROPHONE_ID,
  MICROPHONE_MAX_DEVICE_COUNT,
  MICROPHONE_MAX_DEVICE_ID_BYTES,
  MICROPHONE_MAX_DEVICE_ID_CODE_POINTS,
  MICROPHONE_MAX_LABEL_CODE_POINTS,
  MICROPHONE_STORAGE_KEY,
  audioConstraintsForMicrophone,
  createMicrophoneSelection,
  isSelectedMicrophoneUnavailableError,
  microphoneDeviceLabel,
  normalizeMicrophoneDeviceId,
  normalizeMicrophoneDevices,
} from "./microphone-selection.js";

class MemoryStorage {
  constructor(value = null) {
    this.value = value;
    this.gets = 0;
    this.sets = [];
    this.removes = 0;
  }

  getItem(key) {
    assert.equal(key, MICROPHONE_STORAGE_KEY);
    this.gets += 1;
    return this.value;
  }

  setItem(key, value) {
    assert.equal(key, MICROPHONE_STORAGE_KEY);
    this.value = String(value);
    this.sets.push(String(value));
  }

  removeItem(key) {
    assert.equal(key, MICROPHONE_STORAGE_KEY);
    this.value = null;
    this.removes += 1;
  }
}

function mediaError(name, constraint = undefined) {
  const error = new Error(name);
  error.name = name;
  if (constraint !== undefined) error.constraint = constraint;
  return error;
}

function audioInput(deviceId, label = "") {
  return { kind: "audioinput", deviceId, label, groupId: "not-retained" };
}

test("exports a bounded opaque-ID storage contract", () => {
  assert.equal(MICROPHONE_STORAGE_KEY, "nonstoptalk.microphone.v1");
  assert.equal(AUTO_MICROPHONE_ID, "");
  assert.equal(MICROPHONE_MAX_DEVICE_ID_CODE_POINTS, 1024);
  assert.equal(MICROPHONE_MAX_DEVICE_ID_BYTES, 2048);
  assert.equal(MICROPHONE_MAX_LABEL_CODE_POINTS, 120);
  assert.equal(MICROPHONE_MAX_DEVICE_COUNT, 64);
});

test("validates device IDs without trimming or changing their exact value", () => {
  assert.equal(normalizeMicrophoneDeviceId("mic-01"), "mic-01");
  assert.equal(normalizeMicrophoneDeviceId(" mic "), " mic ");
  assert.equal(normalizeMicrophoneDeviceId(""), "");
  assert.throws(
    () => normalizeMicrophoneDeviceId("", { allowAuto: false }),
    /device ID is invalid/u,
  );
  for (const invalid of [null, undefined, 1, {}, "line\nbreak", "x".repeat(1025), "😀".repeat(1025)]) {
    assert.throws(() => normalizeMicrophoneDeviceId(invalid), /device ID is invalid/u);
  }
  assert.throws(
    () => normalizeMicrophoneDeviceId("😀".repeat(1024), { allowAuto: false }),
    /device ID is invalid/u,
    "the independent UTF-8 byte bound must reject a code-point-valid oversized ID",
  );
});

test("normalizes only detached, unique audio inputs and bounds display labels", () => {
  const hostileLabel = `<img src=x onerror=alert(1)>${"L".repeat(200)}`;
  const source = [
    audioInput("first", hostileLabel),
    { kind: "videoinput", deviceId: "camera", label: "Camera" },
    audioInput("first", "Duplicate"),
    audioInput("second", "  Room mic  "),
    audioInput("bad\nid", "Bad"),
    { kind: "audioinput", deviceId: "third", get label() { throw new Error("private"); } },
  ];
  const result = normalizeMicrophoneDevices(source);
  assert.equal(result.length, 2);
  assert.deepEqual(result[1], { deviceId: "second", label: "Room mic" });
  assert.equal([...result[0].label].length, MICROPHONE_MAX_LABEL_CODE_POINTS);
  assert.match(result[0].label, /^<img src=x onerror=alert\(1\)>/u);
  assert.equal(Object.hasOwn(result[0], "groupId"), false);
  source[0].label = "Changed";
  assert.notEqual(result[0].label, "Changed");
});

test("device enumeration output is capped even for an oversized browser result", () => {
  const devices = Array.from({ length: MICROPHONE_MAX_DEVICE_COUNT + 50 }, (_, index) =>
    audioInput(`mic-${index}`, `Microphone ${index}`));
  const result = normalizeMicrophoneDevices(devices);
  assert.equal(result.length, MICROPHONE_MAX_DEVICE_COUNT);
  assert.equal(result.at(-1).deviceId, `mic-${MICROPHONE_MAX_DEVICE_COUNT - 1}`);

  let inspected = 0;
  function* invalidForever() {
    while (true) {
      inspected += 1;
      yield { kind: "videoinput", deviceId: `camera-${inspected}`, label: "Camera" };
    }
  }
  assert.deepEqual(normalizeMicrophoneDevices(invalidForever()), []);
  assert.equal(inspected, MICROPHONE_MAX_DEVICE_COUNT * 4 + 1);
});

test("builds exact selected-device constraints without mutating coaching constraints", () => {
  const coaching = { echoCancellation: true, noiseSuppression: true, autoGainControl: false };
  assert.deepEqual(audioConstraintsForMicrophone("", coaching), coaching);
  assert.notEqual(audioConstraintsForMicrophone("", coaching), coaching);
  assert.deepEqual(audioConstraintsForMicrophone("mic-a", coaching), {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    deviceId: { exact: "mic-a" },
  });
  assert.equal(Object.hasOwn(coaching, "deviceId"), false);
  assert.deepEqual(audioConstraintsForMicrophone("mic-a"), { deviceId: { exact: "mic-a" } });
  assert.equal(audioConstraintsForMicrophone(""), true);
  for (const invalid of [false, null, [], "audio"]) {
    assert.throws(() => audioConstraintsForMicrophone("", invalid), /must be true or an object/u);
  }
});

test("labels Auto, known defaults, unlabeled inputs, and missing saved devices safely", () => {
  const devices = normalizeMicrophoneDevices([
    audioInput("default"),
    audioInput("communications"),
    audioInput("mic-a"),
    audioInput("mic-b", "Desk <strong>mic</strong>"),
  ]);
  assert.equal(microphoneDeviceLabel(devices, ""), "Auto-detect");
  assert.equal(microphoneDeviceLabel(devices, "default"), "System default");
  assert.equal(microphoneDeviceLabel(devices, "communications"), "Communications microphone");
  assert.equal(microphoneDeviceLabel(devices, "mic-a"), "Microphone 3");
  assert.equal(microphoneDeviceLabel(devices, "mic-b"), "Desk <strong>mic</strong>");
  assert.equal(microphoneDeviceLabel(devices, "removed"), "Saved microphone");
});

test("reads, writes, clears, and reloads only the opaque selected ID", () => {
  const storage = new MemoryStorage("mic-a");
  const selection = createMicrophoneSelection({
    getStorage: () => storage,
    getMediaDevices: () => null,
  });
  assert.equal(selection.selectedId, "mic-a");
  assert.deepEqual(selection.select("mic-b"), { selectedId: "mic-b", persisted: true });
  assert.deepEqual(storage.sets, ["mic-b"]);
  assert.equal(storage.value, "mic-b");
  storage.value = "mic-c";
  assert.equal(selection.reload(), "mic-c");
  assert.deepEqual(selection.select(""), { selectedId: "", persisted: true });
  assert.equal(storage.value, null);
  assert.equal(storage.removes, 1);
});

test("invalid or unavailable storage fails closed to Auto without blocking in-memory use", () => {
  const invalidStorage = new MemoryStorage("bad\nid");
  const repaired = createMicrophoneSelection({ getStorage: () => invalidStorage });
  assert.equal(repaired.selectedId, "");
  assert.equal(invalidStorage.value, null);
  assert.equal(invalidStorage.removes, 1);

  const throwingStorage = {
    getItem() { throw new DOMException("blocked", "SecurityError"); },
    setItem() { throw new DOMException("blocked", "SecurityError"); },
    removeItem() { throw new DOMException("blocked", "SecurityError"); },
  };
  const unavailable = createMicrophoneSelection({ getStorage: () => throwingStorage });
  assert.equal(unavailable.selectedId, "");
  assert.deepEqual(unavailable.select("session-only"), {
    selectedId: "session-only",
    persisted: false,
  });
  assert.equal(unavailable.selectedId, "session-only");
});

test("enumerates through the current mediaDevices object and keeps labels memory-only", async () => {
  const storage = new MemoryStorage("mic-b");
  let current = {
    enumerateDevices: async () => [audioInput("mic-a", "Laptop"), audioInput("mic-b", "Room")],
  };
  const selection = createMicrophoneSelection({
    getStorage: () => storage,
    getMediaDevices: () => current,
  });
  assert.equal(selection.selectedLabel, "Saved microphone");
  assert.deepEqual(await selection.enumerate(), [
    { deviceId: "mic-a", label: "Laptop" },
    { deviceId: "mic-b", label: "Room" },
  ]);
  assert.equal(selection.selectedLabel, "Room");
  assert.equal(storage.value, "mic-b");
  assert.deepEqual(storage.sets, [], "enumeration must never persist a label or rewrite the ID");
  const detached = selection.devices;
  detached[1].label = "Changed";
  assert.equal(selection.selectedLabel, "Room");
  current = null;
  assert.deepEqual(await selection.enumerate(), []);
  assert.equal(selection.selectedLabel, "Saved microphone");
});

test("permission-assisted enumeration stops preview streams and honors cancellation", async () => {
  let current = true;
  let stops = 0;
  let mediaCalls = 0;
  let enumerateCalls = 0;
  const selection = createMicrophoneSelection({
    getStorage: () => new MemoryStorage(),
    getMediaDevices: () => ({
      async getUserMedia(constraints) {
        mediaCalls += 1;
        assert.deepEqual(constraints, { audio: true, video: false });
        return { getTracks: () => [{ stop() { stops += 1; } }] };
      },
      async enumerateDevices() {
        enumerateCalls += 1;
        return [audioInput("named", "Studio")];
      },
    }),
  });
  assert.deepEqual(await selection.enumerate({ requestPermission: true, isCurrent: () => current }), [
    { deviceId: "named", label: "Studio" },
  ]);
  assert.equal(mediaCalls, 1);
  assert.equal(enumerateCalls, 1);
  assert.equal(stops, 1);

  const failedEnumeration = createMicrophoneSelection({
    getStorage: () => new MemoryStorage(),
    getMediaDevices: () => ({
      async getUserMedia() {
        return { getTracks: () => [{ stop() { stops += 1; } }] };
      },
      async enumerateDevices() {
        throw mediaError("NotReadableError");
      },
    }),
  });
  await assert.rejects(failedEnumeration.enumerate({ requestPermission: true }), {
    name: "NotReadableError",
  });
  assert.equal(stops, 2, "the preview stream must stop when enumeration fails");

  let resolveEnumeration;
  let enumerationStarted;
  const started = new Promise((resolve) => { enumerationStarted = resolve; });
  let hangingStops = 0;
  const hangingEnumeration = createMicrophoneSelection({
    getStorage: () => new MemoryStorage(),
    getMediaDevices: () => ({
      async getUserMedia() {
        return { getTracks: () => [{ stop() { hangingStops += 1; } }] };
      },
      enumerateDevices() {
        enumerationStarted();
        return new Promise((resolve) => { resolveEnumeration = resolve; });
      },
    }),
  });
  const hangingRequest = hangingEnumeration.enumerate({ requestPermission: true });
  await started;
  assert.equal(hangingStops, 1,
    "the preview stream must stop before a browser enumeration that can hang");
  resolveEnumeration([audioInput("eventual", "Eventual")]);
  assert.deepEqual(await hangingRequest, [{ deviceId: "eventual", label: "Eventual" }]);

  let resolvePermission;
  const stale = createMicrophoneSelection({
    getStorage: () => new MemoryStorage(),
    getMediaDevices: () => ({
      getUserMedia() {
        return new Promise((resolve) => { resolvePermission = resolve; });
      },
      async enumerateDevices() {
        throw new Error("enumeration must not run after cancellation");
      },
    }),
  });
  const request = stale.enumerate({ requestPermission: true, isCurrent: () => current });
  current = false;
  resolvePermission({ getTracks: () => [{ stop() { stops += 1; } }] });
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(stops, 3);
});

test("a newer device refresh wins when older enumeration resolves later", async () => {
  const pending = [];
  const selection = createMicrophoneSelection({
    getStorage: () => new MemoryStorage(),
    getMediaDevices: () => ({
      enumerateDevices() {
        return new Promise((resolve) => pending.push(resolve));
      },
    }),
  });
  const older = selection.enumerate();
  const newer = selection.enumerate();
  pending[1]([audioInput("new", "New")]);
  assert.deepEqual(await newer, [{ deviceId: "new", label: "New" }]);
  pending[0]([audioInput("old", "Old")]);
  assert.deepEqual(await older, [{ deviceId: "new", label: "New" }]);
  assert.deepEqual(selection.devices, [{ deviceId: "new", label: "New" }]);
});

test("acquires Auto once with no device constraint", async () => {
  const stream = { id: "auto" };
  const calls = [];
  const selection = createMicrophoneSelection({
    getStorage: () => new MemoryStorage(),
    getMediaDevices: () => ({
      async getUserMedia(constraints) {
        calls.push(constraints);
        return stream;
      },
    }),
  });
  assert.deepEqual(await selection.acquire(), {
    stream,
    requestedId: "",
    activeId: "",
    fellBack: false,
  });
  assert.deepEqual(calls, [{ audio: true, video: false }]);
});

test("acquires the selected device exactly while preserving coaching processing choices", async () => {
  const storage = new MemoryStorage("studio");
  const calls = [];
  const stream = { id: "studio" };
  const selection = createMicrophoneSelection({
    getStorage: () => storage,
    getMediaDevices: () => ({
      async getUserMedia(constraints) {
        calls.push(constraints);
        return stream;
      },
    }),
  });
  const result = await selection.acquire({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  });
  assert.equal(result.stream, stream);
  assert.equal(result.requestedId, "studio");
  assert.equal(result.activeId, "studio");
  assert.equal(result.fellBack, false);
  assert.deepEqual(calls, [{
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      deviceId: { exact: "studio" },
    },
    video: false,
  }]);
});

test("a removed selected device clears its preference and falls back exactly once", async () => {
  const storage = new MemoryStorage("removed");
  const calls = [];
  const stream = { id: "fallback" };
  const selection = createMicrophoneSelection({
    getStorage: () => storage,
    getMediaDevices: () => ({
      async getUserMedia(constraints) {
        calls.push(constraints);
        if (calls.length === 1) throw mediaError("NotFoundError");
        return stream;
      },
    }),
  });
  assert.deepEqual(await selection.acquire(), {
    stream,
    requestedId: "removed",
    activeId: "",
    fellBack: true,
  });
  assert.equal(selection.selectedId, "");
  assert.equal(storage.value, null);
  assert.equal(storage.removes, 1);
  assert.deepEqual(calls, [
    { audio: { deviceId: { exact: "removed" } }, video: false },
    { audio: true, video: false },
  ]);
});

test("an unavailable in-flight request cannot erase a newer preference", async () => {
  const storage = new MemoryStorage("old-mic");
  const calls = [];
  let rejectOldRequest;
  const fallbackStream = { id: "auto-for-this-start" };
  const selection = createMicrophoneSelection({
    getStorage: () => storage,
    getMediaDevices: () => ({
      getUserMedia(constraints) {
        calls.push(constraints);
        if (calls.length === 1) {
          return new Promise((_resolve, reject) => { rejectOldRequest = reject; });
        }
        return Promise.resolve(fallbackStream);
      },
    }),
  });
  const acquisition = selection.acquire();
  assert.deepEqual(selection.select("newer-mic"), {
    selectedId: "newer-mic",
    persisted: true,
  });
  rejectOldRequest(mediaError("NotFoundError"));
  assert.deepEqual(await acquisition, {
    stream: fallbackStream,
    requestedId: "old-mic",
    activeId: "",
    fellBack: true,
  });
  assert.equal(selection.selectedId, "newer-mic");
  assert.equal(storage.value, "newer-mic");
  assert.equal(storage.removes, 0);
  assert.deepEqual(calls, [
    { audio: { deviceId: { exact: "old-mic" } }, video: false },
    { audio: true, video: false },
  ]);
});

test("deviceId overconstraint falls back but an unrelated constraint does not", async () => {
  assert.equal(isSelectedMicrophoneUnavailableError(mediaError("OverconstrainedError", "deviceId")), true);
  assert.equal(isSelectedMicrophoneUnavailableError(mediaError("OverconstrainedError")), true);
  assert.equal(isSelectedMicrophoneUnavailableError(mediaError("OverconstrainedError", "sampleRate")), false);
  assert.equal(isSelectedMicrophoneUnavailableError(mediaError("ConstraintNotSatisfiedError", "deviceId")), true);
  assert.equal(isSelectedMicrophoneUnavailableError(mediaError("ConstraintNotSatisfiedError", "channelCount")), false);

  const calls = [];
  const selection = createMicrophoneSelection({
    getStorage: () => new MemoryStorage("chosen"),
    getMediaDevices: () => ({
      async getUserMedia(constraints) {
        calls.push(constraints);
        throw mediaError("OverconstrainedError", "sampleRate");
      },
    }),
  });
  await assert.rejects(selection.acquire(), { name: "OverconstrainedError" });
  assert.equal(calls.length, 1);
  assert.equal(selection.selectedId, "chosen");
});

test("cancellation prevents fallback prompts and stops streams that resolve late", async () => {
  let current = false;
  let calls = 0;
  const initial = createMicrophoneSelection({
    getStorage: () => new MemoryStorage("chosen"),
    getMediaDevices: () => ({
      async getUserMedia() { calls += 1; return { getTracks: () => [] }; },
    }),
  });
  await assert.rejects(initial.acquire(true, { isCurrent: () => current }), { name: "AbortError" });
  assert.equal(calls, 0);

  const retainedStorage = new MemoryStorage("removed");
  current = true;
  let rejectSelected;
  calls = 0;
  const selected = createMicrophoneSelection({
    getStorage: () => retainedStorage,
    getMediaDevices: () => ({
      getUserMedia() {
        calls += 1;
        return new Promise((_resolve, reject) => { rejectSelected = reject; });
      },
    }),
  });
  const selectedRequest = selected.acquire(true, { isCurrent: () => current });
  current = false;
  rejectSelected(mediaError("NotFoundError"));
  await assert.rejects(selectedRequest, { name: "AbortError" });
  assert.equal(calls, 1, "a stale selected-device rejection must not trigger Auto-detect");
  assert.equal(selected.selectedId, "removed");
  assert.equal(retainedStorage.value, "removed");

  let resolveStream;
  let stops = 0;
  current = true;
  const automatic = createMicrophoneSelection({
    getStorage: () => new MemoryStorage(),
    getMediaDevices: () => ({
      getUserMedia() {
        return new Promise((resolve) => { resolveStream = resolve; });
      },
    }),
  });
  const automaticRequest = automatic.acquire(true, { isCurrent: () => current });
  current = false;
  resolveStream({ getTracks: () => [{ stop() { stops += 1; } }] });
  await assert.rejects(automaticRequest, { name: "AbortError" });
  assert.equal(stops, 1, "a stream resolving after cancellation must be stopped inside the module");

  let resolveFallback;
  current = true;
  const fallbackStorage = new MemoryStorage("removed-late");
  let fallbackCalls = 0;
  const fallback = createMicrophoneSelection({
    getStorage: () => fallbackStorage,
    getMediaDevices: () => ({
      getUserMedia() {
        fallbackCalls += 1;
        if (fallbackCalls === 1) return Promise.reject(mediaError("NotFoundError"));
        return new Promise((resolve) => { resolveFallback = resolve; });
      },
    }),
  });
  const fallbackRequest = fallback.acquire(true, { isCurrent: () => current });
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  resolveFallback({ getTracks: () => [{ stop() { stops += 1; } }] });
  await assert.rejects(fallbackRequest, { name: "AbortError" });
  assert.equal(fallbackCalls, 2);
  assert.equal(fallback.selectedId, "removed-late");
  assert.equal(fallbackStorage.value, "removed-late");
  assert.equal(stops, 2, "a stale fallback stream must also be stopped");
});

test("permission, security, and busy-device failures never cause a second prompt", async () => {
  for (const name of ["NotAllowedError", "SecurityError", "NotReadableError", "AbortError"]) {
    const storage = new MemoryStorage("chosen");
    let calls = 0;
    const selection = createMicrophoneSelection({
      getStorage: () => storage,
      getMediaDevices: () => ({
        async getUserMedia() {
          calls += 1;
          throw mediaError(name);
        },
      }),
    });
    await assert.rejects(selection.acquire(), { name });
    assert.equal(calls, 1, `${name} must not trigger a fallback permission request`);
    assert.equal(selection.selectedId, "chosen");
    assert.equal(storage.value, "chosen");
  }
});

test("Auto unavailability and a failed fallback remain bounded to one or two requests", async () => {
  let autoCalls = 0;
  const automatic = createMicrophoneSelection({
    getStorage: () => new MemoryStorage(),
    getMediaDevices: () => ({
      async getUserMedia() {
        autoCalls += 1;
        throw mediaError("NotFoundError");
      },
    }),
  });
  await assert.rejects(automatic.acquire(), { name: "NotFoundError" });
  assert.equal(autoCalls, 1);

  const selectedStorage = new MemoryStorage("removed");
  let selectedCalls = 0;
  const selected = createMicrophoneSelection({
    getStorage: () => selectedStorage,
    getMediaDevices: () => ({
      async getUserMedia() {
        selectedCalls += 1;
        throw mediaError("NotFoundError");
      },
    }),
  });
  await assert.rejects(selected.acquire(), { name: "NotFoundError" });
  assert.equal(selectedCalls, 2);
  assert.equal(selected.selectedId, "");
  assert.equal(selectedStorage.value, null);
});

test("missing getUserMedia fails before any browser request", async () => {
  for (const current of [null, {}, { enumerateDevices: async () => [] }]) {
    const selection = createMicrophoneSelection({
      getStorage: () => new MemoryStorage(),
      getMediaDevices: () => current,
    });
    await assert.rejects(selection.acquire(), { name: "NotSupportedError" });
  }
});

test("invalid dependency providers are rejected synchronously", () => {
  assert.throws(() => createMicrophoneSelection({ getStorage: null }), /getStorage must be a function/u);
  assert.throws(() => createMicrophoneSelection({ getMediaDevices: null }), /getMediaDevices must be a function/u);
});

test("acquire rejects an invalid cancellation guard before requesting hardware", async () => {
  let calls = 0;
  const selection = createMicrophoneSelection({
    getStorage: () => new MemoryStorage(),
    getMediaDevices: () => ({ getUserMedia: async () => { calls += 1; } }),
  });
  await assert.rejects(selection.acquire(true, { isCurrent: true }), /isCurrent must be a function/u);
  assert.equal(calls, 0);
});

test("enumerate rejects an invalid cancellation guard before requesting hardware", async () => {
  let calls = 0;
  const selection = createMicrophoneSelection({
    getStorage: () => new MemoryStorage(),
    getMediaDevices: () => ({ enumerateDevices: async () => { calls += 1; return []; } }),
  });
  await assert.rejects(selection.enumerate({ isCurrent: true }), /isCurrent must be a function/u);
  assert.equal(calls, 0);
});
