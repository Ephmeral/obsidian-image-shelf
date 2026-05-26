import {App, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, Notice, TFile} from "obsidian";
import type MediaVaultPlugin from "../main";
import type {Asset} from "../types/asset";
import type {Recommendation} from "../services/recommendation-service";
import {buildRecommendationContext} from "../services/recommendation-context";
import {formatFileSize} from "../utils/image-utils";

interface InsertImageSuggestion {
	asset: Asset;
	score: number;
	reason: string;
}

const INSERT_IMAGE_TRIGGER = /(^|\s)\/insert\s+image(?:\s+([^\n]*))?$/i;
const MAX_INSERT_IMAGE_SUGGESTIONS = 8;

export class InsertImageSuggest extends EditorSuggest<InsertImageSuggestion> {
	constructor(app: App, private readonly plugin: MediaVaultPlugin) {
		super(app);
		this.limit = MAX_INSERT_IMAGE_SUGGESTIONS;
		this.setInstructions([
			{command: "Enter", purpose: "插入图片"},
			{command: "Esc", purpose: "关闭推荐"},
		]);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		if (!file || file.extension !== "md") {
			return null;
		}
		const lineBeforeCursor = editor.getLine(cursor.line).slice(0, cursor.ch);
		const match = INSERT_IMAGE_TRIGGER.exec(lineBeforeCursor);
		if (!match) {
			return null;
		}
		const matchedText = match[0];
		const commandText = matchedText.trimStart();
		const startCh = lineBeforeCursor.length - matchedText.length + (matchedText.length - commandText.length);
		return {
			start: {line: cursor.line, ch: startCh},
			end: cursor,
			query: match[2]?.trim() ?? "",
		};
	}

	async getSuggestions(context: EditorSuggestContext): Promise<InsertImageSuggestion[]> {
		const recommendationContext = await buildRecommendationContext(this.app, this.plugin.services.assetRepository, context.file, context.editor);
		const dismissedAssetIds = await this.plugin.services.recommendationPreferenceService.getDismissedAssetIds(context.file.path);
		const query = context.query.trim().toLowerCase();
		return this.plugin.services.recommendationService
			.recommendForNote(
				recommendationContext,
				this.plugin.services.assetRepository.getActiveAssets(),
				this.plugin.services.assetRepository.getReferences(),
				this.plugin.services.assetRepository.getCollections(),
				{
					ocrResults: this.plugin.services.assetRepository.getOcrResults(),
					aiSuggestions: this.plugin.services.assetRepository.getAiSuggestions(),
				},
			)
			.filter((recommendation) => !dismissedAssetIds.has(recommendation.assetId))
			.map((recommendation) => toInsertImageSuggestion(this.plugin, recommendation))
			.filter((suggestion): suggestion is InsertImageSuggestion => suggestion !== null)
			.filter((suggestion) => matchesQuery(suggestion.asset, suggestion.reason, query))
			.slice(0, MAX_INSERT_IMAGE_SUGGESTIONS);
	}

	renderSuggestion(value: InsertImageSuggestion, el: HTMLElement): void {
		el.addClass("media-vault-insert-image-suggestion");
		const preview = el.createDiv({cls: "media-vault-insert-image-suggestion-preview"});
		const resourcePath = this.plugin.services.thumbnailService.getResourcePath(value.asset);
		if (resourcePath) {
			preview.createEl("img", {attr: {src: resourcePath, alt: value.asset.filename, loading: "lazy", decoding: "async"}});
		}
		const body = el.createDiv({cls: "media-vault-insert-image-suggestion-body"});
		body.createDiv({cls: "media-vault-insert-image-suggestion-title", text: value.asset.filename});
		body.createDiv({
			cls: "media-vault-insert-image-suggestion-meta",
			text: `${value.asset.ext.toUpperCase()} · ${formatFileSize(value.asset.sizeBytes)} · 分数 ${value.score}`,
		});
		body.createDiv({cls: "media-vault-insert-image-suggestion-reason", text: value.reason});
	}

	selectSuggestion(value: InsertImageSuggestion): void {
		const context = this.context;
		if (!context) {
			return;
		}
		void this.insertSuggestion(value, context);
	}

	private async insertSuggestion(value: InsertImageSuggestion, context: EditorSuggestContext): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(value.asset.filePath);
		if (!(file instanceof TFile)) {
			new Notice("图片文件不存在，建议重建索引。");
			return;
		}
		const link = this.app.fileManager.generateMarkdownLink(file, context.file.path);
		const embedLink = link.startsWith("!") ? link : `!${link}`;
		context.editor.replaceRange(embedLink, context.start, context.end);
		context.editor.setCursor({line: context.start.line, ch: context.start.ch + embedLink.length});
		this.plugin.setFocusedAsset(value.asset.id);
		await this.plugin.services.linkGraphService.rebuildReferences();
		new Notice("已插入推荐图片。");
		this.close();
	}
}

function toInsertImageSuggestion(plugin: MediaVaultPlugin, recommendation: Recommendation): InsertImageSuggestion | null {
	const asset = plugin.services.assetRepository.getAssetById(recommendation.assetId);
	if (!asset) {
		return null;
	}
	return {
		asset,
		score: recommendation.score,
		reason: recommendation.reasons.map((reason) => `${reason.label}: ${reason.detail}`).join("；"),
	};
}

function matchesQuery(asset: Asset, reason: string, query: string): boolean {
	if (!query) {
		return true;
	}
	const haystack = `${asset.filename} ${asset.filePath} ${asset.tags.join(" ")} ${asset.collections.join(" ")} ${reason}`.toLowerCase();
	return query.split(/\s+/).every((token) => haystack.includes(token));
}
