export type AiMetadataProvider = "local" | "cloud";
export type AiMetadataBasis = "image" | "thumbnail" | "ocr" | "note-context";
export type AiSuggestionWriteTarget = "index" | "asset-note";

export interface AiSuggestedTag {
	value: string;
	confidence: number;
}

export interface AIMetadataSuggestion {
	assetId: string;
	title?: string;
	description?: string;
	tags: AiSuggestedTag[];
	provider: AiMetadataProvider;
	basedOn: AiMetadataBasis[];
	createdAt: number;
	updatedAt?: number;
	appliedAt?: number;
}
