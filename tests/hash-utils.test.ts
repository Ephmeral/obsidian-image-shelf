import assert from "node:assert/strict";
import test from "node:test";
import {generateAssetId, stableHash8} from "../src/utils/hash-utils";

void test("stableHash8 returns a stable 8-character hexadecimal hash", () => {
	assert.equal(stableHash8("Assets/Images/example.png"), stableHash8("Assets/Images/example.png"));
	assert.match(stableHash8("Assets/Images/example.png"), /^[0-9a-f]{8}$/);
	assert.notEqual(stableHash8("Assets/Images/example.png"), stableHash8("Assets/Images/other.png"));
});

void test("generateAssetId includes the image date and a stable path fingerprint", () => {
	const ctime = Date.UTC(2026, 4, 26, 10, 30, 0);
	const id = generateAssetId("Assets/Images/example.png", ctime, 2048);

	assert.match(id, /^img_20260526_[0-9a-f]{8}$/);
	assert.equal(id, generateAssetId("Assets/Images/example.png", ctime, 2048));
});
