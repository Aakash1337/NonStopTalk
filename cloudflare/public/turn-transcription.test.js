import assert from "node:assert/strict";
import test from "node:test";

import {
  TURN_TRANSCRIPT_MAX_BYTES,
  TURN_TRANSCRIPT_RETENTION_MS,
  TurnTranscriptionError,
  createTurnTranscriptDeliveryManager,
  createTurnTranscription,
  localTurnTranscriptionCapability,
  normalizeTurnTranscript,
} from "./turn-transcription.js";

const utf8 = new TextEncoder();

function recognitionHarness({ localProperty = true } = {}) {
  const instances = [];
  class Recognition {
    constructor() {
      this.starts = [];
      this.stopCount = 0;
      this.abortCount = 0;
      if (localProperty) this.processLocally = false;
      instances.push(this);
    }

    start(track) {
      this.starts.push(track);
    }

    stop() {
      this.stopCount += 1;
      this.onend?.();
    }

    abort() {
      this.abortCount += 1;
    }
  }
  return { Recognition, instances };
}

function finalResult(transcript, isFinal = true) {
  const result = [{ transcript }];
  result.isFinal = isFinal;
  return result;
}

function liveTrack() {
  return { kind: "audio", readyState: "live", id: "selected-track" };
}

function timerHarness() {
  let nextId = 1;
  const pending = new Map();
  const cleared = [];
  return {
    setTimer(callback, delay) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      cleared.push(id);
      pending.delete(id);
    },
    fire(id) {
      const timer = pending.get(id);
      if (!timer) return false;
      pending.delete(id);
      timer.callback();
      return true;
    },
    fireAll() {
      for (const id of [...pending.keys()]) this.fire(id);
    },
    pending,
    cleared,
  };
}

test("transcript normalization is whitespace-safe and capped on a UTF-8 boundary", () => {
  assert.equal(normalizeTurnTranscript("  hello\n\tworld\u0000  "), "hello world");
  assert.equal(normalizeTurnTranscript("Cafe\u0301 \ud800"), "Caf\u00e9 �");
  const oversized = `start ${"🙂".repeat(TURN_TRANSCRIPT_MAX_BYTES)} end`;
  const normalized = normalizeTurnTranscript(oversized);
  assert.ok(utf8.encode(normalized).byteLength <= TURN_TRANSCRIPT_MAX_BYTES);
  assert.ok(normalized.startsWith("start 🙂"));
  assert.equal(normalized.includes("�"), false);
  assert.throws(() => normalizeTurnTranscript("text", 0), TypeError);
  assert.throws(() => normalizeTurnTranscript("text", TURN_TRANSCRIPT_MAX_BYTES + 1), TypeError);
});

test("capability requires a constructible recognizer with writable retained local processing", () => {
  assert.deepEqual(localTurnTranscriptionCapability({ getRecognitionConstructor: () => null }), {
    supported: false,
    code: "recognition-unavailable",
  });

  const missing = recognitionHarness({ localProperty: false });
  assert.deepEqual(localTurnTranscriptionCapability({ getRecognitionConstructor: () => missing.Recognition }), {
    supported: false,
    code: "local-processing-unavailable",
  });
  assert.equal(missing.instances[0].abortCount, 1);

  const available = recognitionHarness();
  assert.deepEqual(localTurnTranscriptionCapability({ getRecognitionConstructor: () => available.Recognition }), {
    supported: true,
    code: "available",
  });
  assert.equal(available.instances[0].processLocally, true);
  assert.equal(available.instances[0].abortCount, 1);

  class FixedRemoteRecognition {
    constructor() {
      Object.defineProperty(this, "processLocally", { value: false, writable: false });
    }
    abort() {}
  }
  assert.deepEqual(localTurnTranscriptionCapability({ getRecognitionConstructor: () => FixedRemoteRecognition }), {
    supported: false,
    code: "local-processing-unavailable",
  });
});

test("start requires the exact live audio-track shape and configures final-only local recognition", () => {
  const harness = recognitionHarness();
  const transcription = createTurnTranscription({
    getRecognitionConstructor: () => harness.Recognition,
    getLanguage: () => "en-GB",
  });
  assert.throws(
    () => transcription.start({ turnId: "t1", track: { kind: "video", readyState: "live" } }),
    (error) => error instanceof TurnTranscriptionError && error.code === "invalid-track",
  );
  assert.throws(
    () => transcription.start({ turnId: "t1", track: { kind: "audio", readyState: "ended" } }),
    (error) => error instanceof TurnTranscriptionError && error.code === "invalid-track",
  );

  const track = liveTrack();
  assert.deepEqual(transcription.start({ turnId: "t1", track }), { started: true, turnId: "t1" });
  const recognition = harness.instances[0];
  assert.equal(recognition.processLocally, true);
  assert.equal(recognition.continuous, true);
  assert.equal(recognition.interimResults, false);
  assert.equal(recognition.lang, "en-GB");
  assert.deepEqual(recognition.starts, [track]);
  assert.equal(transcription.activeTurnId, "t1");
});

test("only final results are accumulated and finish returns once before wiping memory", async () => {
  const harness = recognitionHarness();
  const transcription = createTurnTranscription({ getRecognitionConstructor: () => harness.Recognition });
  const track = liveTrack();
  transcription.start({ turnId: "t7", track });
  const recognition = harness.instances[0];
  recognition.onresult({
    resultIndex: 0,
    results: [
      finalResult(" ignored interim ", false),
      finalResult(" first final "),
      finalResult(" second\nfinal "),
    ],
  });
  assert.equal(await transcription.finish("other", { settleMs: 0 }), "");
  assert.equal(await transcription.finish("t7", { settleMs: 0 }), "first final second final");
  assert.equal(recognition.stopCount, 1);
  assert.equal(recognition.abortCount, 1);
  assert.equal(transcription.activeTurnId, "");
  assert.equal(await transcription.finish("t7", { settleMs: 0 }), "");
});

test("recognition failure clears all text and invokes only a transcript-free fallback callback", async () => {
  const harness = recognitionHarness();
  let failures = 0;
  const transcription = createTurnTranscription({ getRecognitionConstructor: () => harness.Recognition });
  transcription.start({ turnId: "t2", track: liveTrack(), onFailure: () => { failures += 1; } });
  const recognition = harness.instances[0];
  recognition.onresult({ resultIndex: 0, results: [finalResult("private words")] });
  recognition.onerror({ error: "network", message: "private words must not escape" });
  recognition.onerror({ error: "again" });
  assert.equal(failures, 1);
  assert.equal(recognition.abortCount, 1);
  assert.equal(await transcription.finish("t2", { settleMs: 0 }), "");
  assert.equal(transcription.activeTurnId, "");
});

test("premature end restarts only while the same turn and exact track remain current", async () => {
  const harness = recognitionHarness();
  let current = true;
  let failures = 0;
  const transcription = createTurnTranscription({ getRecognitionConstructor: () => harness.Recognition });
  const track = liveTrack();
  transcription.start({
    turnId: "t3",
    track,
    isCurrent: () => current,
    onFailure: () => { failures += 1; },
  });
  const recognition = harness.instances[0];
  recognition.onend();
  assert.deepEqual(recognition.starts, [track, track]);
  current = false;
  recognition.onend();
  assert.equal(failures, 1);
  assert.equal(await transcription.finish("t3", { settleMs: 0 }), "");
});

test("discard aborts and wipes a session without touching a different turn", () => {
  const harness = recognitionHarness();
  const transcription = createTurnTranscription({ getRecognitionConstructor: () => harness.Recognition });
  transcription.start({ turnId: "t4", track: liveTrack() });
  const recognition = harness.instances[0];
  recognition.onresult({ resultIndex: 0, results: [finalResult("discard me")] });
  assert.equal(transcription.discard("t5"), false);
  assert.equal(transcription.activeTurnId, "t4");
  assert.equal(transcription.discard("t4"), true);
  assert.equal(recognition.abortCount, 1);
  assert.equal(transcription.activeTurnId, "");
  assert.equal(transcription.discard(), false);
});

test("a stale turn is rejected before recognition starts and is immediately released", () => {
  const harness = recognitionHarness();
  const transcription = createTurnTranscription({ getRecognitionConstructor: () => harness.Recognition });
  assert.throws(
    () => transcription.start({ turnId: "t9", track: liveTrack(), isCurrent: () => false }),
    (error) => error instanceof TurnTranscriptionError && error.code === "stale-turn",
  );
  assert.equal(harness.instances[0].starts.length, 0);
  assert.equal(harness.instances[0].abortCount, 1);
  assert.equal(transcription.activeTurnId, "");
});

test("starting a replacement turn aborts and wipes the prior transcript", async () => {
  const harness = recognitionHarness();
  const transcription = createTurnTranscription({ getRecognitionConstructor: () => harness.Recognition });
  transcription.start({ turnId: "t10", track: liveTrack() });
  harness.instances[0].onresult({ resultIndex: 0, results: [finalResult("prior private words")] });

  transcription.start({ turnId: "t11", track: liveTrack() });
  assert.equal(harness.instances[0].abortCount, 1);
  assert.equal(await transcription.finish("t10", { settleMs: 0 }), "");
  assert.equal(await transcription.finish("t11", { settleMs: 0 }), "");
});

test("finish is bounded when a recognizer never emits its end event", async () => {
  const harness = recognitionHarness();
  harness.Recognition.prototype.stop = function stopWithoutEnd() {
    this.stopCount += 1;
  };
  const transcription = createTurnTranscription({ getRecognitionConstructor: () => harness.Recognition });
  transcription.start({ turnId: "t12", track: liveTrack() });
  harness.instances[0].onresult({ resultIndex: 0, results: [finalResult("bounded final words")] });

  assert.equal(await transcription.finish("t12", { settleMs: 0 }), "bounded final words");
  assert.equal(harness.instances[0].stopCount, 1);
  assert.equal(harness.instances[0].abortCount, 1);
  assert.equal(transcription.activeTurnId, "");
});

test("transcript delivery uses one bounded lease across classic submit and judge fetch", async () => {
  const timers = timerHarness();
  const manager = createTurnTranscriptDeliveryManager({
    retentionMs: 321,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const delivery = manager.begin("  private\nturn words  ");
  assert.equal(manager.activeCount, 1);
  assert.equal(delivery.state, "retained");
  assert.equal(delivery.signal.aborted, false);
  assert.equal([...timers.pending.values()][0].delay, 321);

  let judgeStarted = false;
  const request = delivery.deliver((transcript, signal) => {
    judgeStarted = true;
    assert.equal(transcript, "private turn words");
    assert.equal(signal, delivery.signal, "the retained-phase signal must continue into fetch");
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  assert.equal(judgeStarted, true);
  assert.equal(delivery.state, "sending");

  timers.fireAll();
  await assert.rejects(request, (error) => error?.name === "TimeoutError");
  assert.equal(delivery.timedOut, true);
  assert.equal(delivery.state, "timed-out");
  assert.equal(delivery.signal.aborted, true);
  assert.equal(manager.activeCount, 0);
});

test("a transcript that expires while classic scoring is pending is wiped and never delivered", async () => {
  const timers = timerHarness();
  const manager = createTurnTranscriptDeliveryManager({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const delivery = manager.begin("do not outlive the submit request");
  assert.equal([...timers.pending.values()][0].delay, TURN_TRANSCRIPT_RETENTION_MS);

  timers.fireAll();
  let called = false;
  assert.deepEqual(await delivery.deliver(() => {
    called = true;
  }), { attempted: false, value: undefined });
  assert.equal(called, false);
  assert.equal(delivery.state, "timed-out");
  assert.equal(manager.activeCount, 0);
});

test("successful delivery clears its deadline without aborting the completed request", async () => {
  const timers = timerHarness();
  const manager = createTurnTranscriptDeliveryManager({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const delivery = manager.begin("deliver once");
  assert.deepEqual(await delivery.deliver(async (transcript, signal) => {
    assert.equal(transcript, "deliver once");
    assert.equal(signal.aborted, false);
    return 204;
  }), { attempted: true, value: 204 });
  assert.equal(delivery.state, "complete");
  assert.equal(delivery.signal.aborted, false);
  assert.equal(manager.activeCount, 0);
  assert.deepEqual(timers.cleared, [1]);
  assert.equal(timers.pending.size, 0);
});

test("a duplicate delivery cannot cancel the first in-flight request or its deadline", async () => {
  const timers = timerHarness();
  const manager = createTurnTranscriptDeliveryManager({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const delivery = manager.begin("deliver exactly once");
  let release;
  const first = delivery.deliver((transcript, signal) => new Promise((resolve) => {
    assert.equal(transcript, "deliver exactly once");
    assert.equal(signal.aborted, false);
    release = resolve;
  }));

  assert.deepEqual(await delivery.deliver(() => {
    throw new Error("a duplicate sender must never run");
  }), { attempted: false, value: undefined });
  assert.equal(delivery.state, "sending");
  assert.equal(manager.activeCount, 1);
  assert.equal(timers.pending.size, 1, "the first request must retain its original deadline");

  release(201);
  assert.deepEqual(await first, { attempted: true, value: 201 });
  assert.equal(delivery.state, "complete");
  assert.equal(manager.activeCount, 0);
});

test("route teardown aborts every retained or in-flight transcript delivery exactly once", async () => {
  const timers = timerHarness();
  const manager = createTurnTranscriptDeliveryManager({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const retained = manager.begin("retained text");
  const sending = manager.begin("in flight text");
  const request = sending.deliver((_transcript, signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));

  const reason = new DOMException("route changed", "AbortError");
  assert.equal(manager.abortAll(reason), 2);
  await assert.rejects(request, (error) => error === reason);
  assert.equal(retained.signal.aborted, true);
  assert.equal(sending.signal.aborted, true);
  assert.equal(retained.state, "discarded");
  assert.equal(sending.state, "discarded");
  assert.equal(manager.activeCount, 0);
  assert.equal(manager.abortAll(reason), 0);
  let called = false;
  assert.deepEqual(await retained.deliver(() => { called = true; }), {
    attempted: false,
    value: undefined,
  });
  assert.equal(called, false);
});

test("transcript delivery validates its lifetime, dependencies, and private input", () => {
  assert.throws(() => createTurnTranscriptDeliveryManager({ retentionMs: 0 }), TypeError);
  assert.throws(() => createTurnTranscriptDeliveryManager({ retentionMs: 60_001 }), TypeError);
  assert.throws(() => createTurnTranscriptDeliveryManager({ createAbortController: null }), TypeError);
  assert.throws(() => createTurnTranscriptDeliveryManager({ setTimer: null }), TypeError);
  const manager = createTurnTranscriptDeliveryManager();
  assert.throws(() => manager.begin(" \n "), /non-empty normalized transcript/u);
  const invalid = createTurnTranscriptDeliveryManager({ createAbortController: () => ({}) });
  assert.throws(() => invalid.begin("private"), /AbortController-compatible/u);
});
