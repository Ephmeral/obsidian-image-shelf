import type {Asset} from "../types/asset";
import type {OcrBlock, OcrProvider, OcrResult} from "../types/ocr";
import type {AssetRepository} from "./asset-repository";
import type {JobQueueService} from "./task-queue";

const OCR_SECTION_HEADING = "## OCR";

export class OcrService {
	private readonly repository: AssetRepository;
	private readonly jobQueue: JobQueueService;

	constructor(repository: AssetRepository, jobQueue: JobQueueService) {
		this.repository = repository;
		this.jobQueue = jobQueue;
	}

	getResult(assetId: string | null | undefined): OcrResult | undefined {
		return this.repository.getOcrResult(assetId);
	}

	async saveLocalText(asset: Asset, text: string, language?: string): Promise<OcrResult> {
		const normalizedText = normalizeOcrText(text);
		const jobId = this.jobQueue.startJob({
			type: "ocr",
			assetId: asset.id,
			label: "保存识别文本",
			total: 1,
			priority: "normal",
			details: "写入本地文本识别结果索引。",
		});
		try {
			const now = Date.now();
			const previous = this.repository.getOcrResult(asset.id);
			const result: OcrResult = {
				assetId: asset.id,
				text: normalizedText,
				blocks: createApproximateBlocks(normalizedText),
				language: normalizeLanguage(language),
				provider: "local",
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
			};
			await this.repository.upsertOcrResult(result);
			this.jobQueue.completeJob(jobId, "识别文本已保存。");
			return result;
		} catch (error) {
			this.jobQueue.failJob(jobId, error);
			throw error;
		}
	}

	async deleteResult(assetId: string): Promise<void> {
		const jobId = this.jobQueue.startJob({
			type: "ocr",
			assetId,
			label: "删除识别文本",
			total: 1,
			priority: "normal",
			details: "移除本地文本识别结果索引。",
		});
		try {
			await this.repository.deleteOcrResult(assetId);
			this.jobQueue.completeJob(jobId, "识别文本已删除。");
		} catch (error) {
			this.jobQueue.failJob(jobId, error);
			throw error;
		}
	}

	formatAssetNoteSection(result: OcrResult): string {
		const confidence = getOcrAverageConfidence(result);
		const lines = [
			OCR_SECTION_HEADING,
			"",
			`识别时间：${formatOcrDateTime(result.updatedAt ?? result.createdAt)}  `,
			`识别来源：${getProviderLabel(result.provider)}  `,
			`置信度：${confidence}%`,
		];
		if (result.language) {
			lines.push(`语言：${result.language}`);
		}
		lines.push("", "```text", result.text.trim(), "```", "");
		return lines.join("\n");
	}

	mergeAssetNoteContent(content: string, result: OcrResult): string {
		const section = this.formatAssetNoteSection(result).trimEnd();
		const normalized = content.trimEnd();
		if (!normalized) {
			return `${section}\n`;
		}

		const lines = normalized.split(/\r?\n/);
		const start = lines.findIndex((line) => line.trim() === OCR_SECTION_HEADING);
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

		const nextLines = [
			...lines.slice(0, start),
			...section.split("\n"),
			...lines.slice(end),
		];
		return `${nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
	}
}

export function getOcrAverageConfidence(result: OcrResult): number {
	if (result.blocks.length === 0) {
		return result.text.trim() ? 100 : 0;
	}
	const total = result.blocks.reduce((sum, block) => sum + block.confidence, 0);
	return Math.round((total / result.blocks.length) * 100);
}

export function getProviderLabel(provider: OcrProvider): string {
	if (provider === "system") {
		return "system";
	}
	if (provider === "cloud") {
		return "cloud";
	}
	return "local";
}

function createApproximateBlocks(text: string): OcrBlock[] {
	const paragraphs = text
		.split(/\n+/)
		.map((line) => line.trim())
		.filter(Boolean);
	const total = Math.max(1, paragraphs.length);
	const blockHeight = Math.min(0.14, 0.84 / total);
	return paragraphs.map((paragraph, index) => ({
		text: paragraph,
		confidence: 1,
		rect: {
			x: 0.08,
			y: Math.min(0.9, 0.08 + index * blockHeight),
			width: 0.84,
			height: Math.max(0.04, blockHeight * 0.72),
		},
	}));
}

function normalizeOcrText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function normalizeLanguage(language: string | undefined): string | undefined {
	const normalized = language?.trim();
	if (!normalized || normalized === "auto") {
		return undefined;
	}
	return normalized;
}

function formatOcrDateTime(timestamp: number): string {
	const date = new Date(timestamp);
	const year = date.getFullYear();
	const month = pad2(date.getMonth() + 1);
	const day = pad2(date.getDate());
	const hour = pad2(date.getHours());
	const minute = pad2(date.getMinutes());
	return `${year}/${month}/${day} ${hour}:${minute}`;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}
