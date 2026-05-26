import type {Asset, AssetReference, Collection} from "../types/asset";
import type {AIMetadataSuggestion} from "../types/ai";
import type {OcrResult} from "../types/ocr";

export type RecommendationReasonType = "tag" | "collection" | "folder" | "text" | "referenced-context" | "popular" | "ocr" | "ai";
export type RecommendationInsertMode = "embed" | "link" | "asset-note-link";

export interface RecommendationReason {
	type: RecommendationReasonType;
	label: string;
	detail: string;
	value?: string;
}

export interface Recommendation {
	assetId: string;
	score: number;
	reasons: RecommendationReason[];
	insertMode: RecommendationInsertMode;
}

export interface RecommendationContext {
	notePath: string;
	noteTitle: string;
	noteFolder: string;
	noteText: string;
	frontmatterTags: string[];
	referencedAssetIds: Set<string>;
}

export interface RecommendationSources {
	ocrResults?: OcrResult[];
	aiSuggestions?: AIMetadataSuggestion[];
}

export interface RecommendationDismissal {
	notePath: string;
	assetId: string;
	dismissedAt: number;
	dismissCount: number;
}

export class RecommendationService {
	recommendForNote(context: RecommendationContext, assets: Asset[], references: AssetReference[], collections: Collection[], sources: RecommendationSources = {}): Recommendation[] {
		const linkedAssets = assets.filter((asset) => context.referencedAssetIds.has(asset.id));
		const linkedTags = new Set(linkedAssets.flatMap((asset) => asset.tags.map(normalizeToken)));
		const linkedCollections = new Set(linkedAssets.flatMap((asset) => asset.collections.map(normalizeToken)));
		const noteTokens = getNoteTokens(context);
		const smartCollections = collections.filter((collection) => collection.type === "smart");
		const ocrByAssetId = new Map((sources.ocrResults ?? []).map((result) => [result.assetId, result]));
		const aiByAssetId = new Map((sources.aiSuggestions ?? []).map((suggestion) => [suggestion.assetId, suggestion]));

		return assets
			.filter((asset) => asset.status === "active")
			.filter((asset) => !context.referencedAssetIds.has(asset.id))
			.map((asset) => scoreAsset(asset, context, references, noteTokens, linkedTags, linkedCollections, smartCollections, ocrByAssetId.get(asset.id), aiByAssetId.get(asset.id)))
			.filter((recommendation) => recommendation.score > 0)
			.sort((left, right) => right.score - left.score || left.assetId.localeCompare(right.assetId))
			.slice(0, 24);
	}
}

function scoreAsset(
	asset: Asset,
	context: RecommendationContext,
	references: AssetReference[],
	noteTokens: Set<string>,
	linkedTags: Set<string>,
	linkedCollections: Set<string>,
	smartCollections: Collection[],
	ocrResult: OcrResult | undefined,
	aiSuggestion: AIMetadataSuggestion | undefined,
): Recommendation {
	let score = 0;
	const reasons: RecommendationReason[] = [];
	const assetTags = asset.tags.map(normalizeToken);
	const assetCollections = asset.collections.map(normalizeToken);
	const frontmatterTags = context.frontmatterTags.map(normalizeToken);
	const matchedTags = assetTags.filter((tag) => frontmatterTags.includes(tag));
	if (matchedTags.length > 0) {
		score += matchedTags.length * 30;
		reasons.push({
			type: "tag",
			label: "标签匹配",
			detail: matchedTags.slice(0, 3).map((tag) => `#${tag}`).join("、"),
			value: matchedTags[0],
		});
	}

	const inheritedTags = assetTags.filter((tag) => linkedTags.has(tag));
	if (inheritedTags.length > 0) {
		score += Math.min(24, inheritedTags.length * 8);
		reasons.push({
			type: "referenced-context",
			label: "已引用图片相似",
			detail: inheritedTags.slice(0, 3).map((tag) => `#${tag}`).join("、"),
			value: inheritedTags[0],
		});
	}

	const inheritedCollections = assetCollections.filter((collection) => linkedCollections.has(collection));
	if (inheritedCollections.length > 0) {
		score += Math.min(18, inheritedCollections.length * 6);
		reasons.push({
			type: "collection",
			label: "同 Collection",
			detail: inheritedCollections.slice(0, 2).join("、"),
			value: inheritedCollections[0],
		});
	}

	if (ocrResult?.text) {
		const ocrMatches = getTokenMatches(noteTokens, normalizeToken(ocrResult.text), 6);
		if (ocrMatches.length > 0) {
			score += Math.min(34, ocrMatches.length * 7);
			reasons.push({
				type: "ocr",
				label: "OCR 命中",
				detail: ocrMatches.slice(0, 4).join("、"),
				value: ocrMatches[0],
			});
		}
	}

	if (aiSuggestion) {
		const aiText = normalizeToken(`${aiSuggestion.title ?? ""} ${aiSuggestion.description ?? ""} ${aiSuggestion.tags.map((tag) => tag.value).join(" ")}`);
		const aiMatches = getTokenMatches(noteTokens, aiText, 6);
		const aiTagMatches = aiSuggestion.tags
			.map((tag) => normalizeToken(tag.value))
			.filter((tag) => frontmatterTags.includes(tag) || linkedTags.has(tag));
		const matchedAiTokens = [...aiTagMatches, ...aiMatches].filter(Boolean);
		if (matchedAiTokens.length > 0) {
			score += Math.min(32, matchedAiTokens.length * 6);
			reasons.push({
				type: "ai",
				label: "AI 标签命中",
				detail: Array.from(new Set(matchedAiTokens)).slice(0, 4).map(formatTagOrToken).join("、"),
				value: matchedAiTokens[0],
			});
		}
	}

	const assetText = normalizeToken(`${asset.filename} ${asset.filePath} ${asset.tags.join(" ")} ${asset.collections.join(" ")}`);
	const tokenMatches = getTokenMatches(noteTokens, assetText, 8);
	if (tokenMatches.length > 0) {
		score += Math.min(30, tokenMatches.length * 5);
		reasons.push({
			type: "text",
			label: "正文命中",
			detail: tokenMatches.slice(0, 4).join("、"),
			value: tokenMatches[0],
		});
	}

	const folderMatch = isSameProjectFolder(asset.filePath, context.noteFolder);
	if (folderMatch) {
		score += 10;
		reasons.push({
			type: "folder",
			label: "同项目目录",
			detail: context.noteFolder,
			value: context.noteFolder,
		});
	}

	const smartCollectionMatch = smartCollections.find((collection) => asset.collections.some((assetCollection) => normalizeToken(assetCollection) === normalizeToken(collection.name)));
	if (smartCollectionMatch) {
		score += 5;
		reasons.push({
			type: "collection",
			label: "智能集合相关",
			detail: smartCollectionMatch.name,
			value: smartCollectionMatch.name,
		});
	}

	if (asset.favorite) {
		score += 4;
	}
	if (asset.referenceCount > 0) {
		score += Math.min(8, asset.referenceCount);
		reasons.push({
			type: "popular",
			label: "历史引用",
			detail: `${asset.referenceCount} 处引用`,
		});
	}
	if (references.some((reference) => reference.assetId === asset.id && reference.sourceNotePath.startsWith(context.noteFolder))) {
		score += 6;
	}

	return {
		assetId: asset.id,
		score,
		reasons: compactReasons(reasons),
		insertMode: "embed",
	};
}

function getNoteTokens(context: RecommendationContext): Set<string> {
	const source = `${context.noteTitle} ${context.noteText} ${context.frontmatterTags.join(" ")}`;
	return new Set(normalizeToken(source).split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((token) => token.length >= 2 && !STOP_WORDS.has(token)));
}

function getTokenMatches(noteTokens: Set<string>, haystack: string, maxMatches: number): string[] {
	const matches: string[] = [];
	for (const token of noteTokens) {
		if (token.length < 2 || STOP_WORDS.has(token)) {
			continue;
		}
		if (haystack.includes(token)) {
			matches.push(token);
		}
		if (matches.length >= maxMatches) {
			break;
		}
	}
	return matches;
}

function compactReasons(reasons: RecommendationReason[]): RecommendationReason[] {
	const seen = new Set<string>();
	return reasons.filter((reason) => {
		const key = `${reason.type}:${reason.label}:${reason.value ?? reason.detail}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	}).slice(0, 4);
}

function normalizeToken(value: string): string {
	return value.toLowerCase().trim();
}

function formatTagOrToken(value: string): string {
	if (/^[a-z0-9][a-z0-9-]*$/.test(value)) {
		return `#${value}`;
	}
	return value;
}

function isSameProjectFolder(assetPath: string, noteFolder: string): boolean {
	if (!noteFolder) {
		return false;
	}
	const firstFolder = noteFolder.split("/")[0];
	return Boolean(firstFolder && assetPath.startsWith(`${firstFolder}/`));
}

const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"this",
	"that",
	"image",
	"图片",
	"笔记",
	"方案",
	"参考",
]);
