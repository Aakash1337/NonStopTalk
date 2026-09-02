import assert from "node:assert/strict";
import test from "node:test";

import {
	SOUND_CUE_LEGACY_STORAGE_KEY,
	SOUND_CUE_NAMES,
	SOUND_CUE_STORAGE_KEY,
	createDeferredFinalCueTracker,
	createSoundCues,
} from "./sound-cues.js";

class MemoryStorage {
	constructor(values = {}) {
		this.values = new Map(Object.entries(values));
		this.calls = [];
		this.fail = new Set();
	}

	getItem(key) {
		this.calls.push(["get", key]);
		if (this.fail.has(`get:${key}`) || this.fail.has("get")) throw new Error("read blocked");
		return this.values.get(key) ?? null;
	}

	setItem(key, value) {
		this.calls.push(["set", key, String(value)]);
		if (this.fail.has(`set:${key}`) || this.fail.has("set")) throw new Error("write blocked");
		this.values.set(key, String(value));
	}

	removeItem(key) {
		this.calls.push(["remove", key]);
		if (this.fail.has(`remove:${key}`) || this.fail.has("remove")) throw new Error("remove blocked");
		this.values.delete(key);
	}
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function audioHarness({
	initialState = "running",
	currentTime = 10,
	resume,
	close,
	failAt = "",
} = {}) {
	const instances = [];
	const events = [];

	class FakeAudioContext {
		constructor() {
			if (failAt === "constructor") throw new Error("constructor failed");
			this.state = initialState;
			this.currentTime = currentTime;
			this.destination = { kind: "destination" };
			this.oscillators = [];
			this.amplifiers = [];
			this.closeCalls = 0;
			instances.push(this);
			events.push("constructed");
		}

		resume() {
			events.push("resume-called");
			if (failAt === "resume-throw") throw new Error("resume failed");
			if (resume) return resume(this, events);
			this.state = "running";
			return Promise.resolve();
		}

		createOscillator() {
			if (failAt === "oscillator") throw new Error("oscillator failed");
			const oscillator = {
				type: "sine",
				frequency: { value: 0 },
				connections: [],
				starts: [],
				stops: [],
				disconnectCalls: 0,
				onended: null,
				connect(target) {
					if (failAt === "oscillator-connect") throw new Error("connect failed");
					this.connections.push(target);
				},
				start(at) {
					if (failAt === "start") throw new Error("start failed");
					this.starts.push(at);
				},
				stop(at) {
					if (failAt === "stop" && at !== undefined) throw new Error("stop failed");
					this.stops.push(at);
				},
				disconnect() { this.disconnectCalls += 1; },
				end() { this.onended?.(); },
			};
			this.oscillators.push(oscillator);
			return oscillator;
		}

		createGain() {
			if (failAt === "gain") throw new Error("gain failed");
			const gain = {
				events: [],
				connections: [],
				disconnectCalls: 0,
				gain: {
					setValueAtTime: (value, at) => {
						if (failAt === "gain-envelope") throw new Error("envelope failed");
						gain.events.push(["set", value, at]);
					},
					exponentialRampToValueAtTime: (value, at) => gain.events.push(["ramp", value, at]),
				},
				connect(target) {
					if (failAt === "gain-connect") throw new Error("gain connect failed");
					this.connections.push(target);
				},
				disconnect() { this.disconnectCalls += 1; },
			};
			this.amplifiers.push(gain);
			return gain;
		}

		close() {
			this.closeCalls += 1;
			events.push("close-called");
			if (failAt === "close-throw") throw new Error("close failed");
			if (close) return close(this, events);
			this.state = "closed";
			return Promise.resolve();
		}
	}

	return { FakeAudioContext, instances, events };
}

function makeCues({ storage = new MemoryStorage(), harness = audioHarness() } = {}) {
	const cues = createSoundCues({
		getStorage: () => storage,
		getAudioContextConstructor: () => harness.FakeAudioContext,
	});
	return { cues, storage, harness };
}

test("exports the reviewed keys and closed cue vocabulary", () => {
	assert.equal(SOUND_CUE_STORAGE_KEY, "nonstoptalk.sound");
	assert.equal(SOUND_CUE_LEGACY_STORAGE_KEY, "dont-stop-talking.sound");
	assert.deepEqual(SOUND_CUE_NAMES, {
		START: "start",
		TICK: "tick",
		SILENCE_WARNING: "silence-warning",
		ELIMINATED: "eliminated",
		COMPLETED: "completed",
	});
	assert(Object.isFrozen(SOUND_CUE_NAMES));
});

test("validates dependency providers without touching browser globals", () => {
	assert.throws(() => createSoundCues({ getStorage: null }), /getStorage must be a function/u);
	assert.throws(
		() => createSoundCues({ getAudioContextConstructor: {} }),
		/getAudioContextConstructor must be a function/u,
	);
});

test("defaults on without constructing an AudioContext", () => {
	const { cues, harness } = makeCues();
	assert.equal(cues.enabled, true);
	assert.equal(cues.supported, true);
	assert.equal(cues.storageKey, SOUND_CUE_STORAGE_KEY);
	assert.deepEqual(cues.storageKeys, [SOUND_CUE_STORAGE_KEY, SOUND_CUE_LEGACY_STORAGE_KEY]);
	assert(Object.isFrozen(cues.storageKeys));
	assert(Object.isFrozen(cues));
	assert.equal(harness.instances.length, 0);
});

test("canonical off wins over and removes a conflicting legacy preference", () => {
	const storage = new MemoryStorage({
		[SOUND_CUE_STORAGE_KEY]: "off",
		[SOUND_CUE_LEGACY_STORAGE_KEY]: "on",
	});
	const { cues } = makeCues({ storage });
	assert.equal(cues.enabled, false);
	assert.equal(storage.values.get(SOUND_CUE_STORAGE_KEY), "off");
	assert.equal(storage.values.has(SOUND_CUE_LEGACY_STORAGE_KEY), false);
});

test("any non-off canonical value retains legacy semantics and is repaired to default-on absence", () => {
	const storage = new MemoryStorage({
		[SOUND_CUE_STORAGE_KEY]: "ON",
		[SOUND_CUE_LEGACY_STORAGE_KEY]: "off",
	});
	const { cues } = makeCues({ storage });
	assert.equal(cues.enabled, true);
	assert.equal(storage.values.has(SOUND_CUE_STORAGE_KEY), false);
	assert.equal(storage.values.has(SOUND_CUE_LEGACY_STORAGE_KEY), false);
});

test("migrates both enabled and disabled legacy values to canonical semantics", () => {
	const disabledStorage = new MemoryStorage({ [SOUND_CUE_LEGACY_STORAGE_KEY]: "off" });
	const disabled = makeCues({ storage: disabledStorage }).cues;
	assert.equal(disabled.enabled, false);
	assert.equal(disabledStorage.values.get(SOUND_CUE_STORAGE_KEY), "off");
	assert.equal(disabledStorage.values.has(SOUND_CUE_LEGACY_STORAGE_KEY), false);

	const enabledStorage = new MemoryStorage({ [SOUND_CUE_LEGACY_STORAGE_KEY]: "anything-else" });
	const enabled = makeCues({ storage: enabledStorage }).cues;
	assert.equal(enabled.enabled, true);
	assert.equal(enabledStorage.values.has(SOUND_CUE_STORAGE_KEY), false);
	assert.equal(enabledStorage.values.has(SOUND_CUE_LEGACY_STORAGE_KEY), false);
});

test("blocked and malformed storage preserve safe in-memory operation", () => {
	const storage = new MemoryStorage();
	const { cues } = makeCues({ storage });
	assert.equal(cues.setEnabled(false).persisted, true);
	storage.fail.add("get");
	assert.equal(cues.reload(), false, "a transient read failure must not unexpectedly enable sound");

	const unavailable = createSoundCues({
		getStorage: () => ({ get getItem() { throw new Error("blocked"); } }),
		getAudioContextConstructor: () => null,
	});
	assert.equal(unavailable.enabled, true);
	assert.deepEqual(unavailable.setEnabled(false), { enabled: false, persisted: false });
	assert.equal(unavailable.reload(), false);
});

test("setEnabled and toggle use off-only persistence and return frozen observations", () => {
	const storage = new MemoryStorage({ [SOUND_CUE_LEGACY_STORAGE_KEY]: "off" });
	const { cues } = makeCues({ storage });
	const on = cues.setEnabled(true);
	assert.deepEqual(on, { enabled: true, persisted: true });
	assert(Object.isFrozen(on));
	assert.equal(storage.values.has(SOUND_CUE_STORAGE_KEY), false);
	assert.equal(storage.values.has(SOUND_CUE_LEGACY_STORAGE_KEY), false);

	const off = cues.toggle();
	assert.deepEqual(off, { enabled: false, persisted: true });
	assert.equal(storage.values.get(SOUND_CUE_STORAGE_KEY), "off");
	assert.throws(() => cues.setEnabled("false"), /enabled must be a boolean/u);
});

test("a persistence failure changes only this tab's in-memory preference", () => {
	const storage = new MemoryStorage();
	storage.fail.add("set");
	const { cues } = makeCues({ storage });
	assert.deepEqual(cues.setEnabled(false), { enabled: false, persisted: false });
	assert.equal(cues.enabled, false);
	assert.equal(storage.values.has(SOUND_CUE_STORAGE_KEY), false);
});

test("unsupported and throwing constructors remain inert", async () => {
	const unsupported = createSoundCues({
		getStorage: () => null,
		getAudioContextConstructor: () => null,
	});
	assert.equal(unsupported.supported, false);
	assert.equal(await unsupported.unlock(), false);
	assert.equal(await unsupported.play(SOUND_CUE_NAMES.TICK), false);

	const throwing = createSoundCues({
		getStorage: () => null,
		getAudioContextConstructor: () => { throw new Error("blocked"); },
	});
	assert.equal(throwing.supported, false);
	assert.equal(await throwing.play(SOUND_CUE_NAMES.START), false);

	const harness = audioHarness({ failAt: "constructor" });
	const failed = makeCues({ harness }).cues;
	assert.equal(failed.supported, true);
	assert.equal(await failed.unlock(), false);
});

test("unknown cues throw synchronously without constructing audio", () => {
	const { cues, harness } = makeCues();
	assert.throws(() => cues.play("victory"), /Unknown sound cue/u);
	assert.throws(() => cues.play(null), /Unknown sound cue/u);
	assert.equal(harness.instances.length, 0);
});

test("unlock constructs and calls resume synchronously before awaiting it", async () => {
	const pending = deferred();
	const harness = audioHarness({
		initialState: "suspended",
		resume(context, events) {
			events.push("resume-returning");
			return pending.promise.then(() => { context.state = "running"; });
		},
	});
	const { cues } = makeCues({ harness });
	const unlocked = cues.unlock();
	assert.deepEqual(harness.events, ["constructed", "resume-called", "resume-returning"]);
	pending.resolve();
	assert.equal(await unlocked, true);
	assert.equal(harness.instances.length, 1);
});

test("running contexts are reused without redundant resume calls", async () => {
	const { cues, harness } = makeCues();
	assert.equal(await cues.unlock(), true);
	assert.equal(await cues.unlock(), true);
	assert.equal(await cues.play(SOUND_CUE_NAMES.TICK), true);
	assert.equal(harness.instances.length, 1);
	assert.equal(harness.events.includes("resume-called"), false);
});

test("suspended and interrupted contexts resume, while failures resolve false", async () => {
	for (const state of ["suspended", "interrupted"]) {
		const harness = audioHarness({ initialState: state });
		const cues = makeCues({ harness }).cues;
		assert.equal(await cues.play(SOUND_CUE_NAMES.TICK), true);
		assert(harness.events.includes("resume-called"));
	}

	const throwingHarness = audioHarness({ initialState: "suspended", failAt: "resume-throw" });
	assert.equal(await makeCues({ harness: throwingHarness }).cues.play(SOUND_CUE_NAMES.TICK), false);
	const rejectingHarness = audioHarness({
		initialState: "suspended",
		resume: () => Promise.reject(new Error("autoplay denied")),
	});
	assert.equal(await makeCues({ harness: rejectingHarness }).cues.play(SOUND_CUE_NAMES.TICK), false);
});

const reviewedRecipes = {
	[SOUND_CUE_NAMES.START]: [
		{ frequency: 660, delay: 0, duration: 0.12, type: "sine", gain: 0.08 },
		{ frequency: 880, delay: 0.14, duration: 0.16, type: "sine", gain: 0.08 },
	],
	[SOUND_CUE_NAMES.TICK]: [
		{ frequency: 880, delay: 0, duration: 0.06, type: "sine", gain: 0.05 },
	],
	[SOUND_CUE_NAMES.SILENCE_WARNING]: [
		{ frequency: 440, delay: 0, duration: 0.16, type: "triangle", gain: 0.1 },
	],
	[SOUND_CUE_NAMES.ELIMINATED]: [
		{ frequency: 220, delay: 0, duration: 0.22, type: "sawtooth", gain: 0.06 },
		{ frequency: 160, delay: 0.2, duration: 0.32, type: "sawtooth", gain: 0.06 },
	],
	[SOUND_CUE_NAMES.COMPLETED]: [
		{ frequency: 523, delay: 0, duration: 0.12, type: "sine", gain: 0.08 },
		{ frequency: 659, delay: 0.13, duration: 0.12, type: "sine", gain: 0.08 },
		{ frequency: 784, delay: 0.26, duration: 0.2, type: "sine", gain: 0.08 },
	],
};

test("schedules every reviewed Go cue recipe with one bounded gain envelope", async () => {
	for (const [name, recipe] of Object.entries(reviewedRecipes)) {
		const harness = audioHarness({ currentTime: 7 });
		const cues = makeCues({ harness }).cues;
		assert.equal(await cues.play(name), true, name);
		const context = harness.instances[0];
		assert.equal(context.oscillators.length, recipe.length, name);
		assert.equal(context.amplifiers.length, recipe.length, name);

		for (const [index, expected] of recipe.entries()) {
			const oscillator = context.oscillators[index];
			const amplifier = context.amplifiers[index];
			const at = 7 + expected.delay;
			assert.equal(oscillator.type, expected.type);
			assert.equal(oscillator.frequency.value, expected.frequency);
			assert.deepEqual(oscillator.starts, [at]);
			assert.deepEqual(oscillator.stops, [at + expected.duration + 0.05]);
			assert.deepEqual(amplifier.events, [
				["set", 0.0001, at],
				["ramp", expected.gain, at + 0.01],
				["ramp", 0.0001, at + expected.duration],
			]);
			assert.deepEqual(oscillator.connections, [amplifier]);
			assert.deepEqual(amplifier.connections, [context.destination]);
		}
	}
});

test("ended tones disconnect themselves without closing the reusable context", async () => {
	const { cues, harness } = makeCues();
	assert.equal(await cues.play(SOUND_CUE_NAMES.TICK), true);
	const context = harness.instances[0];
	context.oscillators[0].end();
	assert.equal(context.oscillators[0].disconnectCalls, 1);
	assert.equal(context.amplifiers[0].disconnectCalls, 1);
	assert.equal(context.closeCalls, 0);
	cues.release();
	assert.equal(context.oscillators[0].disconnectCalls, 1, "ended nodes must not be released twice");
});

test("release stops live nodes, disconnects the graph, and closes once", async () => {
	const { cues, harness } = makeCues();
	assert.equal(await cues.play(SOUND_CUE_NAMES.START), true);
	const context = harness.instances[0];
	cues.release();
	for (const oscillator of context.oscillators) {
		assert.equal(oscillator.stops.at(-1), undefined, "release must request an immediate stop");
		assert.equal(oscillator.disconnectCalls, 1);
	}
	for (const amplifier of context.amplifiers) assert.equal(amplifier.disconnectCalls, 1);
	assert.equal(context.closeCalls, 1);
	cues.release();
	assert.equal(context.closeCalls, 1);
});

test("disabling and storage reload release audio immediately", async () => {
	const storage = new MemoryStorage();
	const { cues, harness } = makeCues({ storage });
	assert.equal(await cues.play(SOUND_CUE_NAMES.TICK), true);
	const first = harness.instances[0];
	cues.setEnabled(false);
	assert.equal(first.closeCalls, 1);
	assert.equal(await cues.play(SOUND_CUE_NAMES.TICK), false);
	assert.equal(harness.instances.length, 1, "disabled playback must stay lazy");

	cues.setEnabled(true);
	assert.equal(await cues.unlock(), true);
	const second = harness.instances[1];
	storage.values.set(SOUND_CUE_STORAGE_KEY, "off");
	assert.equal(cues.reload(), false);
	assert.equal(second.closeCalls, 1);
});

test("release invalidates delayed resume so a stale cue cannot be scheduled", async () => {
	const pending = deferred();
	const harness = audioHarness({
		initialState: "suspended",
		resume(context) {
			return pending.promise.then(() => { context.state = "running"; });
		},
	});
	const { cues } = makeCues({ harness });
	const playing = cues.play(SOUND_CUE_NAMES.COMPLETED);
	assert.equal(harness.instances.length, 1);
	cues.release();
	pending.resolve();
	assert.equal(await playing, false);
	assert.equal(harness.instances[0].oscillators.length, 0);
});

test("a context observed closed is replaced on the next playback", async () => {
	const { cues, harness } = makeCues();
	assert.equal(await cues.play(SOUND_CUE_NAMES.TICK), true);
	harness.instances[0].state = "closed";
	assert.equal(await cues.play(SOUND_CUE_NAMES.TICK), true);
	assert.equal(harness.instances.length, 2);
	assert.equal(harness.instances[0].closeCalls, 1);
});

for (const failure of [
	"oscillator",
	"gain",
	"gain-envelope",
	"oscillator-connect",
	"gain-connect",
	"start",
	"stop",
]) {
	test(`a ${failure} failure is contained and cleans partial nodes`, async () => {
		const harness = audioHarness({ failAt: failure });
		const cues = makeCues({ harness }).cues;
		assert.equal(await cues.play(SOUND_CUE_NAMES.START), false);
		const context = harness.instances[0];
		for (const oscillator of context.oscillators) assert(oscillator.disconnectCalls >= 1);
		for (const amplifier of context.amplifiers) assert(amplifier.disconnectCalls >= 1);
	});
}

test("close exceptions and rejected close promises are swallowed", async () => {
	const throwingHarness = audioHarness({ failAt: "close-throw" });
	const throwing = makeCues({ harness: throwingHarness }).cues;
	await throwing.unlock();
	assert.doesNotThrow(() => throwing.release());

	const rejectingHarness = audioHarness({
		close: (context) => {
			context.state = "closed";
			return Promise.reject(new Error("close rejected"));
		},
	});
	const rejecting = makeCues({ harness: rejectingHarness }).cues;
	await rejecting.unlock();
	assert.doesNotThrow(() => rejecting.release());
	await Promise.resolve();
});

test("a finalization intent ignores unrelated state, waits through pending, and resolves exactly once", () => {
	const tracker = createDeferredFinalCueTracker();
	assert.deepEqual(tracker.arm({ roomCode: "ABC234", routeGeneration: 7, turnId: "t9" }), {
		roomCode: "ABC234",
		routeGeneration: 7,
		turnId: "t9",
	});
	assert.equal(tracker.pendingTurnId, "t9");
	assert.equal(tracker.consume({
		roomCode: "ABC234",
		routeGeneration: 7,
		phase: "playing",
		completedTurns: [{ id: "t8", completed: true }],
	}), "", "an unrelated accepted snapshot must not erase an in-flight exact-turn intent");
	assert.equal(tracker.pendingTurnId, "t9");
	const pendingState = {
		roomCode: "ABC234",
		routeGeneration: 7,
		phase: "finished",
		completedTurns: [{ id: "t9", completed: true, eliminated: false, judge: { status: "pending" } }],
	};
	assert.equal(tracker.consume(pendingState), "");
	assert.equal(tracker.consume(pendingState), "", "repeated WebSocket pending snapshots must stay inert");
	assert.equal(tracker.pendingTurnId, "t9");

	const resolvedState = structuredClone(pendingState);
	resolvedState.completedTurns[0].judge.status = "done";
	assert.equal(tracker.consume(resolvedState), SOUND_CUE_NAMES.COMPLETED);
	assert.equal(tracker.pendingTurnId, "");
	assert.equal(tracker.consume(resolvedState), "", "the same terminal snapshot must not replay the cue");
});

test("the final turn cue waits for an earlier independent pending review", () => {
	const tracker = createDeferredFinalCueTracker();
	tracker.arm({ roomCode: "ABC234", routeGeneration: 8, turnId: "t2" });
	const provisional = {
		roomCode: "ABC234",
		routeGeneration: 8,
		phase: "finished",
		completedTurns: [
			{ id: "t1", completed: true, eliminated: false, judge: { status: "pending" } },
			{ id: "t2", completed: true, eliminated: false, judge: { status: "skipped" } },
		],
	};
	assert.equal(tracker.consume(provisional), "");
	assert.equal(tracker.pendingTurnId, "t2");

	const final = structuredClone(provisional);
	final.completedTurns[0].judge.status = "failed";
	assert.equal(tracker.consume(final), SOUND_CUE_NAMES.COMPLETED);
	assert.equal(tracker.pendingTurnId, "");
	assert.equal(tracker.consume(final), "", "the finalized standings snapshot must stay exact-once");
});

test("a non-final local result cues immediately even when its review is pending", () => {
	const tracker = createDeferredFinalCueTracker();
	tracker.arm({ roomCode: "ABC234", routeGeneration: 9, turnId: "t1" });
	const state = {
		roomCode: "ABC234",
		routeGeneration: 9,
		phase: "playing",
		completedTurns: [
			{ id: "t1", completed: false, eliminated: true, judge: { status: "pending" } },
		],
	};
	assert.equal(tracker.consume(state), SOUND_CUE_NAMES.ELIMINATED);
	assert.equal(tracker.pendingTurnId, "");
	assert.equal(tracker.consume(state), "", "an immediate state-driven cue must not replay");
});

test("a later alarm failure consumes the matching deferred elimination cue", () => {
	const tracker = createDeferredFinalCueTracker();
	tracker.arm({ roomCode: "XYZ789", routeGeneration: 12, turnId: "t42" });
	assert.equal(tracker.consume({
		roomCode: "XYZ789",
		routeGeneration: 12,
		phase: "finished",
		completedTurns: [{ id: "t42", completed: false, eliminated: true, judge: { status: "pending" } }],
	}), "");
	assert.equal(tracker.consume({
		roomCode: "XYZ789",
		routeGeneration: 12,
		phase: "finished",
		completedTurns: [{ id: "t42", completed: false, eliminated: true, judge: { status: "failed" } }],
	}), SOUND_CUE_NAMES.ELIMINATED);
	assert.equal(tracker.pendingTurnId, "");
});

test("deferred final cues clear on route replacement, reset, malformed terminal state, and teardown", () => {
	const tracker = createDeferredFinalCueTracker();
	tracker.arm({ roomCode: "ABC234", routeGeneration: 2, turnId: "t1" });
	assert.equal(tracker.consume({
		roomCode: "DEF567",
		routeGeneration: 3,
		phase: "finished",
		completedTurns: [{ id: "t1", completed: true, judge: { status: "done" } }],
	}), "");
	assert.equal(tracker.pendingTurnId, "");

	tracker.arm({ roomCode: "DEF567", routeGeneration: 3, turnId: "t2" });
	assert.equal(tracker.consume({
		roomCode: "DEF567",
		routeGeneration: 3,
		phase: "setup",
		completedTurns: [],
	}), "");
	assert.equal(tracker.pendingTurnId, "");

	tracker.arm({ roomCode: "DEF567", routeGeneration: 3, turnId: "t3" });
	assert.equal(tracker.consume({
		roomCode: "DEF567",
		routeGeneration: 3,
		phase: "finished",
		completedTurns: [{ id: "t3", completed: true, judge: { status: "unexpected" } }],
	}), "");
	assert.equal(tracker.pendingTurnId, "");

	tracker.arm({ roomCode: "DEF567", routeGeneration: 3, turnId: "t4" });
	assert.equal(tracker.consume({
		roomCode: "DEF567",
		routeGeneration: 3,
		phase: "finished",
		completedTurns: [{ id: "unrelated", completed: true, judge: { status: "done" } }],
	}), "");
	assert.equal(tracker.pendingTurnId, "",
		"a definitive finished room cannot retain a missing speculative turn");

	tracker.arm({ roomCode: "DEF567", routeGeneration: 3, turnId: "t5" });
	assert.equal(tracker.consume({
		roomCode: "DEF567",
		routeGeneration: 3,
		phase: "playing",
		completedTurns: [{ id: "t5", completed: false, eliminated: false, judge: { status: "skipped" } }],
	}), "");
	assert.equal(tracker.pendingTurnId, "",
		"an accepted exact turn without a terminal result must clear speculative intent");

	tracker.arm({ roomCode: "DEF567", routeGeneration: 3, turnId: "t6" });
	assert.equal(tracker.clear(), true);
	assert.equal(tracker.clear(), false);
});

test("deferred final cue identity is strict and re-arming replaces stale work", () => {
	const tracker = createDeferredFinalCueTracker();
	assert.throws(() => tracker.arm(), /room code, route generation, and turn ID/u);
	assert.throws(
		() => tracker.arm({ roomCode: "ABC234", routeGeneration: 1.5, turnId: "t1" }),
		TypeError,
	);
	tracker.arm({ roomCode: "ABC234", routeGeneration: 4, turnId: "t1" });
	tracker.arm({ roomCode: "ABC234", routeGeneration: 4, turnId: "t2" });
	assert.equal(tracker.pendingTurnId, "t2");
	assert(Object.isFrozen(tracker));
});
