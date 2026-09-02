import assert from "node:assert/strict";
import test from "node:test";

import {
  SETUP_KIT_ERROR_CODES,
  SETUP_KIT_MAX_COUNT,
  SETUP_KIT_MAX_NAME_CODE_POINTS,
  SETUP_KIT_MAX_STORAGE_BYTES,
  SETUP_KIT_MAX_TOPIC_CODE_POINTS,
  SETUP_KIT_MAX_TOPIC_FILE_BYTES,
  SETUP_KIT_MAX_TOPIC_TEXT_CHARACTERS,
  SETUP_KIT_MAX_TOPICS,
  SETUP_KIT_PACK_IDS,
  SETUP_KIT_SCHEMA_VERSION,
  SETUP_KIT_STORAGE_KEY,
  SetupKitError,
  createSetupKitStore,
  normalizeSetupKit,
  parseTopicText,
  readTopicTextFile,
  serializeTopicText,
} from "./setup-kits.js";

class MemoryStorage {
  constructor(initial = null) {
    this.values = new Map();
    if (initial !== null) this.values.set(SETUP_KIT_STORAGE_KEY, initial);
    this.gets = 0;
    this.sets = 0;
    this.removes = 0;
  }

  getItem(key) {
    this.gets += 1;
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.sets += 1;
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.removes += 1;
    this.values.delete(key);
  }

  raw() {
    return this.values.get(SETUP_KIT_STORAGE_KEY) ?? null;
  }
}

function kit(overrides = {}) {
  return {
    name: "Quick round",
    duration: 45,
    silence: 3,
    rounds: 2,
    topicPack: "custom",
    topics: ["First topic", "Second topic"],
    ...overrides,
  };
}

function expectCode(operation, code) {
  let caught;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SetupKitError, `Expected SetupKitError ${code}`);
  assert.equal(caught.code, code);
  assert.equal(typeof caught.message, "string");
  assert.ok(caught.message.length > 0 && caught.message.length < 160);
  return caught;
}

function envelope(kits, overrides = {}) {
  return JSON.stringify({ schemaVersion: SETUP_KIT_SCHEMA_VERSION, kits, ...overrides });
}

test("exports the reviewed v1 setup-kit limits and fixed error-code vocabulary", () => {
  assert.equal(SETUP_KIT_STORAGE_KEY, "nonstoptalk.setup-kits.v1");
  assert.equal(SETUP_KIT_SCHEMA_VERSION, 1);
  assert.equal(SETUP_KIT_MAX_COUNT, 25);
  assert.equal(SETUP_KIT_MAX_NAME_CODE_POINTS, 40);
  assert.equal(SETUP_KIT_MAX_TOPICS, 500);
  assert.equal(SETUP_KIT_MAX_TOPIC_CODE_POINTS, 200);
  assert.equal(SETUP_KIT_MAX_TOPIC_TEXT_CHARACTERS, 20_000);
  assert.equal(SETUP_KIT_MAX_TOPIC_FILE_BYTES, 64 * 1024);
  assert.equal(SETUP_KIT_MAX_STORAGE_BYTES, 512 * 1024);
  assert.deepEqual(SETUP_KIT_PACK_IDS, ["everyday", "story", "absurd", "debate", "expert", "custom"]);
  assert.ok(Object.isFrozen(SETUP_KIT_PACK_IDS));
  assert.ok(Object.isFrozen(SETUP_KIT_ERROR_CODES));
  assert.equal(new Set(Object.values(SETUP_KIT_ERROR_CODES)).size,
    Object.values(SETUP_KIT_ERROR_CODES).length);
});

test("topic-file reads are byte-bounded before materializing text", async () => {
  let reads = 0;
  await assert.rejects(
    readTopicTextFile({
      size: SETUP_KIT_MAX_TOPIC_FILE_BYTES + 1,
      async text() {
        reads += 1;
        return "must not be read";
      },
    }),
    (error) => error instanceof SetupKitError
      && error.code === SETUP_KIT_ERROR_CODES.TOPIC_FILE_TOO_LARGE,
  );
  assert.equal(reads, 0);

  assert.deepEqual(await readTopicTextFile({
    size: SETUP_KIT_MAX_TOPIC_FILE_BYTES,
    async text() {
      reads += 1;
      return " First topic \r\nSECOND\nfirst topic ";
    },
  }), ["First topic", "SECOND"]);
  assert.equal(reads, 1);

  for (const file of [null, {}, { size: -1, text() {} }, { size: 1.5, text() {} }]) {
    await assert.rejects(
      readTopicTextFile(file),
      (error) => error instanceof SetupKitError
        && error.code === SETUP_KIT_ERROR_CODES.TOPIC_FILE_READ_FAILED,
    );
  }
  await assert.rejects(
    readTopicTextFile({ size: 1, async text() { throw new Error("private file error"); } }),
    (error) => error instanceof SetupKitError
      && error.code === SETUP_KIT_ERROR_CODES.TOPIC_FILE_READ_FAILED
      && !error.message.includes("private file error"),
  );
});

test("normalization returns an exact detached allowlist and canonicalizes built-in packs", () => {
  const topics = ["  First topic  ", "Second topic"];
  const normalized = normalizeSetupKit({
    ...kit({ name: "  Quick round  ", topics }),
    roomCode: "SECRET",
    playerNames: ["A", "B"],
    externalConsent: true,
    modelTheme: "private theme",
  });
  assert.deepEqual(normalized, {
    name: "Quick round",
    duration: 45,
    silence: 3,
    rounds: 2,
    topicPack: "custom",
    topics: ["First topic", "Second topic"],
  });
  topics[0] = "mutated input";
  assert.equal(normalized.topics[0], "First topic");
  assert.equal(JSON.stringify(normalized).includes("SECRET"), false);
  assert.equal(JSON.stringify(normalized).includes("private theme"), false);

  const builtIn = normalizeSetupKit(kit({ topicPack: "story", topics: ["Stale copied pack topic"] }));
  assert.deepEqual(builtIn.topics, []);
});

test("names use Unicode code points and settings require exact in-range integers", () => {
  const fortyEmoji = "🚀".repeat(40);
  assert.equal(normalizeSetupKit(kit({ name: fortyEmoji })).name, fortyEmoji);
  expectCode(() => normalizeSetupKit(kit({ name: "🚀".repeat(41) })), SETUP_KIT_ERROR_CODES.INVALID_NAME);
  for (const name of [null, "", " \uFEFF "]) {
    expectCode(() => normalizeSetupKit(kit({ name })), SETUP_KIT_ERROR_CODES.INVALID_NAME);
  }

  for (const change of [
    { duration: 9 }, { duration: 301 }, { duration: "45" }, { duration: 45.5 },
    { silence: 0 }, { silence: 11 }, { silence: "3" },
    { rounds: 0 }, { rounds: 11 }, { rounds: Number.NaN },
  ]) {
    expectCode(() => normalizeSetupKit(kit(change)), SETUP_KIT_ERROR_CODES.INVALID_SETTINGS);
  }
  assert.deepEqual(
    normalizeSetupKit(kit({ duration: 10, silence: 1, rounds: 1 })).duration,
    10,
  );
  assert.deepEqual(
    normalizeSetupKit(kit({ duration: 300, silence: 10, rounds: 10 })).rounds,
    10,
  );
});

test("only reviewed pack IDs and bounded canonical custom topics are accepted", () => {
  for (const topicPack of SETUP_KIT_PACK_IDS) {
    const value = normalizeSetupKit(kit({
      topicPack,
      topics: topicPack === "custom" ? ["One"] : ["ignored canonical pack copy"],
    }));
    assert.equal(value.topicPack, topicPack);
    assert.deepEqual(value.topics, topicPack === "custom" ? ["One"] : []);
  }
  for (const topicPack of ["", "CUSTOM", "future", null]) {
    expectCode(() => normalizeSetupKit(kit({ topicPack })), SETUP_KIT_ERROR_CODES.INVALID_TOPIC_PACK);
  }
  for (const topics of [null, [], [1], [""], ["one\ntwo"], ["Same", "same"]]) {
    expectCode(() => normalizeSetupKit(kit({ topics })), SETUP_KIT_ERROR_CODES.INVALID_TOPICS);
  }
  expectCode(
    () => normalizeSetupKit(kit({ topics: ["x".repeat(201)] })),
    SETUP_KIT_ERROR_CODES.TOPIC_TOO_LONG,
  );
  expectCode(
    () => normalizeSetupKit(kit({ topics: Array.from({ length: 501 }, (_, index) => `Topic ${index}`) })),
    SETUP_KIT_ERROR_CODES.TOO_MANY_TOPICS,
  );
  const aggregateTooLong = Array.from(
    { length: 102 },
    (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(196)}`,
  );
  expectCode(
    () => normalizeSetupKit(kit({ topics: aggregateTooLong })),
    SETUP_KIT_ERROR_CODES.TOPIC_TEXT_TOO_LONG,
  );
});

test("plain-text parsing normalizes newlines, game whitespace, duplicates, and ill-formed Unicode", () => {
  assert.deepEqual(
    parseTopicText("  First topic  \r\nSecond topic\rFIRST TOPIC\n\u0085Third topic\uFEFF\n\ud800"),
    ["First topic", "Second topic", "Third topic", "�"],
  );
  const source = "One\r\nTwo\rThree\none\n";
  const parsed = parseTopicText(source);
  source.replace("One", "changed");
  assert.deepEqual(parsed, ["One", "Two", "Three"]);
});

test("topic deduplication is independent of the browser locale", () => {
  const originalLocaleLowerCase = String.prototype.toLocaleLowerCase;
  String.prototype.toLocaleLowerCase = function forcedTurkishLocale() {
    return originalLocaleLowerCase.call(this, "tr-TR");
  };
  try {
    assert.deepEqual(parseTopicText("İ\ni\u0307"), ["İ"]);
    expectCode(
      () => normalizeSetupKit(kit({ topics: ["İ", "i\u0307"] })),
      SETUP_KIT_ERROR_CODES.INVALID_TOPICS,
    );
  } finally {
    String.prototype.toLocaleLowerCase = originalLocaleLowerCase;
  }
});

test("plain-text parsing rejects empty and every reviewed topic boundary", () => {
  expectCode(() => parseTopicText(null), SETUP_KIT_ERROR_CODES.INVALID_TOPICS);
  expectCode(() => parseTopicText(" \n\t\r\n"), SETUP_KIT_ERROR_CODES.INVALID_TOPICS);
  expectCode(
    () => parseTopicText("x".repeat(SETUP_KIT_MAX_TOPIC_TEXT_CHARACTERS + 1)),
    SETUP_KIT_ERROR_CODES.TOPIC_TEXT_TOO_LONG,
  );
  expectCode(
    () => parseTopicText("x".repeat(SETUP_KIT_MAX_TOPIC_CODE_POINTS + 1)),
    SETUP_KIT_ERROR_CODES.TOPIC_TOO_LONG,
  );
  expectCode(
    () => parseTopicText(Array.from({ length: SETUP_KIT_MAX_TOPICS + 1 }, (_, index) => `T${index}`).join("\n")),
    SETUP_KIT_ERROR_CODES.TOO_MANY_TOPICS,
  );
});

test("plain-text serialization validates arrays and round-trips the exact 20,000-character boundary", () => {
  assert.equal(serializeTopicText([" Topic one ", "Topic two"]), "Topic one\nTopic two");
  assert.equal(serializeTopicText(["🚀".repeat(200)]), "🚀".repeat(200));
  expectCode(() => serializeTopicText([]), SETUP_KIT_ERROR_CODES.INVALID_TOPICS);
  expectCode(() => serializeTopicText(["one", "ONE"]), SETUP_KIT_ERROR_CODES.INVALID_TOPICS);
  expectCode(() => serializeTopicText(["one\ntwo"]), SETUP_KIT_ERROR_CODES.INVALID_TOPICS);

  const boundary = Array.from({ length: 100 }, (_, index) => {
    const prefix = `T${String(index).padStart(3, "0")}`;
    return `${prefix}${"x".repeat((index === 99 ? 200 : 199) - prefix.length)}`;
  });
  const serialized = serializeTopicText(boundary);
  assert.equal(serialized.length, SETUP_KIT_MAX_TOPIC_TEXT_CHARACTERS);
  assert.deepEqual(parseTopicText(serialized), boundary);
});

test("the store writes one unique versioned array envelope and returns detached clones", () => {
  const storage = new MemoryStorage();
  const store = createSetupKitStore({ storage });
  assert.deepEqual(store.list(), []);
  assert.equal(storage.sets, 0);

  const input = kit({ extra: "not stored" });
  const saved = store.save(input);
  input.topics[0] = "changed input";
  saved.topics[0] = "changed result";

  assert.deepEqual(JSON.parse(storage.raw()), {
    schemaVersion: 1,
    kits: [{
      name: "Quick round",
      duration: 45,
      silence: 3,
      rounds: 2,
      topicPack: "custom",
      topics: ["First topic", "Second topic"],
    }],
  });
  const listed = store.list();
  listed[0].topics[0] = "changed list";
  assert.equal(store.get("Quick round").topics[0], "First topic");
  assert.equal(JSON.stringify(storage.raw()).includes("not stored"), false);
});

test("duplicate saves require exact explicit overwrite and retain insertion order", () => {
  const storage = new MemoryStorage();
  const store = createSetupKitStore({ storage });
  store.save(kit({ name: "First" }));
  store.save(kit({ name: "Second", duration: 60 }));
  const beforeDuplicate = storage.raw();

  expectCode(() => store.save(kit({ name: "First", duration: 90 })), SETUP_KIT_ERROR_CODES.DUPLICATE_NAME);
  expectCode(
    () => store.save(kit({ name: "First", duration: 90 }), { overwrite: "true" }),
    SETUP_KIT_ERROR_CODES.DUPLICATE_NAME,
  );
  assert.equal(storage.raw(), beforeDuplicate);

  store.save(kit({ name: "First", duration: 90 }), { overwrite: true });
  assert.deepEqual(store.list().map(({ name, duration }) => ({ name, duration })), [
    { name: "First", duration: 90 },
    { name: "Second", duration: 60 },
  ]);
});

test("the 25-kit limit rejects a new name without blocking an explicit overwrite", () => {
  const storage = new MemoryStorage();
  const store = createSetupKitStore({ storage });
  for (let index = 0; index < SETUP_KIT_MAX_COUNT; index += 1) {
    store.save(kit({ name: `Kit ${index}`, topics: [`Topic ${index}`] }));
  }
  const before = storage.raw();
  expectCode(() => store.save(kit({ name: "One too many" })), SETUP_KIT_ERROR_CODES.KIT_LIMIT_REACHED);
  assert.equal(storage.raw(), before);
  store.save(kit({ name: "Kit 0", duration: 120, topics: ["Replacement"] }), { overwrite: true });
  assert.equal(store.list().length, SETUP_KIT_MAX_COUNT);
  assert.equal(store.get("Kit 0").duration, 120);
});

test("get and remove use the exact canonical case-sensitive name", () => {
  const storage = new MemoryStorage();
  const store = createSetupKitStore({ storage });
  store.save(kit({ name: "Exact Name" }));
  const before = storage.raw();
  assert.equal(store.get("exact name"), null);
  assert.equal(store.remove("exact name"), false);
  assert.equal(storage.raw(), before);
  expectCode(() => store.remove(" Exact Name "), SETUP_KIT_ERROR_CODES.INVALID_NAME);
  assert.equal(store.remove("Exact Name"), true);
  assert.equal(store.remove("Exact Name"), false);
  assert.equal(storage.raw(), null);
  assert.equal(storage.removes, 1);
});

test("corrupt envelopes fail closed and no mutation path overwrites their bytes", () => {
  const canonical = normalizeSetupKit(kit());
  const cases = [
    "{",
    "[]",
    JSON.stringify({ schemaVersion: 1, kits: [], extra: true }),
    JSON.stringify({ schemaVersion: "1", kits: [] }),
    JSON.stringify({ schemaVersion: 1, kits: {} }),
    envelope(Array.from({ length: 26 }, () => canonical)),
    envelope([{ ...canonical, extra: "not reviewed" }]),
    envelope([{ ...canonical, name: " Quick round " }]),
    envelope([{ ...canonical, duration: 9 }]),
    envelope([{ ...canonical, topicPack: "story", topics: ["copied built-in"] }]),
    envelope([canonical, canonical]),
  ];

  for (const raw of cases) {
    const storage = new MemoryStorage(raw);
    const store = createSetupKitStore({ storage });
    expectCode(() => store.list(), SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT);
    expectCode(() => store.save(kit({ name: "Replacement" })), SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT);
    expectCode(() => store.remove("Quick round"), SETUP_KIT_ERROR_CODES.STORAGE_CORRUPT);
    assert.equal(storage.raw(), raw);
    assert.equal(storage.sets, 0);
    assert.equal(storage.removes, 0);
  }
});

test("future-version and oversized envelopes are preserved byte-for-byte", () => {
  const future = JSON.stringify({ schemaVersion: 2, kits: [] });
  const futureStorage = new MemoryStorage(future);
  const futureStore = createSetupKitStore({ storage: futureStorage });
  expectCode(() => futureStore.list(), SETUP_KIT_ERROR_CODES.STORAGE_VERSION_UNSUPPORTED);
  expectCode(() => futureStore.save(kit()), SETUP_KIT_ERROR_CODES.STORAGE_VERSION_UNSUPPORTED);
  expectCode(() => futureStore.remove("Quick round"), SETUP_KIT_ERROR_CODES.STORAGE_VERSION_UNSUPPORTED);
  assert.equal(futureStorage.raw(), future);
  assert.equal(futureStorage.sets, 0);
  assert.equal(futureStorage.removes, 0);

  const oversized = "x".repeat(SETUP_KIT_MAX_STORAGE_BYTES + 1);
  const oversizedStorage = new MemoryStorage(oversized);
  const oversizedStore = createSetupKitStore({ storage: oversizedStorage });
  expectCode(() => oversizedStore.list(), SETUP_KIT_ERROR_CODES.STORAGE_LIMIT_EXCEEDED);
  expectCode(() => oversizedStore.save(kit()), SETUP_KIT_ERROR_CODES.STORAGE_LIMIT_EXCEEDED);
  expectCode(() => oversizedStore.remove("Quick round"), SETUP_KIT_ERROR_CODES.STORAGE_LIMIT_EXCEEDED);
  assert.equal(oversizedStorage.raw(), oversized);
  assert.equal(oversizedStorage.sets, 0);
  assert.equal(oversizedStorage.removes, 0);
});

test("storage availability, read, write, remove, and quota failures use fixed safe errors", () => {
  const unavailable = createSetupKitStore({ storage: null });
  assert.ok(Object.isFrozen(unavailable));
  expectCode(() => unavailable.list(), SETUP_KIT_ERROR_CODES.STORAGE_UNAVAILABLE);
  expectCode(() => unavailable.get("Anything"), SETUP_KIT_ERROR_CODES.STORAGE_UNAVAILABLE);
  expectCode(() => unavailable.save(kit()), SETUP_KIT_ERROR_CODES.STORAGE_UNAVAILABLE);
  expectCode(() => unavailable.remove("Anything"), SETUP_KIT_ERROR_CODES.STORAGE_UNAVAILABLE);

  const incomplete = createSetupKitStore({ storage: { getItem() {}, setItem() {} } });
  expectCode(() => incomplete.list(), SETUP_KIT_ERROR_CODES.STORAGE_UNAVAILABLE);

  const readFailure = new MemoryStorage(envelope([normalizeSetupKit(kit())]));
  const beforeReadFailure = readFailure.raw();
  readFailure.getItem = () => { throw new Error("private browser detail"); };
  const readError = expectCode(
    () => createSetupKitStore({ storage: readFailure }).list(),
    SETUP_KIT_ERROR_CODES.STORAGE_READ_FAILED,
  );
  assert.equal(readError.message.includes("private browser detail"), false);
  expectCode(
    () => createSetupKitStore({ storage: readFailure }).save(kit({ name: "New" })),
    SETUP_KIT_ERROR_CODES.STORAGE_READ_FAILED,
  );
  expectCode(
    () => createSetupKitStore({ storage: readFailure }).remove("Quick round"),
    SETUP_KIT_ERROR_CODES.STORAGE_READ_FAILED,
  );
  assert.equal(readFailure.raw(), beforeReadFailure);
  assert.equal(readFailure.sets, 0);
  assert.equal(readFailure.removes, 0);

  for (const [thrown, code] of [
    [Object.assign(new Error("private quota detail"), { name: "QuotaExceededError" }),
      SETUP_KIT_ERROR_CODES.STORAGE_QUOTA_EXCEEDED],
    [new Error("private write detail"), SETUP_KIT_ERROR_CODES.STORAGE_WRITE_FAILED],
  ]) {
    const storage = new MemoryStorage();
    const store = createSetupKitStore({ storage });
    store.save(kit({ name: "Existing" }));
    const before = storage.raw();
    storage.setItem = () => { throw thrown; };
    const error = expectCode(() => store.save(kit({ name: "New" })), code);
    assert.equal(error.message.includes("private"), false);
    assert.equal(storage.raw(), before);
  }

  const removeFailure = new MemoryStorage();
  const removeStore = createSetupKitStore({ storage: removeFailure });
  removeStore.save(kit({ name: "Existing" }));
  const beforeRemove = removeFailure.raw();
  removeFailure.removeItem = () => { throw new Error("private removal detail"); };
  expectCode(() => removeStore.remove("Existing"), SETUP_KIT_ERROR_CODES.STORAGE_WRITE_FAILED);
  assert.equal(removeFailure.raw(), beforeRemove);

  const quotaRemoveFailure = new MemoryStorage();
  const quotaRemoveStore = createSetupKitStore({ storage: quotaRemoveFailure });
  quotaRemoveStore.save(kit({ name: "Existing" }));
  const beforeQuotaRemove = quotaRemoveFailure.raw();
  quotaRemoveFailure.removeItem = () => {
    throw Object.assign(new Error("private quota detail"), { code: 22 });
  };
  expectCode(
    () => quotaRemoveStore.remove("Existing"),
    SETUP_KIT_ERROR_CODES.STORAGE_QUOTA_EXCEEDED,
  );
  assert.equal(quotaRemoveFailure.raw(), beforeQuotaRemove);
});

test("default browser storage is resolved lazily so a blocked getter cannot break app import", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let accesses = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      accesses += 1;
      throw new Error("private storage policy detail");
    },
  });
  try {
    const store = createSetupKitStore();
    assert.equal(accesses, 0);
    const error = expectCode(() => store.list(), SETUP_KIT_ERROR_CODES.STORAGE_UNAVAILABLE);
    assert.equal(accesses, 1);
    assert.equal(error.message.includes("private"), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});

test("a replacement that would exceed 512 KiB is rejected before Storage is called", () => {
  const storage = new MemoryStorage();
  const store = createSetupKitStore({ storage });
  const largeTopics = Array.from({ length: 49 }, (_, index) => `${String(index).padStart(2, "0")}${"🚀".repeat(198)}`);
  let limitReached = false;
  for (let index = 0; index < SETUP_KIT_MAX_COUNT; index += 1) {
    const before = storage.raw();
    const setsBefore = storage.sets;
    try {
      store.save(kit({ name: `Large ${index}`, topics: largeTopics }));
    } catch (error) {
      assert.ok(error instanceof SetupKitError);
      assert.equal(error.code, SETUP_KIT_ERROR_CODES.STORAGE_LIMIT_EXCEEDED);
      assert.equal(storage.raw(), before);
      assert.equal(storage.sets, setsBefore);
      limitReached = true;
      break;
    }
  }
  assert.equal(limitReached, true, "The UTF-8 storage ceiling was not reached by the bounded fixture");
  assert.ok(new TextEncoder().encode(storage.raw()).byteLength <= SETUP_KIT_MAX_STORAGE_BYTES);
});
