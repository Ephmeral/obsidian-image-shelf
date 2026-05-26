import type {Asset} from "../types/asset";
import type {AssetQuery, QuickFilterId} from "../types/query";
import type {AssetRepository} from "./asset-repository";

export interface DuplicateGroup {
	id: string;
	type: "exact" | "similar";
	similarity: number;
	assets: Asset[];
	recommendedAssetId: string;
}

export class SearchService {
	private readonly repository: AssetRepository;

	constructor(repository: AssetRepository) {
		this.repository = repository;
	}

	filterAssets(assets: Asset[], quickFilter: QuickFilterId, query: AssetQuery): Asset[] {
		const linkedByNoteAssetIds = query.linkedByNote
			? new Set(this.repository.getReferencesForNote(query.linkedByNote).map((reference) => reference.assetId))
			: null;
		const linkedByFolderAssetIds = query.linkedByFolder
			? new Set(this.repository.getReferences()
				.filter((reference) => isPathInsideFolder(reference.sourceNotePath, query.linkedByFolder as string))
				.map((reference) => reference.assetId))
			: null;
		const duplicateAssetIds = quickFilter === "duplicates" ? getDuplicateAssetIds(assets) : null;
		return assets.filter((asset) => {
			const ocrText = this.repository.getOcrResult(asset.id)?.text;
			const aiSuggestion = this.repository.getAiSuggestion(asset.id);
			const hasOcr = Boolean(ocrText?.trim());
			const hasAnnotation = this.repository.getAnnotationsForAsset(asset.id).length > 0;
			if (quickFilter === "trash") {
				return asset.status === "trash" && matchesQuery(asset, query, linkedByNoteAssetIds, linkedByFolderAssetIds, ocrText, aiSuggestion, hasOcr, hasAnnotation);
			}
			if (asset.status !== "active") {
				return false;
			}
			if (quickFilter === "duplicates" && !duplicateAssetIds?.has(asset.id)) {
				return false;
			}
			if (quickFilter === "unreferenced" && asset.referenceCount > 0) {
				return false;
			}
			if (quickFilter === "favorites" && !asset.favorite) {
				return false;
			}
			if (quickFilter === "recent" && !isRecent(asset.mtime)) {
				return false;
			}
			return matchesQuery(asset, query, linkedByNoteAssetIds, linkedByFolderAssetIds, ocrText, aiSuggestion, hasOcr, hasAnnotation);
		});
	}
}

export function getDuplicateAssetIds(assets: Asset[]): Set<string> {
	const duplicateIds = new Set<string>();
	for (const group of getDuplicateGroups(assets)) {
		for (const asset of group.assets) {
			duplicateIds.add(asset.id);
		}
	}
	return duplicateIds;
}

export function getDuplicateCandidates(asset: Asset, assets: Asset[]): Asset[] {
	const keys = getDuplicateKeys(asset);
	if (keys.length === 0) {
		return [];
	}

	return assets
		.filter((candidate) => candidate.id !== asset.id)
		.filter((candidate) => getDuplicateKeys(candidate).some((key) => keys.includes(key)))
		.sort((left, right) => right.referenceCount - left.referenceCount || right.mtime - left.mtime || left.filename.localeCompare(right.filename));
}

export function getDuplicateGroups(assets: Asset[]): DuplicateGroup[] {
	const groups = new Map<string, {type: DuplicateGroup["type"]; assets: Asset[]}>();
	for (const asset of assets) {
		if (asset.status !== "active") {
			continue;
		}

		for (const key of getDuplicateKeysWithType(asset)) {
			const group = groups.get(key.id) ?? {type: key.type, assets: []};
			group.assets.push(asset);
			groups.set(key.id, group);
		}
	}

	const seenSignatures = new Set<string>();
	const duplicateGroups: DuplicateGroup[] = [];
	const sortedGroups = Array.from(groups.entries())
		.filter(([, group]) => group.assets.length >= 2)
		.sort(([, left], [, right]) => {
			if (left.type !== right.type) {
				return left.type === "exact" ? -1 : 1;
			}
			return right.assets.length - left.assets.length;
		});

	for (const [id, group] of sortedGroups) {
		const assets = [...group.assets].sort(compareDuplicateAssetPriority);
		const signature = assets.map((asset) => asset.id).sort().join("|");
		if (seenSignatures.has(signature)) {
			continue;
		}
		seenSignatures.add(signature);

		duplicateGroups.push({
			id,
			type: group.type,
			similarity: group.type === "exact" ? 100 : 92,
			assets,
			recommendedAssetId: assets[0]?.id ?? "",
		});
	}
	return duplicateGroups;
}

function getDuplicateKeys(asset: Asset): string[] {
	const keys: string[] = [];
	if (asset.sha256) {
		keys.push(`sha256:${asset.sha256}`);
	}
	if (asset.perceptualHash) {
		keys.push(`phash:${asset.perceptualHash}`);
	}
	return keys;
}

function getDuplicateKeysWithType(asset: Asset): Array<{id: string; type: DuplicateGroup["type"]}> {
	const keys: Array<{id: string; type: DuplicateGroup["type"]}> = [];
	if (asset.sha256) {
		keys.push({id: `sha256:${asset.sha256}`, type: "exact"});
	}
	if (asset.perceptualHash) {
		keys.push({id: `phash:${asset.perceptualHash}`, type: "similar"});
	}
	return keys;
}

function compareDuplicateAssetPriority(left: Asset, right: Asset): number {
	return right.referenceCount - left.referenceCount
		|| right.mtime - left.mtime
		|| right.sizeBytes - left.sizeBytes
		|| left.filename.localeCompare(right.filename);
}

function matchesQuery(asset: Asset, query: AssetQuery, linkedByNoteAssetIds: Set<string> | null, linkedByFolderAssetIds: Set<string> | null, ocrText: string | undefined, aiSuggestion: {title?: string; description?: string; tags: Array<{value: string}>} | undefined, hasOcr: boolean, hasAnnotation: boolean): boolean {
	if (linkedByNoteAssetIds && !linkedByNoteAssetIds.has(asset.id)) {
		return false;
	}
	if (linkedByFolderAssetIds && !linkedByFolderAssetIds.has(asset.id)) {
		return false;
	}
	if (query.keyword && !matchesKeyword(asset, query.keyword, query.keywordMode, ocrText, aiSuggestion)) {
		return false;
	}
	if (query.formats && query.formats.length > 0 && !query.formats.includes(asset.ext.toLowerCase())) {
		return false;
	}
	if (query.origin && query.origin.length > 0 && !query.origin.includes(asset.origin)) {
		return false;
	}
	if (query.status && query.status.length > 0 && !query.status.includes(asset.status)) {
		return false;
	}
	if (typeof query.referenced === "boolean" && (asset.referenceCount > 0) !== query.referenced) {
		return false;
	}
	if (typeof query.hasOcr === "boolean" && hasOcr !== query.hasOcr) {
		return false;
	}
	if (typeof query.hasAnnotation === "boolean" && hasAnnotation !== query.hasAnnotation) {
		return false;
	}
	if (typeof query.minReferenceCount === "number" && asset.referenceCount < query.minReferenceCount) {
		return false;
	}
	if (typeof query.minSizeKb === "number" && asset.sizeBytes < query.minSizeKb * 1024) {
		return false;
	}
	if (typeof query.maxSizeKb === "number" && asset.sizeBytes > query.maxSizeKb * 1024) {
		return false;
	}
	if (!matchesNumberRange(asset.width, query.minWidth, query.maxWidth)) {
		return false;
	}
	if (!matchesNumberRange(asset.height, query.minHeight, query.maxHeight)) {
		return false;
	}
	if (query.ratio && !matchesRatio(asset, query.ratio)) {
		return false;
	}
	if (query.tags && query.tags.length > 0 && !hasAny(asset.tags, query.tags)) {
		return false;
	}
	if (query.collections && query.collections.length > 0 && !hasAny(asset.collections, query.collections)) {
		return false;
	}
	if (typeof query.ratingGte === "number" && (asset.rating ?? 0) < query.ratingGte) {
		return false;
	}
	if (query.colors && query.colors.length > 0 && !hasAny(asset.dominantColors ?? [], query.colors)) {
		return false;
	}
	if (!matchesDateRange(asset.ctime, query.createdAfter, query.createdBefore)) {
		return false;
	}
	if (!matchesDateRange(asset.mtime, query.modifiedAfter, query.modifiedBefore)) {
		return false;
	}
	return true;
}

function matchesRatio(asset: Asset, ratio: NonNullable<AssetQuery["ratio"]>): boolean {
	if (typeof asset.width !== "number" || typeof asset.height !== "number" || asset.width <= 0 || asset.height <= 0) {
		return false;
	}
	const diff = Math.abs(asset.width - asset.height);
	const squareTolerance = Math.max(asset.width, asset.height) * 0.08;
	if (ratio === "square") {
		return diff <= squareTolerance;
	}
	if (ratio === "landscape") {
		return asset.width > asset.height + squareTolerance;
	}
	return asset.height > asset.width + squareTolerance;
}

function matchesKeyword(asset: Asset, keyword: string, keywordMode: AssetQuery["keywordMode"], ocrText?: string, aiSuggestion?: {title?: string; description?: string; tags: Array<{value: string}>}): boolean {
	const normalized = keyword.trim().toLowerCase();
	if (!normalized) {
		return true;
	}

	const haystackParts = [
		asset.filename,
		asset.filePath,
		asset.ext,
		...asset.tags,
		...asset.collections,
	];
	if (ocrText) {
		haystackParts.push(ocrText);
	}
	if (aiSuggestion) {
		haystackParts.push(aiSuggestion.title ?? "", aiSuggestion.description ?? "", ...aiSuggestion.tags.map((tag) => tag.value));
	}
	const normalizedParts = haystackParts.map((part) => part.toLowerCase());
	const haystack = normalizedParts.join(" ");

	if (keywordMode === "exact") {
		return normalizedParts.some((part) => part === normalized);
	}

	if (keywordMode === "regex") {
		if (keyword.length > 96) {
			return false;
		}
		try {
			return new RegExp(keyword, "i").test(haystack);
		} catch {
			return false;
		}
	}

	return haystack.includes(normalized);
}

function matchesNumberRange(value: number | undefined, min: number | undefined, max: number | undefined): boolean {
	if (typeof min !== "number" && typeof max !== "number") {
		return true;
	}
	if (typeof value !== "number") {
		return false;
	}
	if (typeof min === "number" && value < min) {
		return false;
	}
	if (typeof max === "number" && value > max) {
		return false;
	}
	return true;
}

function matchesDateRange(value: number, after: number | undefined, before: number | undefined): boolean {
	if (typeof after === "number" && value < after) {
		return false;
	}
	if (typeof before === "number" && value > before) {
		return false;
	}
	return true;
}

function hasAny(values: string[], requiredValues: string[]): boolean {
	const normalizedValues = values.map((value) => value.toLowerCase());
	return requiredValues.some((required) => normalizedValues.includes(required.toLowerCase()));
}

function isPathInsideFolder(filePath: string, folderPath: string): boolean {
	const normalizedFolder = folderPath.trim().replace(/\/+$/, "");
	if (!normalizedFolder) {
		return true;
	}
	return filePath === normalizedFolder || filePath.startsWith(`${normalizedFolder}/`);
}

function isRecent(mtime: number): boolean {
	const thirtyDays = 30 * 24 * 60 * 60 * 1000;
	return Date.now() - mtime <= thirtyDays;
}
