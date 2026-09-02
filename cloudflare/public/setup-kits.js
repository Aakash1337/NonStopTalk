export const SETUP_KIT_STORAGE_KEY = "nonstoptalk.setup-kits.v1";
export const SETUP_KIT_SCHEMA_VERSION = 1;
export const SETUP_KIT_MAX_COUNT = 25;
export const SETUP_KIT_MAX_NAME_CODE_POINTS = 40;
export const SETUP_KIT_MAX_TOPICS = 500;
export const SETUP_KIT_MAX_TOPIC_CODE_POINTS = 200;
export const SETUP_KIT_MAX_TOPIC_TEXT_CHARACTERS = 20_000;
export const SETUP_KIT_MAX_STORAGE_BYTES = 512 * 1024;
export const SETUP_KIT_PACK_IDS = Object.freeze([
  "everyday",
  "story",
  "absurd",
  "debate",
  "expert",
  "custom",
]);

export const SETUP_KIT_ERROR_CODES = Object.freeze({
  INVALID_KIT: "INVALID_KIT",
  INVALID_NAME: "INVALID_NAME",
  INVALID_SETTINGS: "INVALID_SETTINGS",
  INVALID_TOPIC_PACK: "INVALID_TOPIC_PACK",
  INVALID_TOPICS: "INVALID_TOPICS",
  TOPIC_TEXT_TOO_LONG: "TOPIC_TEXT_TOO_LONG",
  TOPIC_TOO_LONG: "TOPIC_TOO_LONG",
  TOO_MANY_TOPICS: "TOO_MANY_TOPICS",
  DUPLICATE_NAME: "DUPLICATE_NAME",
  KIT_LIMIT_REACHED: "KIT_LIMIT_REACHED",
  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
  STORAGE_READ_FAILED: "STORAGE_READ_FAILED",
  STORAGE_WRITE_FAILED: "STORAGE_WRITE_FAILED",
  STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",
  STORAGE_CORRUPT: "STORAGE_CORRUPT",
  STORAGE_VERSION_UNSUPPORTED: "STORAGE_VERSION_UNSUPPORTED",
  STORAGE_LIMIT_EXCEEDED: "STORAGE_LIMIT_EXCEEDED",
});

const ERROR_MESSAGES = Object.freeze({
  [SETUP_KIT_ERROR_CODES.INVALID_KIT]: "Setup kit data is invalid.",
  [SETUP_KIT_ERROR_CODES.INVALID_NAME]:
    `Enter a setup kit name of ${SETUP_KIT_MAX_NAME_CODE_POINTS} characters or fewer.`,
  [SETUP_KIT_ERROR_CODES.INVALID_SETTINGS]: "Setup kit settings are invalid.",
  [SETUP_KIT_ERROR_CODES.INVALID_TOPIC_PACK]: "Setup kit topic pack is invalid.",
  [SETUP_KIT_ERROR_CODES.INVALID_TOPICS]: "Setup kit custom topics are invalid.",
  [SETUP_KIT_ERROR_CODES.TOPIC_TEXT_TOO_LONG]:
    `Custom topic text must be ${SETUP_KIT_MAX_TOPIC_TEXT_CHARACTERS.toLocaleString("en-US")} characters or fewer.`,
  [SETUP_KIT_ERROR_CODES.TOPIC_TOO_LONG]:
    `Each custom topic must be ${SETUP_KIT_MAX_TOPIC_CODE_POINTS} characters or fewer.`,
  [SETUP_KIT_ERROR_CODES.TOO_MANY_TOPICS]:
    `A setup kit can contain at most ${SETUP_KIT_MAX_TOPICS} custom topics.`,
  [SETUP_KIT_ERROR_CODES.DUPLICATE_NAME]: "A setup kit with that exact name already exists.",
  [SETUP_KIT_ERROR_CODES.KIT_LIMIT_REACHED]:
    `This browser can store at most ${SETUP_KIT_MAX_COUNT} setup kits.`,
  [SETUP_KIT_ERROR_CODES.STORAGE_UNAVAILABLE]: "Local setup kit storage is unavailable in this browser.",
  [SETUP_KIT_ERROR_CODES.STORAGE_READ_FAILED]: "Saved setup kits could not be read.",
  [SETUP_KIT_ERROR_CODES.STORAGE_WRITE_FAILED]: "Saved setup kits could not be updated.",
  [SETUP_KIT_ERROR_CODES.STORAGE_QUOTA_EXCEEDED]: "This browser has no space available for that setup kit.",
  [SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT]: "Saved setup kits are invalid and were left unchanged.",
  [SETUP_KIT_ERROR_CODES.STORAGE_VERSION_UNSUPPORTED]:
    "Saved setup kits use an unsupported version and were left unchanged.",
  [SETUP_KIT_ERROR_CODES.STORAGE_LIMIT_EXCEEDED]:
    "Saved setup kits exceed the 512 KiB safety limit and were left unchanged.",
});

const KIT_KEYS = Object.freeze(["name", "duration", "silence", "rounds", "topicPack", "topics"]);
const ENVELOPE_KEYS = Object.freeze(["schemaVersion", "kits"]);
const BUILT_IN_PACK_IDS = new Set(SETUP_KIT_PACK_IDS.filter((id) => id !== "custom"));
const PACK_IDS = new Set(SETUP_KIT_PACK_IDS);
const utf8 = new TextEncoder();

export class SetupKitError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES[SETUP_KIT_ERROR_CODES.INVALID_KIT]);
    this.name = "SetupKitError";
    this.code = Object.values(SETUP_KIT_ERROR_CODES).includes(code)
      ? code
      : SETUP_KIT_ERROR_CODES.INVALID_KIT;
  }
}

/** Return one detached, allowlisted setup-kit record or throw a safe typed error. */
export function normalizeSetupKit(value) {
  if (!isRecord(value)) fail(SETUP_KIT_ERROR_CODES.INVALID_KIT);

  const name = normalizeName(value.name);
  const duration = boundedInteger(value.duration, 10, 300);
  const silence = boundedInteger(value.silence, 1, 10);
  const rounds = boundedInteger(value.rounds, 1, 10);
  if (duration === null || silence === null || rounds === null) {
    fail(SETUP_KIT_ERROR_CODES.INVALID_SETTINGS);
  }

  const topicPack = typeof value.topicPack === "string" ? value.topicPack : "";
  if (!PACK_IDS.has(topicPack)) fail(SETUP_KIT_ERROR_CODES.INVALID_TOPIC_PACK);

  const topics = BUILT_IN_PACK_IDS.has(topicPack) ? [] : normalizeTopicArray(value.topics);
  return { name, duration, silence, rounds, topicPack, topics };
}

/** Parse one-topic-per-line text without retaining or uploading the source text. */
export function parseTopicText(value) {
  if (typeof value !== "string") fail(SETUP_KIT_ERROR_CODES.INVALID_TOPICS);
  if (value.length > SETUP_KIT_MAX_TOPIC_TEXT_CHARACTERS) {
    fail(SETUP_KIT_ERROR_CODES.TOPIC_TEXT_TOO_LONG);
  }

  const topics = [];
  const seen = new Set();
  for (const line of value.replace(/\r\n?/gu, "\n").split("\n")) {
    const topic = trimGameSpace(line.toWellFormed());
    if (!topic) continue;
    if (codePointLength(topic) > SETUP_KIT_MAX_TOPIC_CODE_POINTS) {
      fail(SETUP_KIT_ERROR_CODES.TOPIC_TOO_LONG);
    }
    // Locale-independent folding must match the Worker even when the browser
    // runs under a locale with special casing rules (for example Turkish).
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length > SETUP_KIT_MAX_TOPICS) {
      fail(SETUP_KIT_ERROR_CODES.TOO_MANY_TOPICS);
    }
  }
  if (!topics.length) fail(SETUP_KIT_ERROR_CODES.INVALID_TOPICS);
  assertTopicTextLength(topics);
  return [...topics];
}

/** Serialize validated topics as bounded, self-round-tripping plain text. */
export function serializeTopicText(value) {
  return normalizeTopicArray(value).join("\n");
}

/**
 * Create a synchronous, dependency-injected local setup-kit store.
 *
 * The adapter never repairs malformed or future data in place. Every mutation
 * first reads and validates the complete old envelope, then prepares a bounded
 * replacement before asking Storage to commit it.
 */
export function createSetupKitStore({ storage } = {}) {
  // Resolving the browser default is deliberately lazy. Merely importing the
  // app must remain safe when privacy settings block access to localStorage.
  const resolveStorage = storage === undefined
    ? () => requireStorage(defaultStorage())
    : () => requireStorage(storage);

  return Object.freeze({
    list() {
      const localStorage = resolveStorage();
      return cloneKits(readEnvelope(localStorage).kits);
    },
    get(name) {
      const localStorage = resolveStorage();
      const exactName = exactStoredName(name);
      const kit = readEnvelope(localStorage).kits.find((candidate) => candidate.name === exactName);
      return kit ? cloneKit(kit) : null;
    },
    save(value, { overwrite = false } = {}) {
      const localStorage = resolveStorage();
      // Read first so an invalid/future envelope can never be replaced by a
      // caller that happens to supply a valid new record.
      const envelope = readEnvelope(localStorage);
      const kit = normalizeSetupKit(value);
      const index = envelope.kits.findIndex((candidate) => candidate.name === kit.name);
      if (index >= 0 && overwrite !== true) fail(SETUP_KIT_ERROR_CODES.DUPLICATE_NAME);
      if (index < 0 && envelope.kits.length >= SETUP_KIT_MAX_COUNT) {
        fail(SETUP_KIT_ERROR_CODES.KIT_LIMIT_REACHED);
      }

      const kits = cloneKits(envelope.kits);
      if (index >= 0) kits[index] = kit;
      else kits.push(kit);
      writeEnvelope(localStorage, { schemaVersion: SETUP_KIT_SCHEMA_VERSION, kits });
      return cloneKit(kit);
    },
    remove(name) {
      const localStorage = resolveStorage();
      const exactName = exactStoredName(name);
      const envelope = readEnvelope(localStorage);
      const index = envelope.kits.findIndex((candidate) => candidate.name === exactName);
      if (index < 0) return false;

      const kits = cloneKits(envelope.kits);
      kits.splice(index, 1);
      if (!kits.length) removeStoredEnvelope(localStorage);
      else writeEnvelope(localStorage, { schemaVersion: SETUP_KIT_SCHEMA_VERSION, kits });
      return true;
    },
  });
}

function normalizeTopicArray(value) {
  if (!Array.isArray(value) || !value.length) fail(SETUP_KIT_ERROR_CODES.INVALID_TOPICS);
  if (value.length > SETUP_KIT_MAX_TOPICS) fail(SETUP_KIT_ERROR_CODES.TOO_MANY_TOPICS);

  const topics = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string") fail(SETUP_KIT_ERROR_CODES.INVALID_TOPICS);
    const topic = trimGameSpace(item.toWellFormed());
    if (!topic || /[\r\n]/u.test(topic)) fail(SETUP_KIT_ERROR_CODES.INVALID_TOPICS);
    if (codePointLength(topic) > SETUP_KIT_MAX_TOPIC_CODE_POINTS) {
      fail(SETUP_KIT_ERROR_CODES.TOPIC_TOO_LONG);
    }
    const key = topic.toLowerCase();
    if (seen.has(key)) fail(SETUP_KIT_ERROR_CODES.INVALID_TOPICS);
    seen.add(key);
    topics.push(topic);
  }
  assertTopicTextLength(topics);
  return topics;
}

function normalizeName(value) {
  if (typeof value !== "string") fail(SETUP_KIT_ERROR_CODES.INVALID_NAME);
  const name = trimGameSpace(value.toWellFormed());
  if (!name || codePointLength(name) > SETUP_KIT_MAX_NAME_CODE_POINTS) {
    fail(SETUP_KIT_ERROR_CODES.INVALID_NAME);
  }
  return name;
}

function exactStoredName(value) {
  if (typeof value !== "string" || value !== value.toWellFormed() || value !== trimGameSpace(value)) {
    fail(SETUP_KIT_ERROR_CODES.INVALID_NAME);
  }
  if (!value || codePointLength(value) > SETUP_KIT_MAX_NAME_CODE_POINTS) {
    fail(SETUP_KIT_ERROR_CODES.INVALID_NAME);
  }
  return value;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function assertTopicTextLength(topics) {
  if (topics.join("\n").length > SETUP_KIT_MAX_TOPIC_TEXT_CHARACTERS) {
    fail(SETUP_KIT_ERROR_CODES.TOPIC_TEXT_TOO_LONG);
  }
}

function readEnvelope(storage) {
  let raw;
  try {
    raw = storage.getItem(SETUP_KIT_STORAGE_KEY);
  } catch {
    fail(SETUP_KIT_ERROR_CODES.STORAGE_READ_FAILED);
  }
  if (raw === null) return { schemaVersion: SETUP_KIT_SCHEMA_VERSION, kits: [] };
  if (typeof raw !== "string") fail(SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT);
  if (serializedBytes(raw) > SETUP_KIT_MAX_STORAGE_BYTES) {
    fail(SETUP_KIT_ERROR_CODES.STORAGE_LIMIT_EXCEEDED);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT);
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ENVELOPE_KEYS)) {
    fail(SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT);
  }
  if (Number.isSafeInteger(parsed.schemaVersion) && parsed.schemaVersion !== SETUP_KIT_SCHEMA_VERSION) {
    fail(SETUP_KIT_ERROR_CODES.STORAGE_VERSION_UNSUPPORTED);
  }
  if (parsed.schemaVersion !== SETUP_KIT_SCHEMA_VERSION || !Array.isArray(parsed.kits)) {
    fail(SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT);
  }
  if (parsed.kits.length > SETUP_KIT_MAX_COUNT) fail(SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT);

  const kits = [];
  const names = new Set();
  for (const stored of parsed.kits) {
    if (!isRecord(stored) || !hasExactKeys(stored, KIT_KEYS)) {
      fail(SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT);
    }
    let kit;
    try {
      kit = normalizeSetupKit(stored);
    } catch {
      fail(SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT);
    }
    if (!isCanonicalStoredKit(stored, kit) || names.has(kit.name)) {
      fail(SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT);
    }
    names.add(kit.name);
    kits.push(kit);
  }
  return { schemaVersion: SETUP_KIT_SCHEMA_VERSION, kits };
}

function writeEnvelope(storage, envelope) {
  const serialized = JSON.stringify({
    schemaVersion: SETUP_KIT_SCHEMA_VERSION,
    kits: cloneKits(envelope.kits),
  });
  if (serializedBytes(serialized) > SETUP_KIT_MAX_STORAGE_BYTES) {
    fail(SETUP_KIT_ERROR_CODES.STORAGE_LIMIT_EXCEEDED);
  }
  try {
    storage.setItem(SETUP_KIT_STORAGE_KEY, serialized);
  } catch (error) {
    fail(isQuotaError(error)
      ? SETUP_KIT_ERROR_CODES.STORAGE_QUOTA_EXCEEDED
      : SETUP_KIT_ERROR_CODES.STORAGE_WRITE_FAILED);
  }
}

function removeStoredEnvelope(storage) {
  try {
    storage.removeItem(SETUP_KIT_STORAGE_KEY);
  } catch (error) {
    fail(isQuotaError(error)
      ? SETUP_KIT_ERROR_CODES.STORAGE_QUOTA_EXCEEDED
      : SETUP_KIT_ERROR_CODES.STORAGE_WRITE_FAILED);
  }
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function requireStorage(storage) {
  try {
    if (
      !storage
      || typeof storage.getItem !== "function"
      || typeof storage.setItem !== "function"
      || typeof storage.removeItem !== "function"
    ) {
      fail(SETUP_KIT_ERROR_CODES.STORAGE_UNAVAILABLE);
    }
  } catch (error) {
    if (error instanceof SetupKitError) throw error;
    fail(SETUP_KIT_ERROR_CODES.STORAGE_UNAVAILABLE);
  }
  return storage;
}

function isQuotaError(error) {
  try {
    return Boolean(error) && (
      error.name === "QuotaExceededError"
      || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
      || error.code === 22
      || error.code === 1014
    );
  } catch {
    return false;
  }
}

function cloneKit(kit) {
  return {
    name: kit.name,
    duration: kit.duration,
    silence: kit.silence,
    rounds: kit.rounds,
    topicPack: kit.topicPack,
    topics: [...kit.topics],
  };
}

function cloneKits(kits) {
  return kits.map(cloneKit);
}

function isCanonicalStoredKit(stored, canonical) {
  return stored.name === canonical.name
    && stored.duration === canonical.duration
    && stored.silence === canonical.silence
    && stored.rounds === canonical.rounds
    && stored.topicPack === canonical.topicPack
    && Array.isArray(stored.topics)
    && stored.topics.length === canonical.topics.length
    && stored.topics.every((topic, index) => topic === canonical.topics[index]);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const reviewed = [...expected].sort();
  return keys.length === reviewed.length && keys.every((key, index) => key === reviewed[index]);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimGameSpace(value) {
  return value.replace(/^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu, "");
}

function codePointLength(value) {
  return [...value].length;
}

function serializedBytes(value) {
  return utf8.encode(value).byteLength;
}

function fail(code) {
  throw new SetupKitError(code);
}
