import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

// Setup may run more than once, but the helper records each applied migration
// and safely skips it on subsequent calls.
await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
