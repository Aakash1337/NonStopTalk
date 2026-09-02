export type JudgeTier = "routine" | "escalated";

export interface JudgeVerdict {
	relevance: number;
	confidence: number;
	feedback: string;
}

export type OfflineJudgeFeedbackCode = "no-keywords" | "partial-keywords" | "topic-keywords";

export const MAX_JUDGE_FEEDBACK_CODE_POINTS = 500;
export const MAX_JUDGE_BONUS = 20;

export const OFFLINE_JUDGE_FEEDBACK: Readonly<Record<OfflineJudgeFeedbackCode, string>> = Object.freeze({
	"no-keywords": "Offline judge: none of the topic's key words came up, so only a small bonus.",
	"partial-keywords": "Offline judge: you hit some of the topic's key words, but wandered.",
	"topic-keywords": "Offline judge: you touched on the topic's key words.",
});

const OFFLINE_CONFIDENCE = 0.3;
const TRIM_CUTSET = new Set([".", ",", "!", "?", '"', "'", "(", ")", ":", ";"]);
const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"that",
	"with",
	"you",
	"your",
	"would",
	"should",
	"than",
	"about",
	"why",
	"how",
	"are",
	"everyone",
	"more",
	"most",
	"best",
	"into",
	"from",
]);
const UTF8_ENCODER = new TextEncoder();

function invalidVerdict(): Error {
	return new Error("Judge verdict is invalid.");
}

function assertUnitInterval(value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw invalidVerdict();
	}
}

function isGoSpace(codePoint: number): boolean {
	return (
		(codePoint >= 0x0009 && codePoint <= 0x000d) ||
		codePoint === 0x0020 ||
		codePoint === 0x0085 ||
		codePoint === 0x00a0 ||
		codePoint === 0x1680 ||
		(codePoint >= 0x2000 && codePoint <= 0x200a) ||
		codePoint === 0x2028 ||
		codePoint === 0x2029 ||
		codePoint === 0x202f ||
		codePoint === 0x205f ||
		codePoint === 0x3000
	);
}

function goFields(value: string): string[] {
	const fields: string[] = [];
	let field = "";
	for (const character of value) {
		if (isGoSpace(character.codePointAt(0)!)) {
			if (field !== "") {
				fields.push(field);
				field = "";
			}
		} else {
			field += character;
		}
	}
	if (field !== "") fields.push(field);
	return fields;
}

// Go applies Unicode simple lowercase mappings one rune at a time. JavaScript's
// only unconditional multi-code-point lowercase mapping needs this adjustment.
function goLower(value: string): string {
	let lowered = "";
	for (const character of value) {
		lowered += character === "\u0130" ? "i" : character.toLowerCase();
	}
	return lowered;
}

function trimCutset(value: string): string {
	const characters = [...value];
	let start = 0;
	let end = characters.length;
	while (start < end && TRIM_CUTSET.has(characters[start])) start++;
	while (end > start && TRIM_CUTSET.has(characters[end - 1])) end--;
	return characters.slice(start, end).join("");
}

function trimGoSpace(value: string): string {
	const characters = [...value];
	let start = 0;
	let end = characters.length;
	while (start < end && isGoSpace(characters[start].codePointAt(0)!)) start++;
	while (end > start && isGoSpace(characters[end - 1].codePointAt(0)!)) end--;
	return characters.slice(start, end).join("");
}

function topicKeywords(topic: string): Set<string> {
	const result = new Set<string>();
	for (const rawWord of goFields(goLower(topic))) {
		const word = trimCutset(rawWord);
		if (UTF8_ENCODER.encode(word).byteLength > 3 && !STOPWORDS.has(word)) result.add(word);
	}
	return result;
}

function spokenWords(transcript: string): Set<string> {
	return new Set(goFields(goLower(transcript)).map(trimCutset));
}

/** Grade locally with the same deterministic heuristic as the Go edition. */
export function gradeOfflineJudge(topic: string, transcript: string): JudgeVerdict {
	if (typeof topic !== "string" || typeof transcript !== "string") throw invalidVerdict();

	const keywords = topicKeywords(topic);
	const spoken = spokenWords(transcript);
	let matched = 0;
	for (const keyword of keywords) {
		if (spoken.has(keyword)) matched++;
	}

	const overlap = keywords.size === 0 ? 0 : matched / keywords.size;
	const length = Math.min(goFields(transcript).length / 30, 1);
	const relevance = Math.min(Math.max(0.7 * overlap + 0.3 * length, 0), 1);

	let feedback: string = OFFLINE_JUDGE_FEEDBACK["topic-keywords"];
	if (matched === 0) feedback = OFFLINE_JUDGE_FEEDBACK["no-keywords"];
	else if (overlap < 0.5) feedback = OFFLINE_JUDGE_FEEDBACK["partial-keywords"];

	return { relevance, confidence: OFFLINE_CONFIDENCE, feedback };
}

/** Validate an untrusted provider result and return its canonical safe shape. */
export function normalizeJudgeVerdict(value: unknown): JudgeVerdict {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidVerdict();
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length !== 3 || !keys.includes("relevance") || !keys.includes("confidence") || !keys.includes("feedback")) {
			throw invalidVerdict();
		}

		assertUnitInterval(record.relevance);
		assertUnitInterval(record.confidence);
		if (typeof record.feedback !== "string") throw invalidVerdict();
		const feedback = trimGoSpace(record.feedback);
		if (
			feedback === "" ||
			[...feedback].length > MAX_JUDGE_FEEDBACK_CODE_POINTS ||
			/[\u0000-\u001f\u007f-\u009f]/u.test(feedback)
		) {
			throw invalidVerdict();
		}

		return { relevance: record.relevance, confidence: record.confidence, feedback };
	} catch {
		throw invalidVerdict();
	}
}

/** Convert validated 0..1 relevance into the Go edition's 0..20 bonus. */
export function judgeBonus(relevance: number): number {
	assertUnitInterval(relevance);
	return Math.round(relevance * MAX_JUDGE_BONUS);
}

/** Render confidence with the same thresholds and labels as the Go edition. */
export function confidenceLabel(confidence: number | null | undefined): string {
	if (confidence === null || confidence === undefined) return "";
	assertUnitInterval(confidence);
	if (confidence >= 0.75) return "high confidence";
	if (confidence >= 0.4) return "medium confidence";
	return "low confidence";
}
