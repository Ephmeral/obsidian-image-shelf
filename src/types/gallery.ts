export type MediaVaultGalleryViewMode = "masonry" | "grid" | "list" | "compact";

export type MediaVaultGallerySortOption = "mtime-desc" | "mtime-asc" | "name-asc" | "size-desc" | "references-desc";

export type MediaVaultGalleryDisplayField =
	| "filename"
	| "description"
	| "extension"
	| "dimensions"
	| "size"
	| "tags"
	| "rating"
	| "references"
	| "mtime"
	| "path";

export type MediaVaultGalleryDisplayFields = Record<MediaVaultGalleryDisplayField, boolean>;
