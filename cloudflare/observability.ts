export type WorkerLogLevel = "info" | "warn" | "error";
export type WorkerLogValue = string | number | boolean | null;

/**
 * Emit one bounded JSON record so Workers Logs can filter by stable event,
 * request, provider, and milestone fields. Callers deliberately pass only
 * allowlisted primitive values; never pass request bodies, tokens, or errors.
 */
export function logWorkerEvent(
	level: WorkerLogLevel,
	event: string,
	fields: Record<string, WorkerLogValue | undefined> = {},
): void {
	const record = buildWorkerLogRecord(level, event, fields);
	if (level === "error") {
		console.error(record);
		return;
	}
	if (level === "warn") {
		console.warn(record);
		return;
	}
	console.log(record);
}

export function buildWorkerLogRecord(
	level: WorkerLogLevel,
	event: string,
	fields: Record<string, WorkerLogValue | undefined> = {},
): Record<string, WorkerLogValue> {
	const record: Record<string, WorkerLogValue> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) record[key] = value;
	}
	// Protected envelope fields always win over caller-supplied names.
	record.timestamp = new Date().toISOString();
	record.level = level;
	record.event = event;
	return record;
}
