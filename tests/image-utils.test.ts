import assert from "node:assert/strict";
import test from "node:test";
import {formatFileSize, mimeTypeFromExtension} from "../src/utils/image-utils";

void test("mimeTypeFromExtension maps supported image extensions", () => {
	assert.equal(mimeTypeFromExtension("png"), "image/png");
	assert.equal(mimeTypeFromExtension("JPG"), "image/jpeg");
	assert.equal(mimeTypeFromExtension("jpeg"), "image/jpeg");
	assert.equal(mimeTypeFromExtension("webp"), "image/webp");
	assert.equal(mimeTypeFromExtension("gif"), "image/gif");
	assert.equal(mimeTypeFromExtension("svg"), "image/svg+xml");
	assert.equal(mimeTypeFromExtension("bin"), "application/octet-stream");
});

void test("formatFileSize renders bytes, kilobytes, and megabytes", () => {
	assert.equal(formatFileSize(512), "512 B");
	assert.equal(formatFileSize(1536), "1.5 KB");
	assert.equal(formatFileSize(2 * 1024 * 1024), "2.0 MB");
});
