import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_CLOUD_SUMMARY_BYTES,
	PlatformError,
	analyticsEventFromRoomMilestone,
	decodeCoachingCursor,
	encodeCoachingCursor,
	hashDeviceToken,
	hashRoomCode,
	mapAnalyticsEvent,
	mapPublicRoomStateToFact,
	normalizeCoachingSummary,
	protectedSummaryQuery,
	withoutLocalArtifacts,
} from "./platform.ts";
import { topicGenerationCapability } from "./platform-routes.ts";

function coachingSummary(): Record<string, unknown> {
	return {
		analysisSchemaVersion: 2,
		id: "attempt-2026-08-30-1",
		createdAt: "2026-08-30T14:15:16.000Z",
		scenario: "interview",
		goal: "pauses",
		targetDurationMs: 45_000,
		metrics: {
			durationMs: 44_500,
			voicedMs: 31_000,
			speakingRatio: 0.6966,
			pauseCount: 4,
			observedDurationMs: 44_000,
			unknownMs: 500,
			coverageRatio: 0.9888,
			maxSampleGapMs: 500,
			medianPauseMs: 740,
			longestPauseMs: 1_300,
			longestSpeakingRunMs: 12_500,
			levelConsistencyPct: 82.5,
			clippingPct: 0.25,
			audioConfidence: "high",
			transcriptMetrics: {
				wordCount: 93,
				wordsPerMinute: 125.4,
				fillerCount: 2,
				repeatedWordCount: 1,
				fillerRatePer100Words: 2.15,
				repetitionRatePer100Words: 1.08,
				fillerOccurrences: [{ phrase: "you know", count: 2 }],
				repeatedWords: [{ word: "the", count: 1 }],
			},
		},
		advice: {
			strength: "Usable pause length",
			strengthEvidence: "Four measured pauses separated ideas.",
			focus: "Leave more room between phrases",
			focusEvidence: "The longest speaking run was 12.5 seconds.",
			drill: "Retry with one change.",
			drillDetail: "Take one breath between complete ideas.",
		},
		artifacts: {
			audioStored: true,
			audioBytes: 42_000,
			audioMimeType: "audio/webm",
			transcriptStored: true,
			transcriptMayBePartial: false,
		},
	};
}

function publicRoomState(): Record<string, unknown> {
	return {
		code: "ABC234",
		version: 9,
		phase: "finished",
		players: [
			{ id: "p1", name: "Alice Private", score: 85, online: true, token: "never-store" },
			{ id: "p2", name: "Bob Private", score: 40, online: false },
		],
		settings: { duration: 60, rounds: 1, topicPack: "everyday" },
		topics: ["A raw custom topic that must not become a fact"],
		completedTurns: [{ id: "t1" }, { id: "t2" }],
		lastTurn: { id: "t2", playerName: "Bob Private", topic: "Private topic", spokenSeconds: 40 },
		history: [{ finishedAt: 1, standings: [{ name: "Old Name" }] }],
		viewer: { playerId: "p1", isHost: true },
	};
}

function expectPlatformError(
	operation: () => unknown,
	code: InstanceType<typeof PlatformError>["code"],
): void {
	assert.throws(
		operation,
		(error: unknown) => error instanceof PlatformError && error.code === code,
	);
}

test("reports only non-secret topic-provider readiness", () => {
	assert.deepEqual(topicGenerationCapability({}), {
		status: "ready",
		routine: { status: "offline", provider: "offline", model: null, externalAvailable: false },
		escalated: { status: "offline", provider: "offline", model: null, externalAvailable: false },
	});
	const configured = topicGenerationCapability({
		TOPIC_ROUTINE_PROVIDER: "glm",
		ZAI_API_KEY: "secret-must-not-appear",
		TOPIC_ESCALATION_PROVIDER: "gemma31",
	});
	assert.equal(configured.status, "degraded");
	assert.deepEqual(configured.routine, {
		status: "ready",
		provider: "glm",
		model: "glm-4.7-flash",
		externalAvailable: true,
	});
	assert.deepEqual(configured.escalated, {
		status: "degraded",
		provider: "gemma31",
		model: "gemma-4-31b-it",
		externalAvailable: false,
	});
	assert.equal(JSON.stringify(configured).includes("secret-must-not-appear"), false);
	assert.deepEqual(
		topicGenerationCapability({
			TOPIC_ROUTINE_PROVIDER: "glm53",
			AI: { run: async () => ({}) },
		}).routine,
		{
			status: "ready",
			provider: "glm53",
			model: "glm-5.3-flash",
			externalAvailable: true,
		},
	);
	assert.deepEqual(topicGenerationCapability({ TOPIC_ROUTINE_PROVIDER: "glm53" }).routine, {
		status: "degraded",
		provider: "glm53",
		model: "glm-5.3-flash",
		externalAvailable: false,
	});
	assert.equal(topicGenerationCapability({ TOPIC_ROUTINE_PROVIDER: "private-typo" }).status, "degraded");
});

test("normalizes the exact buildCoachingSummary shape into a detached allowlist", () => {
	const input = coachingSummary();
	const normalized = normalizeCoachingSummary(input);
	assert.equal(normalized.analysisSchemaVersion, 2);
	assert.equal(normalized.metrics.transcriptMetrics?.fillerOccurrences[0]?.phrase, "you know");
	assert.equal(normalized.artifacts?.audioBytes, 42_000);
	assert.notEqual(normalized, input);
	assert.notEqual(normalized.metrics, input.metrics);
});

test("normalizes paired practice relationships while preserving legacy analysis-v2 summaries", () => {
	const legacy = normalizeCoachingSummary(coachingSummary());
	assert.equal("attemptRole" in legacy, false);

	const baselineInput = {
		...coachingSummary(),
		practiceLoopId: "loop-2026-09-01-1",
		baselineAttemptId: "attempt-2026-08-30-1",
		attemptRole: "baseline",
		feedbackMode: "review-only",
	};
	const baseline = normalizeCoachingSummary(baselineInput);
	assert.deepEqual({
		practiceLoopId: baseline.practiceLoopId,
		baselineAttemptId: baseline.baselineAttemptId,
		attemptRole: baseline.attemptRole,
		feedbackMode: baseline.feedbackMode,
	}, {
		practiceLoopId: "loop-2026-09-01-1",
		baselineAttemptId: "attempt-2026-08-30-1",
		attemptRole: "baseline",
		feedbackMode: "review-only",
	});

	const retry = normalizeCoachingSummary({
		...coachingSummary(),
		id: "attempt-2026-09-01-retry",
		practiceLoopId: "loop-2026-09-01-1",
		baselineAttemptId: "attempt-2026-08-30-1",
		attemptRole: "retry",
		feedbackMode: "review-only",
	});
	assert.equal(retry.attemptRole, "retry");

	const standalone = normalizeCoachingSummary({
		...coachingSummary(),
		practiceLoopId: null,
		baselineAttemptId: null,
		attemptRole: "standalone",
		feedbackMode: "live-cues",
	});
	assert.equal(standalone.attemptRole, "standalone");
});

test("rejects incomplete, assisted, or self-referential practice relationships", () => {
	const partial = { ...coachingSummary(), attemptRole: "baseline" };
	expectPlatformError(() => normalizeCoachingSummary(partial), "INVALID_INPUT");

	const assisted = {
		...coachingSummary(),
		practiceLoopId: "loop-1",
		baselineAttemptId: "attempt-2026-08-30-1",
		attemptRole: "baseline",
		feedbackMode: "live-cues",
	};
	expectPlatformError(() => normalizeCoachingSummary(assisted), "INVALID_INPUT");

	const selfRetry = {
		...coachingSummary(),
		practiceLoopId: "loop-1",
		baselineAttemptId: "attempt-2026-08-30-1",
		attemptRole: "retry",
		feedbackMode: "review-only",
	};
	expectPlatformError(() => normalizeCoachingSummary(selfRetry), "INVALID_INPUT");
});

test("rejects raw transcript and audio fields instead of silently dropping them", () => {
	for (const forbidden of [
		{ transcript: "captured words" },
		{ audioBlob: { bytes: [1, 2, 3] } },
		{ recording: "encoded media" },
	]) {
		const input = coachingSummary();
		Object.assign(input, forbidden);
		expectPlatformError(() => normalizeCoachingSummary(input), "FORBIDDEN_CLOUD_DATA");
	}

	const nested = coachingSummary();
	(nested.metrics as Record<string, unknown>).transcriptMetrics = {
		...((nested.metrics as Record<string, unknown>).transcriptMetrics as Record<string, unknown>),
		capturedTranscript: "secret",
	};
	expectPlatformError(() => normalizeCoachingSummary(nested), "FORBIDDEN_CLOUD_DATA");
});

test("rejects unknown fields at every allowlisted level", () => {
	const root = coachingSummary();
	root.ownerId = "caller-chosen-owner";
	expectPlatformError(() => normalizeCoachingSummary(root), "INVALID_INPUT");

	const nested = coachingSummary();
	(nested.advice as Record<string, unknown>).hiddenPrompt = "do not persist";
	expectPlatformError(() => normalizeCoachingSummary(nested), "INVALID_INPUT");
});

test("enforces schema versions, bounded metrics, and bounded derived patterns", () => {
	const wrongVersion = coachingSummary();
	wrongVersion.analysisSchemaVersion = 3;
	expectPlatformError(() => normalizeCoachingSummary(wrongVersion), "INVALID_INPUT");

	const badRatio = coachingSummary();
	(badRatio.metrics as Record<string, unknown>).speakingRatio = 1.01;
	expectPlatformError(() => normalizeCoachingSummary(badRatio), "INVALID_INPUT");

	const tooManyPatterns = coachingSummary();
	const transcript = (tooManyPatterns.metrics as Record<string, unknown>).transcriptMetrics as Record<string, unknown>;
	transcript.fillerOccurrences = Array.from({ length: 51 }, () => ({ phrase: "um", count: 1 }));
	expectPlatformError(() => normalizeCoachingSummary(tooManyPatterns), "INVALID_INPUT");
});

test("enforces the 64 KiB cloud payload boundary", () => {
	const input = coachingSummary();
	(input.advice as Record<string, unknown>).drillDetail = "x".repeat(MAX_CLOUD_SUMMARY_BYTES);
	expectPlatformError(() => normalizeCoachingSummary(input), "PAYLOAD_TOO_LARGE");
});

test("cloud export strips browser-local artifact metadata", () => {
	const normalized = normalizeCoachingSummary({
		...coachingSummary(),
		practiceLoopId: "loop-1",
		baselineAttemptId: "attempt-2026-08-30-1",
		attemptRole: "baseline",
		feedbackMode: "review-only",
	});
	const exported = withoutLocalArtifacts(normalized);
	assert.equal("artifacts" in exported, false);
	assert.equal(JSON.stringify(exported).includes("audio/webm"), false);
	assert.equal(exported.practiceLoopId, "loop-1");
	assert.equal(exported.attemptRole, "baseline");
});

test("hashes only a valid 64-hex browser token with SHA-256", async () => {
	const key = await hashDeviceToken("a".repeat(64));
	assert.equal(key, "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb");
	await assert.rejects(
		() => hashDeviceToken("A".repeat(64)),
		(error: unknown) => error instanceof PlatformError && error.code === "INVALID_IDENTITY",
	);
	await assert.rejects(() => hashDeviceToken("short"), PlatformError);
});

test("domain-separates and hashes room codes", async () => {
	const key = "room-fact-test-key-that-is-long-enough-1234567890";
	const digest = await hashRoomCode("abc234", key);
	assert.match(digest, /^[a-f0-9]{64}$/u);
	assert.equal(await hashRoomCode("ABC234", key), digest);
	assert.notEqual(await hashRoomCode("ABC235", key), digest);
	assert.notEqual(await hashRoomCode("ABC234", `${key}-different`), digest);
	await assert.rejects(() => hashRoomCode("ABC234", "too-short"), PlatformError);
});

test("protected summary query always binds owner, session, and active time", async () => {
	const deviceKey = await hashDeviceToken("b".repeat(64));
	const query = protectedSummaryQuery(deviceKey, "attempt-1", "2026-08-30T12:00:00.000Z");
	assert.match(query.sql, /device_key = \?/u);
	assert.match(query.sql, /session_id = \?/u);
	assert.match(query.sql, /expires_at > \?/u);
	assert.deepEqual(query.bindings, [deviceKey, "attempt-1", "2026-08-30T12:00:00.000Z"]);
	assert.equal(query.sql.includes("b".repeat(64)), false);
});

test("round-trips opaque coaching cursors and rejects tampering", () => {
	const value = { createdAt: "2026-08-30T12:00:00.000Z", id: "attempt-1" };
	assert.deepEqual(decodeCoachingCursor(encodeCoachingCursor(value)), value);
	expectPlatformError(() => decodeCoachingCursor("%%%"), "INVALID_CURSOR");
});

test("maps public room state to aggregate facts without names, topics, tokens, or viewer data", () => {
	const fact = mapPublicRoomStateToFact(
		publicRoomState(),
		"game-finished",
		"2026-08-30T12:00:00.000Z",
	);
	assert.deepEqual(
		{
			playerCount: fact.playerCount,
			onlinePlayerCount: fact.onlinePlayerCount,
			completedTurnCount: fact.completedTurnCount,
			finishedGameCount: fact.finishedGameCount,
			totalScore: fact.totalScore,
			lastTurnSpokenSeconds: fact.lastTurnSpokenSeconds,
		},
		{
			playerCount: 2,
			onlinePlayerCount: 1,
			completedTurnCount: 2,
			finishedGameCount: 2,
			totalScore: 125,
			lastTurnSpokenSeconds: 40,
		},
	);
	const serialized = JSON.stringify(fact);
	for (const privateValue of ["Alice Private", "Bob Private", "Private topic", "never-store", "Old Name"]) {
		assert.equal(serialized.includes(privateValue), false);
	}
});

test("maps only real room milestones to fixed analytics inputs", () => {
	const fact = mapPublicRoomStateToFact(publicRoomState(), "turn-completed", "2026-08-30T12:00:00.000Z");
	assert.deepEqual(analyticsEventFromRoomMilestone(fact), {
		type: "turn_completed",
		spokenSeconds: 40,
	});
	assert.equal(
		analyticsEventFromRoomMilestone({ ...fact, milestone: "snapshot" }),
		null,
	);
});

test("maps analytics to UTC daily aggregates with no freeform identity dimensions", () => {
	assert.deepEqual(
		mapAnalyticsEvent(
			{ type: "coaching_summary_saved", durationMs: 45_500 },
			"2026-08-30T23:59:59.000-04:00",
		),
		{
			day: "2026-08-31",
			metric: "coaching_summary_saved",
			eventCount: 1,
			valueSum: 45.5,
		},
	);
	assert.deepEqual(
		mapAnalyticsEvent(
			{ type: "coaching_summary_deleted", deletedCount: 3 },
			"2026-08-30T12:00:00.000Z",
		),
		{
			day: "2026-08-30",
			metric: "coaching_summary_deleted",
			eventCount: 1,
			valueSum: 3,
		},
	);
	expectPlatformError(
		() => mapAnalyticsEvent({ type: "room_created", ip: "203.0.113.1" }),
		"INVALID_INPUT",
	);
	expectPlatformError(
		() => mapAnalyticsEvent({ type: "room_joined", playerName: "Alice" }),
		"INVALID_INPUT",
	);
});

test("PlatformError carries stable API code and status", () => {
	const error = new PlatformError("CONSENT_REQUIRED", "Enable cloud backup.");
	assert.equal(error.name, "PlatformError");
	assert.equal(error.code, "CONSENT_REQUIRED");
	assert.equal(error.status, 403);
});
