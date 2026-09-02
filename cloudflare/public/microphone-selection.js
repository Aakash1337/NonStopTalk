export const MICROPHONE_STORAGE_KEY = "nonstoptalk.microphone.v1";
export const AUTO_MICROPHONE_ID = "";
export const MICROPHONE_MAX_DEVICE_ID_CODE_POINTS = 1024;
export const MICROPHONE_MAX_DEVICE_ID_BYTES = 2048;
export const MICROPHONE_MAX_LABEL_CODE_POINTS = 120;
export const MICROPHONE_MAX_DEVICE_COUNT = 64;

const DEVICE_ID_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const MICROPHONE_MAX_DEVICE_SCAN_COUNT = MICROPHONE_MAX_DEVICE_COUNT * 4;
const utf8 = new TextEncoder();

function sliceCodePoints(value, maximum) {
	let result = "";
	let count = 0;
	for (const character of value) {
		if (count >= maximum) break;
		result += character;
		count += 1;
	}
	return result;
}

function hasAtMostCodePoints(value, maximum) {
	let count = 0;
	for (const _character of value) {
		count += 1;
		if (count > maximum) return false;
	}
	return true;
}

function defaultStorage() {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function defaultMediaDevices() {
	try {
		return globalThis.navigator?.mediaDevices ?? null;
	} catch {
		return null;
	}
}

function unavailableError() {
	const error = new Error("Microphone input is unavailable.");
	error.name = "NotSupportedError";
	return error;
}

function cancelledError() {
	const error = new Error("The microphone request is no longer current.");
	error.name = "AbortError";
	return error;
}

function stopStream(stream) {
	try {
		stream?.getTracks?.().forEach((track) => track.stop());
	} catch {
		// A stale permission result must never be retained.
	}
}

/** Validate an opaque browser device ID without normalizing its exact value. */
export function normalizeMicrophoneDeviceId(value, { allowAuto = true } = {}) {
	if (allowAuto && value === AUTO_MICROPHONE_ID) return AUTO_MICROPHONE_ID;
	if (
		typeof value !== "string"
		|| value.length === 0
		|| value.length > MICROPHONE_MAX_DEVICE_ID_BYTES
		|| utf8.encode(value).byteLength > MICROPHONE_MAX_DEVICE_ID_BYTES
		|| !hasAtMostCodePoints(value, MICROPHONE_MAX_DEVICE_ID_CODE_POINTS)
		|| DEVICE_ID_CONTROL_CHARACTERS.test(value)
	) {
		throw new TypeError("The microphone device ID is invalid.");
	}
	return value;
}

/** Keep only bounded audio inputs and detached display fields. */
export function normalizeMicrophoneDevices(devices) {
	if (!devices || typeof devices[Symbol.iterator] !== "function") return [];
	const normalized = [];
	const seen = new Set();
	let inspected = 0;
	for (const candidate of devices) {
		inspected += 1;
		if (inspected > MICROPHONE_MAX_DEVICE_SCAN_COUNT) break;
		if (normalized.length >= MICROPHONE_MAX_DEVICE_COUNT) break;
		let kind;
		let deviceId;
		let label;
		try {
			kind = candidate?.kind;
			deviceId = normalizeMicrophoneDeviceId(candidate?.deviceId, { allowAuto: false });
			label = typeof candidate?.label === "string"
				? sliceCodePoints(
					sliceCodePoints(candidate.label, MICROPHONE_MAX_LABEL_CODE_POINTS + 1).trim(),
					MICROPHONE_MAX_LABEL_CODE_POINTS,
				)
				: "";
		} catch {
			continue;
		}
		if (kind !== "audioinput" || seen.has(deviceId)) continue;
		seen.add(deviceId);
		normalized.push(Object.freeze({ deviceId, label }));
	}
	return normalized;
}

export function microphoneDeviceLabel(devices, selectedId) {
	const normalizedId = normalizeMicrophoneDeviceId(selectedId);
	if (normalizedId === AUTO_MICROPHONE_ID) return "Auto-detect";
	const list = Array.isArray(devices) ? devices : [];
	const index = list.findIndex((device) => device?.deviceId === normalizedId);
	if (index < 0) return "Saved microphone";
	const device = list[index];
	if (device.label) return device.label;
	if (device.deviceId === "default") return "System default";
	if (device.deviceId === "communications") return "Communications microphone";
	return `Microphone ${index + 1}`;
}

export function audioConstraintsForMicrophone(selectedId, baseAudioConstraints = true) {
	const normalizedId = normalizeMicrophoneDeviceId(selectedId);
	if (baseAudioConstraints !== true && (
		!baseAudioConstraints
		|| typeof baseAudioConstraints !== "object"
		|| Array.isArray(baseAudioConstraints)
	)) {
		throw new TypeError("Base microphone constraints must be true or an object.");
	}
	if (normalizedId === AUTO_MICROPHONE_ID) {
		return baseAudioConstraints === true ? true : { ...baseAudioConstraints };
	}
	return {
		...(baseAudioConstraints === true ? {} : baseAudioConstraints),
		deviceId: { exact: normalizedId },
	};
}

export function isSelectedMicrophoneUnavailableError(error) {
	const name = error && typeof error === "object" ? error.name : "";
	if (name === "NotFoundError" || name === "DevicesNotFoundError") return true;
	if (name !== "OverconstrainedError" && name !== "ConstraintNotSatisfiedError") return false;
	return !error.constraint || error.constraint === "deviceId";
}

/**
 * Create one dependency-injected, browser-local microphone preference.
 * Labels remain memory-only; persistence contains only the bounded device ID.
 */
export function createMicrophoneSelection({
	getStorage = defaultStorage,
	getMediaDevices = defaultMediaDevices,
} = {}) {
	if (typeof getStorage !== "function") throw new TypeError("getStorage must be a function.");
	if (typeof getMediaDevices !== "function") throw new TypeError("getMediaDevices must be a function.");

	let selectedId = AUTO_MICROPHONE_ID;
	let devices = [];
	let enumerationGeneration = 0;

	function storage() {
		try {
			return getStorage() ?? null;
		} catch {
			return null;
		}
	}

	function persist(value) {
		const target = storage();
		if (!target) return false;
		try {
			if (value === AUTO_MICROPHONE_ID) target.removeItem(MICROPHONE_STORAGE_KEY);
			else target.setItem(MICROPHONE_STORAGE_KEY, value);
			return true;
		} catch {
			return false;
		}
	}

	function reload() {
		const target = storage();
		if (!target) {
			selectedId = AUTO_MICROPHONE_ID;
			return selectedId;
		}
		let stored;
		try {
			stored = target.getItem(MICROPHONE_STORAGE_KEY);
		} catch {
			selectedId = AUTO_MICROPHONE_ID;
			return selectedId;
		}
		if (stored === null || stored === AUTO_MICROPHONE_ID) {
			selectedId = AUTO_MICROPHONE_ID;
			return selectedId;
		}
		try {
			selectedId = normalizeMicrophoneDeviceId(stored, { allowAuto: false });
		} catch {
			selectedId = AUTO_MICROPHONE_ID;
			try { target.removeItem(MICROPHONE_STORAGE_KEY); } catch { /* Best-effort repair. */ }
		}
		return selectedId;
	}

	function select(value) {
		selectedId = normalizeMicrophoneDeviceId(value);
		return Object.freeze({ selectedId, persisted: persist(selectedId) });
	}

	function clearUnavailablePreference(requestedId) {
		let clearMemory = selectedId === requestedId;
		const target = storage();
		if (target) {
			try {
				const stored = target.getItem(MICROPHONE_STORAGE_KEY);
				if (stored === requestedId) {
					target.removeItem(MICROPHONE_STORAGE_KEY);
				} else if (clearMemory && stored !== null && stored !== AUTO_MICROPHONE_ID) {
					try {
						selectedId = normalizeMicrophoneDeviceId(stored, { allowAuto: false });
						clearMemory = false;
					} catch {
						// A later reload will repair unrelated corrupt storage bytes.
					}
				}
			} catch {
				// The in-memory preference still falls back safely when storage is blocked.
			}
		}
		if (clearMemory) selectedId = AUTO_MICROPHONE_ID;
	}

	async function enumerate({ requestPermission = false, isCurrent = () => true } = {}) {
		if (typeof isCurrent !== "function") throw new TypeError("isCurrent must be a function.");
		const remainsCurrent = () => {
			try { return isCurrent() === true; } catch { return false; }
		};
		if (!remainsCurrent()) throw cancelledError();
		const generation = ++enumerationGeneration;
		const mediaDevices = getMediaDevices();
		if (!mediaDevices || typeof mediaDevices.enumerateDevices !== "function") {
			if (generation === enumerationGeneration) devices = [];
			return [];
		}
		if (requestPermission && typeof mediaDevices.getUserMedia !== "function") throw unavailableError();
		let permissionStream;
		if (requestPermission) {
			try {
				permissionStream = await mediaDevices.getUserMedia({ audio: true, video: false });
				if (!remainsCurrent()) throw cancelledError();
			} finally {
				stopStream(permissionStream);
			}
		}
		if (!remainsCurrent()) throw cancelledError();
		const nextDevices = normalizeMicrophoneDevices(await mediaDevices.enumerateDevices());
		if (!remainsCurrent()) throw cancelledError();
		if (generation === enumerationGeneration) devices = nextDevices;
		return (generation === enumerationGeneration ? nextDevices : devices)
			.map((device) => ({ ...device }));
	}

	async function acquire(baseAudioConstraints = true, { isCurrent = () => true } = {}) {
		if (typeof isCurrent !== "function") throw new TypeError("isCurrent must be a function.");
		const remainsCurrent = () => {
			try { return isCurrent() === true; } catch { return false; }
		};
		if (!remainsCurrent()) throw cancelledError();
		const mediaDevices = getMediaDevices();
		if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") throw unavailableError();
		const requestedId = selectedId;
		try {
			const stream = await mediaDevices.getUserMedia({
				audio: audioConstraintsForMicrophone(requestedId, baseAudioConstraints),
				video: false,
			});
			if (!remainsCurrent()) {
				stopStream(stream);
				throw cancelledError();
			}
			return Object.freeze({ stream, requestedId, activeId: requestedId, fellBack: false });
		} catch (error) {
			if (requestedId === AUTO_MICROPHONE_ID || !isSelectedMicrophoneUnavailableError(error)) throw error;
			if (!remainsCurrent()) throw cancelledError();
			let stream;
			try {
				stream = await mediaDevices.getUserMedia({
					audio: audioConstraintsForMicrophone(AUTO_MICROPHONE_ID, baseAudioConstraints),
					video: false,
				});
			} catch (fallbackError) {
				if (!remainsCurrent()) throw cancelledError();
				clearUnavailablePreference(requestedId);
				throw fallbackError;
			}
			if (!remainsCurrent()) {
				stopStream(stream);
				throw cancelledError();
			}
			clearUnavailablePreference(requestedId);
			return Object.freeze({
				stream,
				requestedId,
				activeId: AUTO_MICROPHONE_ID,
				fellBack: true,
			});
		}
	}

	reload();

	return Object.freeze({
		storageKey: MICROPHONE_STORAGE_KEY,
		get selectedId() { return selectedId; },
		get devices() { return devices.map((device) => ({ ...device })); },
		get selectedLabel() { return microphoneDeviceLabel(devices, selectedId); },
		reload,
		select,
		enumerate,
		acquire,
	});
}
