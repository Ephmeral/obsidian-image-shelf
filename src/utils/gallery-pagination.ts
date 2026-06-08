export type GalleryPageSize = 0 | 100 | 200 | 500;

export interface GalleryPaginationInput {
	totalItems: number;
	pageSize: GalleryPageSize;
	currentPage: number;
}

export interface GalleryPageSlice {
	pageSize: GalleryPageSize;
	currentPage: number;
	totalPages: number;
	startIndex: number;
	endIndex: number;
	displayStart: number;
	displayEnd: number;
	isPaged: boolean;
}

export interface GalleryPageChange {
	nextPage: number;
	shouldClearSelection: boolean;
}

export function normalizeGalleryPageSize(value: unknown): GalleryPageSize {
	if (value === 0 || value === 100 || value === 200 || value === 500) {
		return value;
	}
	return 200;
}

export function getGalleryPageChange(currentPage: number, requestedPage: number): GalleryPageChange {
	const nextPage = normalizeGalleryPageNumber(requestedPage);
	return {
		nextPage,
		shouldClearSelection: nextPage !== normalizeGalleryPageNumber(currentPage),
	};
}

export function getGalleryPageSlice(input: GalleryPaginationInput): GalleryPageSlice {
	const totalItems = Math.max(0, input.totalItems);
	const pageSize = normalizeGalleryPageSize(input.pageSize);
	if (pageSize === 0) {
		return {
			pageSize,
			currentPage: 1,
			totalPages: 1,
			startIndex: 0,
			endIndex: totalItems,
			displayStart: totalItems > 0 ? 1 : 0,
			displayEnd: totalItems,
			isPaged: false,
		};
	}

	const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
	const currentPage = clampInteger(input.currentPage, 1, totalPages);
	const startIndex = Math.min(totalItems, (currentPage - 1) * pageSize);
	const endIndex = Math.min(totalItems, startIndex + pageSize);
	return {
		pageSize,
		currentPage,
		totalPages,
		startIndex,
		endIndex,
		displayStart: totalItems > 0 ? startIndex + 1 : 0,
		displayEnd: endIndex,
		isPaged: true,
	};
}

function normalizeGalleryPageNumber(value: number): number {
	if (!Number.isFinite(value)) {
		return 1;
	}
	return Math.max(1, Math.trunc(value));
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.min(max, Math.max(min, Math.trunc(value)));
}
