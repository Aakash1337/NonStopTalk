import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	MAX_JUDGE_BONUS,
	MAX_JUDGE_FEEDBACK_CODE_POINTS,
	OFFLINE_JUDGE_FEEDBACK,
	confidenceLabel,
	gradeOfflineJudge,
	judgeBonus,
	normalizeJudgeVerdict,
	type JudgeTier,
	type JudgeVerdict,
	type OfflineJudgeFeedbackCode,
} from "./judge.ts";

interface JudgeContract {
	schemaVersion: number;
	constants: {
		maxBonus: number;
		maxFeedbackCodePoints: number;
		offlineConfidence: number;
		feedback: Record<OfflineJudgeFeedbackCode, string>;
	};
	cases: {
		offlineGrades: Array<{
			id: string;
			topic: string;
			transcript: string;
			expected: {
				relevance: number;
				confidence: number;
				feedbackCode: OfflineJudgeFeedbackCode;
				bonus: number;
			};
		}>;
		validVerdicts: Array<{ id: string; input: unknown; expected: JudgeVerdict }>;
		invalidVerdicts: Array<{ id: string; input: unknown }>;
		bonuses: Array<{ relevance: number; expected: number }>;
		confidenceLabels: Array<{ confidence: number | null; expected: string }>;
	};
}

const contract = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../testdata/judge-contract.v1.json"), "utf8"),
) as JudgeContract;

function assertNear(actual: number, expected: number, message: string): void {
	assert.ok(Math.abs(actual - expected) <= 1e-12, `${message}: expected ${expected}, got ${actual}`);
}

test("shared judge constants match the Cloudflare core", () => {
	assert.equal(contract.schemaVersion, 1);
	assert.equal(contract.constants.maxBonus, MAX_JUDGE_BONUS);
	assert.equal(contract.constants.maxFeedbackCodePoints, MAX_JUDGE_FEEDBACK_CODE_POINTS);
	assert.deepEqual(contract.constants.feedback, OFFLINE_JUDGE_FEEDBACK);
});

test("offline judge matches the shared Go contract", () => {
	for (const fixture of contract.cases.offlineGrades) {
		const verdict = gradeOfflineJudge(fixture.topic, fixture.transcript);
		assertNear(verdict.relevance, fixture.expected.relevance, fixture.id);
		assert.equal(verdict.confidence, fixture.expected.confidence, fixture.id);
		assert.equal(verdict.feedback, contract.constants.feedback[fixture.expected.feedbackCode], fixture.id);
		assert.equal(judgeBonus(verdict.relevance), fixture.expected.bonus, fixture.id);
	}
});

test("provider verdict normalization accepts only the safe canonical shape", () => {
	for (const fixture of contract.cases.validVerdicts) {
		assert.deepEqual(normalizeJudgeVerdict(fixture.input), fixture.expected, fixture.id);
	}
	for (const fixture of contract.cases.invalidVerdicts) {
		assert.throws(() => normalizeJudgeVerdict(fixture.input), /Judge verdict is invalid\./, fixture.id);
	}
});

test("provider verdict normalization rejects non-JSON numeric values and unsafe feedback", () => {
	for (const relevance of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		assert.throws(() => normalizeJudgeVerdict({ relevance, confidence: 0.5, feedback: "Good." }));
	}
	assert.throws(() =>
		normalizeJudgeVerdict({ relevance: 0.5, confidence: 0.5, feedback: "x".repeat(MAX_JUDGE_FEEDBACK_CODE_POINTS + 1) }),
	);
	assert.doesNotThrow(() =>
		normalizeJudgeVerdict({ relevance: 0.5, confidence: 0.5, feedback: "🎙".repeat(MAX_JUDGE_FEEDBACK_CODE_POINTS) }),
	);
	assert.throws(() => normalizeJudgeVerdict({ relevance: 0.5, confidence: 0.5, feedback: "unsafe\u0000text" }));
	assert.throws(() => normalizeJudgeVerdict({ relevance: 0.5, confidence: 0.5, feedback: "unsafe\ttext" }));
});

test("judge bonus matches shared rounding and fails closed outside 0..1", () => {
	for (const fixture of contract.cases.bonuses) {
		assert.equal(judgeBonus(fixture.relevance), fixture.expected);
	}
	for (const relevance of [-0.001, 1.001, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => judgeBonus(relevance), /Judge verdict is invalid\./);
	}
});

test("confidence labels match the Go thresholds and fail closed on invalid confidence", () => {
	for (const fixture of contract.cases.confidenceLabels) {
		assert.equal(confidenceLabel(fixture.confidence), fixture.expected);
	}
	assert.equal(confidenceLabel(undefined), "");
	for (const confidence of [-0.001, 1.001, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => confidenceLabel(confidence), /Judge verdict is invalid\./);
	}
});

test("the requested public contract exports remain assignable", () => {
	const tier: JudgeTier = "routine";
	const verdict: JudgeVerdict = gradeOfflineJudge("Ocean storms", "ocean");
	assert.equal(tier, "routine");
	assert.equal(normalizeJudgeVerdict(verdict).feedback, verdict.feedback);
});
