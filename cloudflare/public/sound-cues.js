export const SOUND_CUE_STORAGE_KEY = "nonstoptalk.sound";
export const SOUND_CUE_LEGACY_STORAGE_KEY = "dont-stop-talking.sound";

export const SOUND_CUE_NAMES = Object.freeze({
	START: "start",
	TICK: "tick",
	SILENCE_WARNING: "silence-warning",
	ELIMINATED: "eliminated",
	COMPLETED: "completed",
});

const SOUND_CUE_STORAGE_KEYS = Object.freeze([
	SOUND_CUE_STORAGE_KEY,
	SOUND_CUE_LEGACY_STORAGE_KEY,
]);

const SOUND_CUE_RECIPES = Object.freeze({
	[SOUND_CUE_NAMES.START]: tones(
		tone(660, 0, 0.12),
		tone(880, 0.14, 0.16),
	),
	[SOUND_CUE_NAMES.TICK]: tones(
		tone(880, 0, 0.06, "sine", 0.05),
	),
	[SOUND_CUE_NAMES.SILENCE_WARNING]: tones(
		tone(440, 0, 0.16, "triangle", 0.1),
	),
	[SOUND_CUE_NAMES.ELIMINATED]: tones(
		tone(220, 0, 0.22, "sawtooth", 0.06),
		tone(160, 0.2, 0.32, "sawtooth", 0.06),
	),
	[SOUND_CUE_NAMES.COMPLETED]: tones(
		tone(523, 0, 0.12),
		tone(659, 0.13, 0.12),
		tone(784, 0.26, 0.2),
	),
});

function tone(frequency, delay, duration, type = "sine", gain = 0.08) {
	return Object.freeze({ frequency, delay, duration, type, gain });
}

function tones(...values) {
	return Object.freeze(values);
}

function defaultStorage() {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function defaultAudioContextConstructor() {
	try {
		return globalThis.AudioContext || globalThis.webkitAudioContext || null;
	} catch {
		return null;
	}
}

/**
 * Create a browser-local, dependency-injected sound-cue player.
 *
 * Cues are synthesized with Web Audio oscillators. No sound file, room data,
 * microphone data, or network request crosses this boundary.
 */
export function createSoundCues({
	getStorage = defaultStorage,
	getAudioContextConstructor = defaultAudioContextConstructor,
} = {}) {
	if (typeof getStorage !== "function") throw new TypeError("getStorage must be a function.");
	if (typeof getAudioContextConstructor !== "function") {
		throw new TypeError("getAudioContextConstructor must be a function.");
	}

	let enabled = true;
	let context = null;
	let generation = 0;
	const liveTones = new Set();

	function storage() {
		let target;
		try {
			target = getStorage() ?? null;
			if (!target
				|| typeof target.getItem !== "function"
				|| typeof target.setItem !== "function"
				|| typeof target.removeItem !== "function") return null;
		} catch {
			return null;
		}
		return target;
	}

	function persistPreference(target, nextEnabled) {
		if (!target) return false;
		try {
			if (nextEnabled) target.removeItem(SOUND_CUE_STORAGE_KEY);
			else target.setItem(SOUND_CUE_STORAGE_KEY, "off");
			target.removeItem(SOUND_CUE_LEGACY_STORAGE_KEY);
			return true;
		} catch {
			return false;
		}
	}

	function applyEnabled(nextEnabled) {
		enabled = nextEnabled;
		if (!enabled) release();
		return enabled;
	}

	function reload() {
		const target = storage();
		if (!target) return enabled;

		let current;
		try {
			current = target.getItem(SOUND_CUE_STORAGE_KEY);
		} catch {
			return enabled;
		}

		if (current !== null) {
			const nextEnabled = current !== "off";
			// An enabled preference is represented by absence. This also repairs
			// obsolete values such as "on" without making storage mandatory.
			if (nextEnabled) persistPreference(target, true);
			else {
				try { target.removeItem(SOUND_CUE_LEGACY_STORAGE_KEY); } catch { /* Best-effort migration cleanup. */ }
			}
			return applyEnabled(nextEnabled);
		}

		let legacy;
		try {
			legacy = target.getItem(SOUND_CUE_LEGACY_STORAGE_KEY);
		} catch {
			return enabled;
		}
		if (legacy === null) return applyEnabled(true);

		const nextEnabled = legacy !== "off";
		persistPreference(target, nextEnabled);
		return applyEnabled(nextEnabled);
	}

	function setEnabled(nextEnabled) {
		if (typeof nextEnabled !== "boolean") throw new TypeError("enabled must be a boolean.");
		applyEnabled(nextEnabled);
		return Object.freeze({
			enabled,
			persisted: persistPreference(storage(), enabled),
		});
	}

	function toggle() {
		return setEnabled(!enabled);
	}

	function resolveAudioContextConstructor() {
		try {
			const Constructor = getAudioContextConstructor();
			return typeof Constructor === "function" ? Constructor : null;
		} catch {
			return null;
		}
	}

	function contextState(candidate) {
		try {
			return typeof candidate?.state === "string" ? candidate.state : "";
		} catch {
			return "";
		}
	}

	function ensureContext() {
		if (!enabled) return null;
		if (context) {
			const state = contextState(context);
			if (state && state !== "closed") return context;
			release();
		}

		const Constructor = resolveAudioContextConstructor();
		if (!Constructor) return null;
		try {
			const candidate = new Constructor();
			if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) return null;
			context = candidate;
			return context;
		} catch {
			return null;
		}
	}

	async function resumeContext(candidate, expectedGeneration) {
		if (!enabled || context !== candidate || generation !== expectedGeneration) return false;
		const initialState = contextState(candidate);
		if (initialState === "running") return true;
		if (initialState === "closed" || typeof candidate?.resume !== "function") return false;

		let resumed;
		try {
			// Deliberately call resume before the first await so callers can invoke
			// unlock/play directly inside a trusted click or key activation.
			resumed = candidate.resume();
		} catch {
			return false;
		}
		try {
			await resumed;
		} catch {
			return false;
		}
		return enabled
			&& context === candidate
			&& generation === expectedGeneration
			&& contextState(candidate) === "running";
	}

	function unlock() {
		if (!enabled) return Promise.resolve(false);
		const candidate = ensureContext();
		if (!candidate) return Promise.resolve(false);
		return resumeContext(candidate, generation).catch(() => false);
	}

	function disposeTone(record, stop) {
		if (!record) return;
		liveTones.delete(record);
		try { record.oscillator.onended = null; } catch { /* Best-effort cleanup. */ }
		if (stop) {
			try { record.oscillator?.stop?.(); } catch { /* It may already be stopped. */ }
		}
		try { record.oscillator?.disconnect?.(); } catch { /* Best-effort cleanup. */ }
		try { record.amplifier?.disconnect?.(); } catch { /* Best-effort cleanup. */ }
	}

	function scheduleRecipe(candidate, recipe) {
		const records = [];
		try {
			const baseTime = candidate.currentTime;
			const destination = candidate.destination;
			if (!Number.isFinite(baseTime) || !destination) return false;

			for (const recipeTone of recipe) {
				const record = { oscillator: null, amplifier: null };
				records.push(record);
				record.oscillator = candidate.createOscillator();
				record.amplifier = candidate.createGain();
				const at = baseTime + recipeTone.delay;
				const endsAt = at + recipeTone.duration;

				record.oscillator.type = recipeTone.type;
				record.oscillator.frequency.value = recipeTone.frequency;
				record.amplifier.gain.setValueAtTime(0.0001, at);
				record.amplifier.gain.exponentialRampToValueAtTime(recipeTone.gain, at + 0.01);
				record.amplifier.gain.exponentialRampToValueAtTime(0.0001, endsAt);
				record.oscillator.connect(record.amplifier);
				record.amplifier.connect(destination);
				record.oscillator.onended = () => disposeTone(record, false);
				liveTones.add(record);
			}

			for (const [index, record] of records.entries()) {
				const recipeTone = recipe[index];
				const at = baseTime + recipeTone.delay;
				record.oscillator.start(at);
				record.oscillator.stop(at + recipeTone.duration + 0.05);
			}
			return true;
		} catch {
			for (const record of records) disposeTone(record, true);
			return false;
		}
	}

	async function playRecipe(candidate, expectedGeneration, recipe) {
		if (!await resumeContext(candidate, expectedGeneration)) return false;
		if (!enabled || context !== candidate || generation !== expectedGeneration) return false;
		return scheduleRecipe(candidate, recipe);
	}

	function play(name) {
		if (typeof name !== "string" || !Object.hasOwn(SOUND_CUE_RECIPES, name)) {
			throw new TypeError("Unknown sound cue.");
		}
		if (!enabled) return Promise.resolve(false);
		const candidate = ensureContext();
		if (!candidate) return Promise.resolve(false);
		return playRecipe(candidate, generation, SOUND_CUE_RECIPES[name]).catch(() => false);
	}

	function release() {
		generation += 1;
		const releasedContext = context;
		context = null;
		for (const record of [...liveTones]) disposeTone(record, true);
		liveTones.clear();
		if (!releasedContext) return;
		try {
			const closing = releasedContext.close?.();
			if (closing && typeof closing.catch === "function") closing.catch(() => {});
		} catch {
			// Releasing audio resources must never block the game.
		}
	}

	reload();

	return Object.freeze({
		get enabled() { return enabled; },
		get supported() { return Boolean(resolveAudioContextConstructor()); },
		get storageKey() { return SOUND_CUE_STORAGE_KEY; },
		get storageKeys() { return SOUND_CUE_STORAGE_KEYS; },
		reload,
		setEnabled,
		toggle,
		unlock,
		play,
		release,
	});
}
