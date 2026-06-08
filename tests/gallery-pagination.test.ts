import assert from "node:assert/strict";
import test from "node:test";
import {getGalleryPageChange, getGalleryPageSlice, normalizeGalleryPageSize} from "../src/utils/gallery-pagination";

void test("gallery pagination splits 450 assets into three 200-item pages", () => {
	const page = getGalleryPageSlice({totalItems: 450, pageSize: 200, currentPage: 1});

	assert.deepEqual(page, {
		pageSize: 200,
		currentPage: 1,
		totalPages: 3,
		startIndex: 0,
		endIndex: 200,
		displayStart: 1,
		displayEnd: 200,
		isPaged: true,
	});
});

void test("gallery pagination clamps out-of-range pages", () => {
	const page = getGalleryPageSlice({totalItems: 450, pageSize: 200, currentPage: 9});

	assert.equal(page.currentPage, 3);
	assert.equal(page.startIndex, 400);
	assert.equal(page.endIndex, 450);
	assert.equal(page.displayStart, 401);
	assert.equal(page.displayEnd, 450);
});

void test("gallery page size zero means show all", () => {
	const page = getGalleryPageSlice({totalItems: 450, pageSize: 0, currentPage: 3});

	assert.deepEqual(page, {
		pageSize: 0,
		currentPage: 1,
		totalPages: 1,
		startIndex: 0,
		endIndex: 450,
		displayStart: 1,
		displayEnd: 450,
		isPaged: false,
	});
});

void test("gallery page size falls back to 200", () => {
	assert.equal(normalizeGalleryPageSize(undefined), 200);
	assert.equal(normalizeGalleryPageSize(333), 200);
	assert.equal(normalizeGalleryPageSize(500), 500);
	assert.equal(normalizeGalleryPageSize(0), 0);
});

void test("gallery page changes clear current selection only when page changes", () => {
	assert.deepEqual(getGalleryPageChange(1, 2), {
		nextPage: 2,
		shouldClearSelection: true,
	});
	assert.deepEqual(getGalleryPageChange(2, 2), {
		nextPage: 2,
		shouldClearSelection: false,
	});
});
