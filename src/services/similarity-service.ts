import type {Annotation, Asset} from "../types/asset";

export type SimilarityKind = "exact" | "near" | "visual";
export type SimilaritySortOption = "similarity-desc" | "references-desc" | "size-desc";

export interface SimilarityCandidate {
	asset: Asset;
	score: number;
	kind: SimilarityKind;
	reasons: string[];
}

export interface SimilarityResult {
	source: Asset;
	candidates: SimilarityCandidate[];
	recommendedAssetId: string;
	recommendedReasons: string[];
}

export class SimilarityService {
	findSimilarAssets(
		source: Asset,
		assets: Asset[],
		annotations: Annotation[],
		threshold: number,
		sortOption: SimilaritySortOption,
	): SimilarityResult {
		const candidates = assets
			.filter((asset) => asset.status === "active")
			.filter((asset) => asset.id !== source.id)
			.map((asset) => toSimilarityCandidate(source, asset))
			.filter((candidate): candidate is SimilarityCandidate => candidate !== null)
			.filter((candidate) => candidate.score >= threshold);
		candidates.sort((left, right) => compareCandidates(left, right, sortOption));

		const recommendationPool = [source, ...candidates.map((candidate) => candidate.asset)];
		const recommendedAsset = [...recommendationPool].sort((left, right) => compareKeepPriority(left, right, annotations))[0] ?? source;
		return {
			source,
			candidates,
			recommendedAssetId: recommendedAsset.id,
			recommendedReasons: getKeepRecommendationReasons(recommendedAsset, annotations),
		};
	}
}

function toSimilarityCandidate(source: Asset, candidate: Asset): SimilarityCandidate | null {
	if (source.sha256 && candidate.sha256 && source.sha256 === candidate.sha256) {
		return {
			asset: candidate,
			score: 100,
			kind: "exact",
			reasons: ["SHA-256 完全一致"],
		};
	}
	if (source.perceptualHash && candidate.perceptualHash && source.perceptualHash === candidate.perceptualHash) {
		return {
			asset: candidate,
			score: 92,
			kind: "near",
			reasons: ["感知 hash 一致"],
		};
	}
	return null;
}

function compareCandidates(left: SimilarityCandidate, right: SimilarityCandidate, sortOption: SimilaritySortOption): number {
	if (sortOption === "references-desc") {
		return right.asset.referenceCount - left.asset.referenceCount
			|| right.score - left.score
			|| left.asset.filename.localeCompare(right.asset.filename);
	}
	if (sortOption === "size-desc") {
		return right.asset.sizeBytes - left.asset.sizeBytes
			|| right.score - left.score
			|| left.asset.filename.localeCompare(right.asset.filename);
	}
	return right.score - left.score
		|| right.asset.referenceCount - left.asset.referenceCount
		|| left.asset.filename.localeCompare(right.asset.filename);
}

function compareKeepPriority(left: Asset, right: Asset, annotations: Annotation[]): number {
	return right.referenceCount - left.referenceCount
		|| getResolutionScore(right) - getResolutionScore(left)
		|| Number(Boolean(right.notePath)) - Number(Boolean(left.notePath))
		|| getAnnotationCount(right.id, annotations) - getAnnotationCount(left.id, annotations)
		|| (right.rating ?? 0) - (left.rating ?? 0)
		|| right.sizeBytes - left.sizeBytes
		|| left.filename.localeCompare(right.filename);
}

function getKeepRecommendationReasons(asset: Asset, annotations: Annotation[]): string[] {
	const reasons: string[] = [];
	if (asset.referenceCount > 0) {
		reasons.push(`被 ${asset.referenceCount} 处引用`);
	}
	if (asset.width && asset.height) {
		reasons.push(`分辨率 ${asset.width} x ${asset.height}`);
	}
	if (asset.notePath) {
		reasons.push("已有 Asset Note");
	}
	const annotationCount = getAnnotationCount(asset.id, annotations);
	if (annotationCount > 0) {
		reasons.push(`${annotationCount} 个标注`);
	}
	if (asset.rating) {
		reasons.push(`${asset.rating} 星评分`);
	}
	if (reasons.length === 0) {
		reasons.push("文件信息最完整");
	}
	return reasons;
}

function getResolutionScore(asset: Asset): number {
	return (asset.width ?? 0) * (asset.height ?? 0);
}

function getAnnotationCount(assetId: string, annotations: Annotation[]): number {
	return annotations.filter((annotation) => annotation.assetId === assetId).length;
}
