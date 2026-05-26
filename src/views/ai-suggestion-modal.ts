import {Modal, Notice} from "obsidian";
import type MediaVaultPlugin from "../main";
import type {Asset} from "../types/asset";
import type {AIMetadataSuggestion, AiSuggestionWriteTarget} from "../types/ai";

export class AiSuggestionModal extends Modal {
	private readonly plugin: MediaVaultPlugin;
	private readonly asset: Asset;
	private readonly suggestion: AIMetadataSuggestion | null;
	private readonly selectedTags = new Set<string>();
	private writeTarget: AiSuggestionWriteTarget = "index";

	constructor(plugin: MediaVaultPlugin, asset: Asset, suggestion: AIMetadataSuggestion | null) {
		super(plugin.app);
		this.plugin = plugin;
		this.asset = asset;
		this.suggestion = suggestion;
		for (const tag of suggestion?.tags ?? []) {
			this.selectedTags.add(tag.value);
		}
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass("media-vault-ai-modal");
		this.titleEl.setText("AI 标签建议");

		this.renderPrivacy();
		if (!this.suggestion) {
			this.renderDisabledState();
			return;
		}
		this.renderSuggestion(this.suggestion);
	}

	private renderPrivacy(): void {
		const card = this.contentEl.createDiv({cls: "media-vault-ai-privacy"});
		card.createDiv({cls: "media-vault-section-title", text: "隐私说明"});
		for (const item of [
			"当前 provider：local。",
			"不会上传原图、缩略图或识别文本。",
			"建议只会在点击应用后写入插件索引或素材笔记。",
			"云端上传设置当前固定关闭。",
		]) {
			card.createDiv({text: item});
		}
	}

	private renderDisabledState(): void {
		const empty = this.contentEl.createDiv({cls: "media-vault-ai-disabled"});
		empty.createDiv({cls: "media-vault-empty-title", text: "本地 AI 标签建议未开启"});
		empty.createDiv({text: "开启后会基于文件名、路径、已保存识别文本和引用上下文生成本地建议。"});
		const actions = empty.createDiv({cls: "media-vault-detail-actions"});
		const enable = actions.createEl("button", {cls: "mod-cta", text: "启用并生成建议"});
		enable.addEventListener("click", () => {
			void this.enableAndGenerate();
		});
		const cancel = actions.createEl("button", {text: "取消"});
		cancel.addEventListener("click", () => this.close());
	}

	private renderSuggestion(suggestion: AIMetadataSuggestion): void {
		const summary = this.contentEl.createDiv({cls: "media-vault-ai-summary"});
		this.renderSummaryItem(summary, "标题", suggestion.title ?? "未生成");
		this.renderSummaryItem(summary, "Provider", suggestion.provider);
		this.renderSummaryItem(summary, "依据", suggestion.basedOn.join("、") || "local");

		if (suggestion.description) {
			const description = this.contentEl.createDiv({cls: "media-vault-ai-description"});
			description.createDiv({cls: "media-vault-section-title", text: "描述建议"});
			description.createDiv({text: suggestion.description});
			const copy = description.createEl("button", {text: "复制描述"});
			copy.addEventListener("click", () => void navigator.clipboard.writeText(suggestion.description ?? ""));
		}

		this.renderTags(suggestion);
		this.renderWriteOptions();
		this.renderActions(suggestion);
	}

	private renderSummaryItem(parent: Element, label: string, value: string): void {
		const item = parent.createDiv({cls: "media-vault-ai-summary-item"});
		item.createSpan({text: label});
		item.createDiv({text: value});
	}

	private renderTags(suggestion: AIMetadataSuggestion): void {
		const section = this.contentEl.createDiv({cls: "media-vault-ai-tags"});
		section.createDiv({cls: "media-vault-section-title", text: "标签建议"});
		const chips = section.createDiv({cls: "media-vault-ai-tag-list"});
		const suggestionTagValues = new Set(suggestion.tags.map((tag) => tag.value));
		const tagItems = [
			...suggestion.tags,
			...Array.from(this.selectedTags)
				.filter((value) => !suggestionTagValues.has(value))
				.map((value) => ({value, confidence: 1})),
		];
		for (const tag of tagItems) {
			const active = this.selectedTags.has(tag.value);
			const chip = chips.createEl("button", {cls: `media-vault-ai-tag ${active ? "is-active" : ""}`});
			chip.createSpan({text: `#${tag.value}`});
			chip.createSpan({text: `${Math.round(tag.confidence * 100)}%`});
			chip.addEventListener("click", () => {
				if (active) {
					this.selectedTags.delete(tag.value);
				} else {
					this.selectedTags.add(tag.value);
				}
				this.render();
			});
		}

		const custom = section.createDiv({cls: "media-vault-ai-custom-tag"});
		const input = custom.createEl("input", {attr: {type: "text", placeholder: "添加自定义标签"}});
		const add = custom.createEl("button", {text: "添加"});
		add.addEventListener("click", () => {
			const value = input.value.trim().replace(/^#+/, "");
			if (!value) {
				return;
			}
			this.selectedTags.add(value);
			this.render();
		});
	}

	private renderWriteOptions(): void {
		const section = this.contentEl.createDiv({cls: "media-vault-ai-write-options"});
		section.createDiv({cls: "media-vault-section-title", text: "应用范围"});
		for (const option of [
			{id: "index" as const, label: "只存插件索引", detail: "更新图库标签，不修改 Markdown 文件。"},
			{id: "asset-note" as const, label: "写入素材笔记", detail: "更新素材笔记 frontmatter，并写入 AI 建议摘要。"},
		]) {
			const button = section.createEl("button", {cls: this.writeTarget === option.id ? "is-active" : ""});
			button.createSpan({text: option.label});
			button.createDiv({text: option.detail});
			button.addEventListener("click", () => {
				this.writeTarget = option.id;
				this.render();
			});
		}
	}

	private renderActions(suggestion: AIMetadataSuggestion): void {
		const actions = this.contentEl.createDiv({cls: "media-vault-detail-actions"});
		const apply = actions.createEl("button", {cls: "mod-cta", text: "应用全部"});
		apply.disabled = this.selectedTags.size === 0 && !suggestion.title && !suggestion.description;
		apply.addEventListener("click", () => {
			void this.applySuggestion(suggestion);
		});
		const copyTitle = actions.createEl("button", {text: "复制标题"});
		copyTitle.disabled = !suggestion.title;
		copyTitle.addEventListener("click", () => void navigator.clipboard.writeText(suggestion.title ?? ""));
		const cancel = actions.createEl("button", {text: "取消"});
		cancel.addEventListener("click", () => this.close());
	}

	private async enableAndGenerate(): Promise<void> {
		this.plugin.settings.enableAiTagging = true;
		await this.plugin.saveSettings();
		this.close();
		await this.plugin.openAiSuggestionsForAsset(this.asset);
	}

	private async applySuggestion(suggestion: AIMetadataSuggestion): Promise<void> {
		await this.plugin.applyAiMetadataSuggestion(this.asset, suggestion, Array.from(this.selectedTags), this.writeTarget);
		new Notice("已应用 AI 标签建议。");
		this.close();
	}
}
