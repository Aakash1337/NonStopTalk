import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations(
		path.join(import.meta.dirname, "cloudflare", "migrations"),
	);

	return {
		plugins: [
			cloudflareTest({
				// Keep this lane entirely local while exercising the exact opt-in
				// value used by the durable room-milestone producer.
				main: "./cloudflare/worker.ts",
				remoteBindings: false,
				miniflare: {
					compatibilityDate: "2026-09-01",
					bindings: {
						TEST_MIGRATIONS: migrations,
						ROOM_MILESTONE_DELIVERY_MODE: "outbox",
						ROOM_FACT_HASH_KEY: "7".repeat(64),
						ANALYTICS_ADMIN_TOKEN: "8".repeat(64),
					},
					d1Databases: ["PLATFORM_DB"],
					durableObjects: {
						ROOMS: {
							className: "RoomDurableObject",
							useSQLite: true,
						},
					},
				},
			}),
		],
		test: {
			include: ["cloudflare/outbox-runtime-tests/**/*.test.ts"],
			setupFiles: ["./cloudflare/runtime-tests/apply-d1-migrations.ts"],
			// Use Cloudflare's documented shared-runtime settings for stateful tests.
			fileParallelism: false,
			maxWorkers: 1,
			isolate: false,
		},
	};
});
