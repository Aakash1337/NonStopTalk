export const TURN_TRANSCRIPT_MAX_BYTES = 8 * 1024;
export const TURN_TRANSCRIPT_RETENTION_MS = 15_000;

const DEFAULT_LANGUAGE = "en-US";
const DEFAULT_SETTLE_MS = 250;
const MAX_TRANSCRIPT_RETENTION_MS = 60_000;
const utf8 = new TextEncoder();

function lifecycleError(message, name) {
  if (typeof globalThis.DOMException === "function") return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}

export class TurnTranscriptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TurnTranscriptionError";
    this.code = code;
  }
}

export function normalizeTurnTranscript(value, maxBytes = TURN_TRANSCRIPT_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > TURN_TRANSCRIPT_MAX_BYTES) {
    throw new TypeError("maxBytes must be a positive safe integer within the transcript boundary");
  }
  const normalized = String(value ?? "")
    .toWellFormed()
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (utf8.encode(normalized).byteLength <= maxBytes) return normalized;

  let result = "";
  let bytes = 0;
  for (const character of normalized) {
    const length = utf8.encode(character).byteLength;
    if (bytes + length > maxBytes) break;
    result += character;
    bytes += length;
  }
  return result.trimEnd();
}

/**
 * Own the short-lived transcript reference between local recognition and the
 * dedicated judge request. The same abort signal covers the classic submit
 * that must finish first and the later transcript request, so route teardown
 * or the overall deadline releases both the retained text and active fetch.
 */
export function createTurnTranscriptDeliveryManager({
  retentionMs = TURN_TRANSCRIPT_RETENTION_MS,
  createAbortController = () => new globalThis.AbortController(),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
} = {}) {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1 || retentionMs > MAX_TRANSCRIPT_RETENTION_MS) {
    throw new TypeError("retentionMs must be a safe integer from 1 to 60000");
  }
  if (typeof createAbortController !== "function") {
    throw new TypeError("createAbortController must be a function");
  }
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
    throw new TypeError("setTimer and clearTimer must be functions");
  }

  const active = new Set();

  function begin(value) {
    let retainedTranscript = normalizeTurnTranscript(value);
    if (!retainedTranscript) throw new TypeError("A non-empty normalized transcript is required");

    let abortController;
    try {
      abortController = createAbortController();
    } catch {
      retainedTranscript = "";
      throw new TypeError("createAbortController could not create an AbortController-compatible value");
    }
    if (!abortController || typeof abortController.abort !== "function" || !abortController.signal) {
      retainedTranscript = "";
      throw new TypeError("createAbortController must return an AbortController-compatible value");
    }

    let state = "retained";
    let timedOut = false;
    let timer = null;

    function finish(nextState, { abort = false, reason } = {}) {
      if (state === "complete" || state === "discarded" || state === "timed-out") return false;
      state = nextState;
      retainedTranscript = "";
      if (timer !== null) clearTimer(timer);
      timer = null;
      active.delete(delivery);
      if (abort && !abortController.signal.aborted) {
        try {
          abortController.abort(reason);
        } catch {
          // Text is already wiped even if a non-standard controller rejects abort.
        }
      }
      return true;
    }

    const delivery = Object.freeze({
      get signal() { return abortController.signal; },
      get state() { return state; },
      get timedOut() { return timedOut; },
      async deliver(send) {
        if (typeof send !== "function") throw new TypeError("send must be a function");
        // A duplicate caller must not cancel the first in-flight delivery or
        // clear its deadline. Only the owner that moved retained -> sending
        // is allowed to finish this lease.
        if (state === "sending") {
          return Object.freeze({ attempted: false, value: undefined });
        }
        if (state !== "retained" || abortController.signal.aborted) {
          finish(timedOut ? "timed-out" : "discarded");
          return Object.freeze({ attempted: false, value: undefined });
        }

        state = "sending";
        let privateTranscript = retainedTranscript;
        retainedTranscript = "";
        try {
          const result = await send(privateTranscript, abortController.signal);
          return Object.freeze({ attempted: true, value: result });
        } finally {
          privateTranscript = "";
          finish("complete");
        }
      },
      discard(reason) {
        return finish(timedOut ? "timed-out" : "discarded", { abort: true, reason });
      },
    });

    active.add(delivery);
    try {
      timer = setTimer(() => {
        timedOut = true;
        delivery.discard(lifecycleError("The transcript retention deadline expired.", "TimeoutError"));
      }, retentionMs);
    } catch (error) {
      delivery.discard(error);
      throw error;
    }
    return delivery;
  }

  function abortAll(reason = lifecycleError("The page lifecycle ended.", "AbortError")) {
    const count = active.size;
    for (const delivery of [...active]) delivery.discard(reason);
    return count;
  }

  return Object.freeze({
    begin,
    abortAll,
    get activeCount() { return active.size; },
  });
}

export function localTurnTranscriptionCapability({ getRecognitionConstructor } = {}) {
  const resolveConstructor = getRecognitionConstructor ?? (() => (
    globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition
  ));
  let probe;
  try {
    const Recognition = resolveConstructor();
    if (typeof Recognition !== "function") {
      return { supported: false, code: "recognition-unavailable" };
    }
    probe = new Recognition();
    if (!("processLocally" in probe)) {
      return { supported: false, code: "local-processing-unavailable" };
    }
    try {
      probe.processLocally = true;
    } catch {
      return { supported: false, code: "local-processing-unavailable" };
    }
    if (probe.processLocally !== true) {
      return { supported: false, code: "local-processing-unavailable" };
    }
    return { supported: true, code: "available" };
  } catch {
    return { supported: false, code: "recognition-unavailable" };
  } finally {
    try {
      probe?.abort?.();
    } catch {
      // Capability probes retain no transcript and are best-effort to close.
    }
  }
}

export function createTurnTranscription({
  getRecognitionConstructor,
  getLanguage = () => globalThis.document?.documentElement?.lang || DEFAULT_LANGUAGE,
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
} = {}) {
  const resolveConstructor = getRecognitionConstructor ?? (() => (
    globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition
  ));
  let active = null;

  function capability() {
    return localTurnTranscriptionCapability({ getRecognitionConstructor: resolveConstructor });
  }

  function releaseSession(session, { abort = false } = {}) {
    if (!session || session.released) return;
    session.released = true;
    session.transcript = "";
    session.recognition.onresult = null;
    session.recognition.onerror = null;
    session.recognition.onend = null;
    if (session.timer) clearTimer(session.timer);
    session.timer = 0;
    if (abort) {
      try {
        session.recognition.abort?.();
      } catch {
        // The recognizer may already be stopped.
      }
    }
    if (active === session) active = null;
    session.resolveEnd?.();
    session.resolveEnd = null;
  }

  function failSession(session) {
    if (!session || session.released || session.failed) return;
    session.failed = true;
    session.transcript = "";
    try {
      session.onFailure();
    } catch {
      // UI failure reporting cannot change the privacy fallback.
    }
    try {
      session.recognition.abort?.();
    } catch {
      // The recognizer may already be stopped.
    }
    session.resolveEnd?.();
    session.resolveEnd = null;
  }

  function sessionIsCurrent(session) {
    if (!session || session !== active || session.released) return false;
    try {
      return session.isCurrent() === true;
    } catch {
      return false;
    }
  }

  function start({ turnId, track, isCurrent = () => true, onFailure = () => {} } = {}) {
    const normalizedTurnId = typeof turnId === "string" ? turnId.trim() : "";
    if (!normalizedTurnId) {
      throw new TurnTranscriptionError("invalid-turn", "The turn is no longer available for transcription.");
    }
    if (!track || track.kind !== "audio" || track.readyState !== "live") {
      throw new TurnTranscriptionError("invalid-track", "On-device transcription needs the active microphone track.");
    }
    if (typeof isCurrent !== "function" || typeof onFailure !== "function") {
      throw new TypeError("isCurrent and onFailure must be functions");
    }

    discard();
    const Recognition = resolveConstructor();
    if (typeof Recognition !== "function") {
      throw new TurnTranscriptionError("recognition-unavailable", "On-device transcription is unavailable in this browser.");
    }

    let recognition;
    try {
      recognition = new Recognition();
      if (!("processLocally" in recognition)) {
        throw new TurnTranscriptionError("local-processing-unavailable", "This browser cannot guarantee on-device transcription.");
      }
      try {
        recognition.processLocally = true;
      } catch {
        throw new TurnTranscriptionError("local-processing-unavailable", "This browser cannot guarantee on-device transcription.");
      }
      if (recognition.processLocally !== true) {
        throw new TurnTranscriptionError("local-processing-unavailable", "This browser cannot guarantee on-device transcription.");
      }
    } catch (error) {
      if (error instanceof TurnTranscriptionError) throw error;
      throw new TurnTranscriptionError("recognition-unavailable", "On-device transcription could not be initialized.");
    }

    const session = {
      turnId: normalizedTurnId,
      track,
      recognition,
      isCurrent,
      onFailure,
      transcript: "",
      failed: false,
      finishing: false,
      released: false,
      timer: 0,
      resolveEnd: null,
    };
    active = session;
    try {
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = String(getLanguage() || DEFAULT_LANGUAGE).slice(0, 64);
    } catch {
      releaseSession(session, { abort: true });
      throw new TurnTranscriptionError("recognition-unavailable", "On-device transcription could not be configured.");
    }
    recognition.onresult = (event) => {
      if (!sessionIsCurrent(session) || session.failed) {
        failSession(session);
        return;
      }
      const startIndex = Number.isSafeInteger(event?.resultIndex) ? event.resultIndex : 0;
      const results = event?.results;
      if (!results || !Number.isSafeInteger(results.length)) return;
      for (let index = startIndex; index < results.length; index += 1) {
        const result = results[index];
        if (!result?.isFinal || !result[0]) continue;
        session.transcript = normalizeTurnTranscript(
          `${session.transcript} ${String(result[0].transcript ?? "")}`,
        );
      }
    };
    recognition.onerror = () => failSession(session);
    recognition.onend = () => {
      if (session.released) return;
      if (session.finishing || session.failed) {
        session.resolveEnd?.();
        session.resolveEnd = null;
        return;
      }
      if (!sessionIsCurrent(session) || session.track.readyState !== "live") {
        failSession(session);
        return;
      }
      try {
        recognition.start(session.track);
      } catch {
        failSession(session);
      }
    };

    if (!sessionIsCurrent(session)) {
      releaseSession(session, { abort: true });
      throw new TurnTranscriptionError("stale-turn", "The turn changed before transcription started.");
    }
    try {
      recognition.start(track);
    } catch {
      releaseSession(session, { abort: true });
      throw new TurnTranscriptionError("recognition-start-failed", "On-device transcription could not start with this microphone.");
    }
    return { started: true, turnId: normalizedTurnId };
  }

  async function finish(turnId, { settleMs = DEFAULT_SETTLE_MS } = {}) {
    const session = active;
    if (!session || session.turnId !== turnId || session.released) return "";
    if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 1_000) {
      throw new TypeError("settleMs must be a safe integer from 0 to 1000");
    }
    if (!sessionIsCurrent(session)) {
      releaseSession(session, { abort: true });
      return "";
    }
    session.finishing = true;
    await new Promise((resolve) => {
      session.resolveEnd = resolve;
      session.timer = setTimer(resolve, settleMs);
      try {
        session.recognition.stop?.();
      } catch {
        resolve();
      }
    });
    if (session.timer) clearTimer(session.timer);
    session.timer = 0;
    const transcript = !session.failed && sessionIsCurrent(session)
      ? normalizeTurnTranscript(session.transcript)
      : "";
    // `stop()` is allowed to take time and some implementations never emit
    // `end`. Abort after copying the final text so capture cannot outlive this
    // bounded finish operation.
    releaseSession(session, { abort: true });
    return transcript;
  }

  function discard(turnId) {
    const session = active;
    if (!session || (turnId !== undefined && session.turnId !== turnId)) return false;
    releaseSession(session, { abort: true });
    return true;
  }

  return Object.freeze({
    capability,
    start,
    finish,
    discard,
    get activeTurnId() { return active?.turnId ?? ""; },
  });
}
