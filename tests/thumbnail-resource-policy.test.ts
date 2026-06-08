import assert from "node:assert/strict";
import test from "node:test";
import {resolveThumbnailResourcePolicy} from "../src/services/thumbnail-resource-policy";

void test("gallery thumbnails do not fall back to the original image while cold", () => {
	const result = resolveThumbnailResourcePolicy({
		variant: "small",
		cached: null,
		original: "app://vault/full-size.jpg",
		allowOriginalFallback: false,
	});

	assert.equal(result.resourcePath, null);
	assert.deepEqual(result.requestedVariants, ["small"]);
});

void test("gallery thumbnails use the cached small thumbnail when available", () => {
	const result = resolveThumbnailResourcePolicy({
		variant: "small",
		cached: "app://vault/thumb300.webp",
		original: "app://vault/full-size.jpg",
		allowOriginalFallback: false,
	});

	assert.equal(result.resourcePath, "app://vault/thumb300.webp");
	assert.deepEqual(result.requestedVariants, []);
});

void test("detail thumbnails can fall back to the original image", () => {
	const result = resolveThumbnailResourcePolicy({
		variant: "small",
		cached: null,
		original: "app://vault/full-size.jpg",
		allowOriginalFallback: true,
	});

	assert.equal(result.resourcePath, "app://vault/full-size.jpg");
	assert.deepEqual(result.requestedVariants, ["small"]);
});

void test("large detail thumbnails can show a cached small thumbnail while generating large", () => {
	const result = resolveThumbnailResourcePolicy({
		variant: "large",
		cached: null,
		cachedSmall: "app://vault/thumb300.webp",
		original: "app://vault/full-size.jpg",
		allowOriginalFallback: true,
	});

	assert.equal(result.resourcePath, "app://vault/thumb300.webp");
	assert.deepEqual(result.requestedVariants, ["large"]);
});
