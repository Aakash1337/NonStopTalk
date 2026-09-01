import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// This suite exercises only the Room Durable Object. Defining its
			// SQLite binding directly keeps tests local and prevents the production
			// Workers AI binding from opening a remote proxy connection.
			main: "./cloudflare/worker.ts",
			remoteBindings: false,
			miniflare: {
				compatibilityDate: "2026-09-01",
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
	},
});
