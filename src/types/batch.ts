export type BatchConvertFormat = "webp" | "jpg" | "png";

export interface BatchOperationDraft {
	assetIds: string[];
	addTags: string;
	removeTags: string;
	addCollections: string;
	moveToFolder: string;
	setRating: string;
	convertEnabled: boolean;
	convertFormat: BatchConvertFormat;
	convertMaxEdge: string;
	convertQuality: string;
	copyWikiLinks: boolean;
	rewriteMarkdownLinks: boolean;
}
