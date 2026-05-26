import type {AssetOrigin, AssetStatus} from "./asset";

export type KeywordMode = "contains" | "exact" | "regex";
export type ImageRatioFilter = "landscape" | "portrait" | "square";

export interface AssetQuery {
	keyword?: string;
	keywordMode?: KeywordMode;
	linkedByNote?: string;
	linkedByFolder?: string;
	formats?: string[];
	origin?: AssetOrigin[];
	status?: AssetStatus[];
	minSizeKb?: number;
	maxSizeKb?: number;
	minWidth?: number;
	maxWidth?: number;
	minHeight?: number;
	maxHeight?: number;
	ratio?: ImageRatioFilter;
	tags?: string[];
	collections?: string[];
	ratingGte?: number;
	referenced?: boolean;
	hasOcr?: boolean;
	hasAnnotation?: boolean;
	minReferenceCount?: number;
	colors?: string[];
	createdAfter?: number;
	createdBefore?: number;
	modifiedAfter?: number;
	modifiedBefore?: number;
}

export type QuickFilterId = "all" | "unreferenced" | "favorites" | "recent" | "duplicates" | "trash";
