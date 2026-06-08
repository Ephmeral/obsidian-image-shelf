import assert from "node:assert/strict";
import test from "node:test";
import {getThumbnailPresetConfig, resolveThumbnailQualityPreset} from "../src/services/thumbnail-presets";

void test("thumbnail quality preset defaults to balanced", () => {
	assert.equal(resolveThumbnailQualityPreset(undefined), "balanced");
	assert.equal(resolveThumbnailQualityPreset("unknown"), "balanced");
});

void test("thumbnail quality presets expose expected size and quality values", () => {
	assert.deepEqual(getThumbnailPresetConfig("space"), {
		small: 240,
		large: 720,
		quality: 0.72,
		cacheSignature: "space-240-720-q72",
	});
	assert.deepEqual(getThumbnailPresetConfig("balanced"), {
		small: 360,
		large: 900,
		quality: 0.82,
		cacheSignature: "balanced-360-900-q82",
	});
	assert.deepEqual(getThumbnailPresetConfig("quality"), {
		small: 480,
		large: 1200,
		quality: 0.9,
		cacheSignature: "quality-480-1200-q90",
	});
});

void test("thumbnail cache signature changes by quality preset", () => {
	assert.notEqual(getThumbnailPresetConfig("space").cacheSignature, getThumbnailPresetConfig("quality").cacheSignature);
	assert.equal(getThumbnailPresetConfig("balanced").cacheSignature, getThumbnailPresetConfig("balanced").cacheSignature);
});
