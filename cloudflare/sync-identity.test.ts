import assert from "node:assert/strict";
import test from "node:test";

import { prepareSyncIdentityTouch, type DeviceKey } from "./sync-identity.ts";

class FakeStatement {
	bindings: unknown[] = [];

	constructor(readonly query: string) {}

	bind(...values: unknown[]): FakeStatement {
		this.bindings = values;
		return this;
	}
}

class FakeD1 {
	readonly prepared: FakeStatement[] = [];

	prepare(query: string): D1PreparedStatement {
		const statement = new FakeStatement(query);
		this.prepared.push(statement);
		return statement as unknown as D1PreparedStatement;
	}
}

test("sync identity touch is ordered, opaque, collision-strict, and device scoped", () => {
	const database = new FakeD1();
	const deviceKey = "a".repeat(64) as DeviceKey;
	const rawBrowserToken = "b".repeat(64);
	const statements = prepareSyncIdentityTouch(
		database as unknown as D1Database,
		deviceKey,
		"2026-09-01T00:00:00.000Z",
		"2026-10-01T00:00:00.000Z",
	);

	assert.equal(statements.length, 6);
	assert.match(database.prepared[0]?.query ?? "", /^DELETE FROM devices/u);
	assert.match(database.prepared[1]?.query ?? "", /ON CONFLICT\(device_key\)/u);
	assert.match(database.prepared[2]?.query ?? "", /INSERT INTO sync_profiles/u);
	assert.match(database.prepared[3]?.query ?? "", /INSERT INTO sync_profile_devices/u);
	assert.match(database.prepared[4]?.query ?? "", /UPDATE sync_profile_devices/u);
	assert.match(database.prepared[5]?.query ?? "", /UPDATE sync_profiles/u);

	const profileId = database.prepared[2]?.bindings[0];
	const membershipId = database.prepared[3]?.bindings[0];
	assert.equal(typeof profileId, "string");
	assert.equal(typeof membershipId, "string");
	assert.match(String(profileId), /^[a-f0-9]{64}$/u);
	assert.match(String(membershipId), /^[a-f0-9]{64}$/u);
	assert.notEqual(profileId, membershipId);
	assert.notEqual(profileId, deviceKey);
	assert.notEqual(membershipId, deviceKey);
	assert.equal(database.prepared[3]?.bindings[1], profileId);
	assert.equal(database.prepared[3]?.bindings[2], deviceKey);
	assert.equal(database.prepared[2]?.bindings[1], deviceKey);
	assert.equal(database.prepared[2]?.bindings[2], deviceKey);
	assert.equal(database.prepared[3]?.bindings[3], deviceKey);
	assert.match(database.prepared[2]?.query ?? "", /device\.created_at/u);
	assert.match(database.prepared[2]?.query ?? "", /device\.last_seen_at/u);
	assert.match(database.prepared[2]?.query ?? "", /device\.expires_at/u);
	assert.match(database.prepared[3]?.query ?? "", /device\.created_at/u);
	assert.match(database.prepared[3]?.query ?? "", /device\.last_seen_at/u);
	assert.doesNotMatch(database.prepared[2]?.query ?? "", /ON CONFLICT|OR IGNORE/u);
	assert.doesNotMatch(database.prepared[3]?.query ?? "", /ON CONFLICT|OR IGNORE/u);
	assert.equal(JSON.stringify(database.prepared).includes(rawBrowserToken), false);
});
