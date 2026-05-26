import {INDEX_SCHEMA_VERSION} from "../constants";
import type {AIMetadataSuggestion} from "./ai";
import type {OcrResult} from "./ocr";

export const DEFAULT_ANNOTATION_COLOR = "#5a50d8";

export const ANNOTATION_COLOR_SWATCHES = [
	DEFAULT_ANNOTATION_COLOR,
	"#16956d",
	"#d97706",
	"#d94f70",
	"#2f80d0",
	"#2f2f2f",
] as const;

export type AssetOrigin = "local-note" | "library" | "screenshot" | "web" | "imported";

export type AssetStatus = "active" | "archived" | "trash" | "missing";

export interface AssetThumbnailState {
	thumb300?: string;
	thumb800?: string;
	updatedAt?: number;
}

export interface Asset {
	id: string;
	filePath: string;
	notePath?: string;
	origin: AssetOrigin;
	status: AssetStatus;
	filename: string;
	ext: string;
	mimeType: string;
	sizeBytes: number;
	width?: number;
	height?: number;
	ctime: number;
	mtime: number;
	sha256?: string;
	perceptualHash?: string;
	dominantColors?: string[];
	tags: string[];
	collections: string[];
	rating?: 0 | 1 | 2 | 3 | 4 | 5;
	favorite: boolean;
	referenceCount: number;
	thumbnail: AssetThumbnailState;
	createdAt: number;
	updatedAt: number;
}

export type ReferenceLinkType = "embed" | "markdown-image" | "html-img" | "asset-note-link";

export interface AssetReference {
	assetId: string;
	sourceNotePath: string;
	linkType: ReferenceLinkType;
	rawLink: string;
	resolvedPath?: string;
	lineStart?: number;
	lineEnd?: number;
	heading?: string;
	blockId?: string;
	contextPreview?: string;
}

export type AnnotationStorageMode = "asset-note" | "index";

export interface Annotation {
	id: string;
	assetId: string;
	label: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
	text?: string;
	linkedNotePath?: string;
	linkedHeading?: string;
	linkedBlockId?: string;
	storageMode?: AnnotationStorageMode;
	createdAt: number;
	updatedAt: number;
}

export type CollectionType = "manual" | "smart" | "system";

export interface Collection {
	id: string;
	name: string;
	type: CollectionType;
	description?: string;
	icon?: string;
	color?: string;
	query?: Record<string, unknown>;
	assetIds?: string[];
	createdAt: number;
	updatedAt: number;
}

export interface ImageGalleryIndexSnapshot {
	schemaVersion: number;
	assets: Asset[];
	references: AssetReference[];
	collections: Collection[];
	annotations: Annotation[];
	ocrResults: OcrResult[];
	aiSuggestions: AIMetadataSuggestion[];
	updatedAt: number;
}

export function createEmptyIndexSnapshot(): ImageGalleryIndexSnapshot {
	return {
		schemaVersion: INDEX_SCHEMA_VERSION,
		assets: [],
			references: [],
			collections: [],
			annotations: [],
			ocrResults: [],
			aiSuggestions: [],
			updatedAt: Date.now(),
		};
	}
