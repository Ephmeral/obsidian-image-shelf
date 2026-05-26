import type {Asset, AssetReference} from "../types/asset";
import type {AIMetadataSuggestion, AiMetadataBasis, AiSuggestedTag} from "../types/ai";
import type {AssetRepository} from "./asset-repository";
import type {JobQueueService} from "./task-queue";

const MAX_TAGS = 8;
const STOP_WORDS = new Set([
	"assets",
	"attachments",
	"images",
	"image",
	"pics",
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif",
	"screenshot",
	"screen",
	"copy",
	"asset",
	"media",
	"vault",
	"untitled",
	"unnamed",
	"未命名",
]);

export class AiMetadataService {
	private readonly repository: AssetRepository;
	private readonly jobQueue: JobQueueService;

	constructor(repository: AssetRepository, jobQueue: JobQueueService) {
		this.repository = repository;
		this.jobQueue = jobQueue;
	}

	getSuggestion(assetId: string | null | undefined): AIMetadataSuggestion | undefined {
		return this.repository.getAiSuggestion(assetId);
	}

	async generateLocalSuggestion(asset: Asset, references: AssetReference[] = []): Promise<AIMetadataSuggestion> {
		const jobId = this.jobQueue.startJob({
			type: "ai",
			assetId: asset.id,
			label: "生成标签建议",
			total: 1,
			priority: "normal",
			details: "使用本地规则生成标题、描述和标签建议。",
		});
		try {
			const now = Date.now();
			const suggestion = this.buildLocalSuggestion(asset, references, now);
			await this.repository.upsertAiSuggestion(suggestion);
			this.jobQueue.completeJob(jobId, "标签建议已生成。");
			return suggestion;
		} catch (error) {
			this.jobQueue.failJob(jobId, error);
			throw error;
		}
	}

	async markApplied(suggestion: AIMetadataSuggestion): Promise<void> {
		await this.repository.upsertAiSuggestion({
			...suggestion,
			appliedAt: Date.now(),
			updatedAt: Date.now(),
		});
	}

	formatAssetNoteSection(suggestion: AIMetadataSuggestion, selectedTags: string[]): string {
		const lines = [
			"## AI 标签建议",
			"",
			`生成时间：${formatDateTime(suggestion.updatedAt ?? suggestion.createdAt)}  `,
			`来源：${suggestion.provider}  `,
			`依据：${suggestion.basedOn.join("、") || "local"}`,
			"",
		];
		if (suggestion.title) {
			lines.push(`标题建议：${suggestion.title}`, "");
		}
		if (suggestion.description) {
			lines.push(suggestion.description, "");
		}
		if (selectedTags.length > 0) {
			lines.push(`标签：${selectedTags.map((tag) => `#${tag}`).join(" ")}`, "");
		}
		return lines.join("\n");
	}

	mergeAssetNoteContent(content: string, suggestion: AIMetadataSuggestion, selectedTags: string[]): string {
		const section = this.formatAssetNoteSection(suggestion, selectedTags).trimEnd();
		const normalized = content.trimEnd();
		if (!normalized) {
			return `${section}\n`;
		}
		const lines = normalized.split(/\r?\n/);
		const start = lines.findIndex((line) => line.trim() === "## AI 标签建议");
		if (start < 0) {
			return `${normalized}\n\n${section}\n`;
		}

		let end = lines.length;
		let inFence = false;
		for (let index = start + 1; index < lines.length; index += 1) {
			const line = lines[index]?.trim() ?? "";
			if (line.startsWith("```")) {
				inFence = !inFence;
			}
			if (!inFence && /^##\s+/.test(line)) {
				end = index;
				break;
			}
		}
		return `${[...lines.slice(0, start), ...section.split("\n"), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
	}

	private buildLocalSuggestion(asset: Asset, references: AssetReference[], now: number): AIMetadataSuggestion {
		const ocrResult = this.repository.getOcrResult(asset.id);
		const basedOn = new Set<AiMetadataBasis>(["image"]);
		const weightedTags = new Map<string, number>();

		for (const token of extractTokens(asset.filename, 0.82)) {
			addWeight(weightedTags, token.value, token.confidence);
		}
		for (const token of extractTokens(asset.filePath, 0.72)) {
			addWeight(weightedTags, token.value, token.confidence);
		}
		if (typeof asset.width === "number" && typeof asset.height === "number") {
			addWeight(weightedTags, asset.width >= asset.height ? "landscape" : "portrait", 0.68);
		}
		if (asset.ext) {
			addWeight(weightedTags, asset.ext.toLowerCase(), 0.56);
		}
		for (const tag of asset.tags) {
			addWeight(weightedTags, tag, 0.95);
		}
		for (const collection of asset.collections) {
			addWeight(weightedTags, collection, 0.78);
		}
		if (ocrResult?.text) {
			basedOn.add("ocr");
			for (const token of extractTokens(ocrResult.text, 0.7)) {
				addWeight(weightedTags, token.value, token.confidence);
			}
		}
		if (references.length > 0) {
			basedOn.add("note-context");
			for (const reference of references.slice(0, 6)) {
				for (const token of extractTokens(`${reference.sourceNotePath} ${reference.heading ?? ""} ${reference.contextPreview ?? ""}`, 0.66)) {
					addWeight(weightedTags, token.value, token.confidence);
				}
			}
		}
		if (asset.thumbnail.thumb300 || asset.thumbnail.thumb800) {
			basedOn.add("thumbnail");
		}

		const tags = Array.from(weightedTags.entries())
			.map(([value, confidence]) => ({value, confidence: clampConfidence(confidence)}))
			.sort((left, right) => right.confidence - left.confidence || left.value.localeCompare(right.value))
			.slice(0, MAX_TAGS);
		const title = buildSuggestionTitle(asset, tags);
		return {
			assetId: asset.id,
			title,
			description: buildDescription(asset, tags, references.length, Boolean(ocrResult?.text)),
			tags,
			provider: "local",
			basedOn: Array.from(basedOn),
			createdAt: this.repository.getAiSuggestion(asset.id)?.createdAt ?? now,
			updatedAt: now,
		};
	}
}

export function mergeTags(existingTags: string[], suggestedTags: string[]): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const tag of [...existingTags, ...suggestedTags]) {
		const normalized = normalizeTag(tag);
		if (!normalized || seen.has(normalized.toLowerCase())) {
			continue;
		}
		seen.add(normalized.toLowerCase());
		merged.push(normalized);
	}
	return merged;
}

function extractTokens(text: string, confidence: number): AiSuggestedTag[] {
	const tokens = text
		.toLowerCase()
		.replace(/[\u4e00-\u9fff]+/g, (segment) => ` ${segment} `)
		.split(/[^a-z0-9\u4e00-\u9fff]+/)
		.map((token) => normalizeTag(token))
		.filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
	const unique = new Set<string>();
	const result: AiSuggestedTag[] = [];
	for (const token of tokens) {
		if (unique.has(token)) {
			continue;
		}
		unique.add(token);
		result.push({value: token, confidence});
		if (result.length >= 16) {
			break;
		}
	}
	return result;
}

function normalizeTag(tag: string): string {
	return tag.trim()
		.replace(/^#+/, "")
		.replace(/\s+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function addWeight(map: Map<string, number>, tag: string, confidence: number): void {
	const normalized = normalizeTag(tag);
	if (!normalized || STOP_WORDS.has(normalized.toLowerCase())) {
		return;
	}
	map.set(normalized, Math.max(map.get(normalized) ?? 0, confidence));
}

function buildSuggestionTitle(asset: Asset, tags: AiSuggestedTag[]): string {
	const base = asset.filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
	if (base && !/^(未命名|untitled)/i.test(base)) {
		return base.slice(0, 80);
	}
	const firstTag = tags[0]?.value ?? asset.ext.toUpperCase();
	return `${firstTag} image`;
}

function buildDescription(asset: Asset, tags: AiSuggestedTag[], referenceCount: number, hasOcr: boolean): string {
	const parts = [
		`${asset.ext.toUpperCase()} 图片`,
		typeof asset.width === "number" && typeof asset.height === "number" ? `${asset.width} x ${asset.height}` : "",
		referenceCount > 0 ? `${referenceCount} 处引用` : "暂无引用",
		hasOcr ? "包含识别文本" : "",
		tags.length > 0 ? `建议标签：${tags.slice(0, 5).map((tag) => tag.value).join("、")}` : "",
	].filter(Boolean);
	return parts.join("；") + "。";
}

function clampConfidence(value: number): number {
	return Math.min(0.99, Math.max(0.35, Math.round(value * 100) / 100));
}

function formatDateTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}
