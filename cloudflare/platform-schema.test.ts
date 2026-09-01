import assert from "node:assert/strict";
import test from "node:test";

import { PlatformError } from "./platform.ts";
import { requireSupportedPlatformSchema } from "./platform-schema.ts";

class MutableSchemaD1 {
	schemaVersion: unknown = 5;
	markerReads = 0;

	prepare(query: string): D1PreparedStatement {
		assert.equal(query, "SELECT schema_version FROM platform_meta WHERE id = 1");
		this.markerReads += 1;
		return {
			first: async <T>() => ({ schema_version: this.schemaVersion }) as T,
		} as unknown as D1PreparedStatement;
	}
}

test("schema guard observes every same-binding transition without a stale cache", async () => {
	const database = new MutableSchemaD1();
	const binding = database as unknown as D1Database;

	assert.equal(await requireSupportedPlatformSchema(binding), 5);
	database.schemaVersion = 6;
	assert.equal(await requireSupportedPlatformSchema(binding), 6);

	for (const unsupported of [7, 5.5, null]) {
		database.schemaVersion = unsupported;
		await assert.rejects(
			requireSupportedPlatformSchema(binding),
			(error: unknown) => error instanceof PlatformError
				&& error.code === "DATABASE_UNAVAILABLE"
				&& error.status === 503,
		);
	}

	database.schemaVersion = 5;
	assert.equal(await requireSupportedPlatformSchema(binding), 5);
	assert.equal(database.markerReads, 6, "every logical operation must reread the singleton marker");
});
