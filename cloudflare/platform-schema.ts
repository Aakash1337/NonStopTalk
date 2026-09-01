import { PlatformError } from "./platform";

export type SupportedPlatformSchemaVersion = 5 | 6;

const PLATFORM_SCHEMA_MARKER_SQL = "SELECT schema_version FROM platform_meta WHERE id = 1";

/**
 * Read the marker for every logical D1 operation. The compatibility boundary
 * is intentionally uncached so a running isolate rejects an unsupported
 * migration immediately and recovers without a redeploy after rollback.
 */
export async function requireSupportedPlatformSchema(
	database: D1Database,
): Promise<SupportedPlatformSchemaVersion> {
	try {
		const marker = await database
			.prepare(PLATFORM_SCHEMA_MARKER_SQL)
			.first<{ schema_version: unknown }>();
		const schemaVersion = marker?.schema_version;
		if (schemaVersion !== 5 && schemaVersion !== 6) {
			throw new Error("platform schema marker is missing or unsupported");
		}
		return schemaVersion;
	} catch (error) {
		throw new PlatformError("DATABASE_UNAVAILABLE", "The platform database has not been initialized.", {
			cause: error,
		});
	}
}
