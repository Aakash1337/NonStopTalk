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
				// Define the runtime bindings directly so every test stays local and
				// the production Workers AI binding never opens a remote proxy.
				main: "./cloudflare/worker.ts",
				remoteBindings: false,
				miniflare: {
					compatibilityDate: "2026-09-01",
					bindings: { TEST_MIGRATIONS: migrations },
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
			include: ["cloudflare/runtime-tests/**/*.test.ts"],
			setupFiles: ["./cloudflare/runtime-tests/apply-d1-migrations.ts"],
			// Runtime files share D1 and Durable Object bindings. Separate them so
			// one pool cannot tear down the Worker while another still uses it.
			fileParallelism: false,
		},
	};
});
