import {ItemView, Notice, TFile, WorkspaceLeaf} from "obsidian";
import {MEDIA_VAULT_RECOMMENDATIONS_VIEW_TYPE} from "../constants";
import type MediaVaultPlugin from "../main";
import type {Asset} from "../types/asset";
import type {Recommendation, RecommendationContext, RecommendationReason} from "../services/recommendation-service";
import {buildRecommendationContext} from "../services/recommendation-context";
import {formatFileSize} from "../utils/image-utils";

export class MediaVaultRecommendationsView extends ItemView {
	private readonly plugin: MediaVaultPlugin;
	private unsubscribeRepository: (() => void) | null = null;
	private renderToken = 0;

	constructor(leaf: WorkspaceLeaf, plugin: MediaVaultPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return MEDIA_VAULT_RECOMMENDATIONS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "推荐图片";
	}

	getIcon(): string {
		return "sparkles";
	}

	async onOpen(): Promise<void> {
		this.unsubscribeRepository = this.plugin.services.assetRepository.subscribe(() => {
			void this.render();
		});
		this.registerEvent(this.app.workspace.on("file-open", () => void this.render()));
		await this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribeRepository?.();
		this.unsubscribeRepository = null;
	}

	private async render(): Promise<void> {
		const token = this.renderToken + 1;
		this.renderToken = token;
		const root = this.contentEl;
		root.empty();
		root.addClass("media-vault-recommendations-root");
		root.createDiv({cls: "media-vault-section-title", text: "推荐图片"});

		const note = this.plugin.getActiveMarkdownFile();
		if (!note) {
			root.createDiv({cls: "media-vault-hint", text: "打开 Markdown 笔记后显示推荐图片。"});
			return;
		}

		root.createDiv({cls: "media-vault-recommendations-note", text: note.path});
		root.createDiv({cls: "media-vault-hint", text: "基于当前笔记标题、正文、标签、同目录和已引用图片生成。"});
		root.createDiv({cls: "media-vault-recommendations-loading", text: "正在计算推荐…"});
		const context = await this.buildContext(note);
		if (this.renderToken !== token) {
			return;
		}
		const dismissedAssetIds = await this.plugin.services.recommendationPreferenceService.getDismissedAssetIds(note.path);
		if (this.renderToken !== token) {
			return;
		}

		const recommendations = this.plugin.services.recommendationService
			.recommendForNote(
				context,
					this.plugin.services.assetRepository.getActiveAssets(),
					this.plugin.services.assetRepository.getReferences(),
					this.plugin.services.assetRepository.getCollections(),
					{
						ocrResults: this.plugin.services.assetRepository.getOcrResults(),
						aiSuggestions: this.plugin.services.assetRepository.getAiSuggestions(),
					},
				)
			.filter((recommendation) => !dismissedAssetIds.has(recommendation.assetId));
		this.renderRecommendations(root, context, recommendations, dismissedAssetIds.size);
	}

	private renderRecommendations(root: HTMLElement, context: RecommendationContext, recommendations: Recommendation[], dismissedCount: number): void {
		const loading = root.querySelector(".media-vault-recommendations-loading");
		loading?.remove();
		const summary = root.createDiv({cls: "media-vault-recommendations-summary"});
		summary.createSpan({text: `${recommendations.length} 个推荐`});
		const refresh = summary.createEl("button", {text: "刷新"});
		refresh.addEventListener("click", () => {
			void this.render();
		});
		if (dismissedCount > 0) {
			const restore = summary.createEl("button", {text: `恢复隐藏 ${dismissedCount}`});
			restore.addEventListener("click", () => {
				void (async () => {
					const restored = await this.plugin.services.recommendationPreferenceService.restoreForNote(context.notePath);
					new Notice(`已恢复 ${restored} 个推荐`);
					await this.render();
				})();
			});
		}

		if (recommendations.length === 0) {
			root.createDiv({cls: "media-vault-hint", text: "暂无推荐。可给当前笔记添加标签，或先在图库中为图片添加 tags/collections。"});
			return;
		}

		const list = root.createDiv({cls: "media-vault-recommendations-list"});
		for (const recommendation of recommendations.slice(0, 12)) {
			const asset = this.plugin.services.assetRepository.getAssetById(recommendation.assetId);
			if (!asset) {
				continue;
			}
			this.renderRecommendationCard(list, context, asset, recommendation);
		}

		const more = root.createEl("button", {cls: "media-vault-recommendations-more", text: "查看更多推荐"});
		more.addEventListener("click", () => {
			void this.plugin.showCurrentFolderCollection();
		});
	}

	private renderRecommendationCard(parent: HTMLElement, context: RecommendationContext, asset: Asset, recommendation: Recommendation): void {
		const card = parent.createDiv({cls: "media-vault-recommendation-card"});
		const top = card.createDiv({cls: "media-vault-recommendation-top"});
		const preview = top.createEl("button", {cls: "media-vault-recommendation-preview"});
		const resourcePath = this.plugin.services.thumbnailService.getResourcePath(asset);
		if (resourcePath) {
			preview.createEl("img", {attr: {src: resourcePath, alt: asset.filename, loading: "lazy", decoding: "async"}});
		}
		preview.addEventListener("click", () => {
			void this.plugin.openAssetDetailInGallery(asset.id);
		});
		const body = top.createDiv({cls: "media-vault-recommendation-body"});
		body.createDiv({cls: "media-vault-recommendation-title", text: asset.filename});
		body.createDiv({cls: "media-vault-recommendation-meta", text: `${formatFileSize(asset.sizeBytes)} · ${asset.referenceCount} 引用 · 分数 ${recommendation.score}`});
			const reasons = body.createDiv({cls: "media-vault-recommendation-reasons"});
			for (const reason of recommendation.reasons) {
				this.renderReasonChip(reasons, asset, reason);
			}

		const actions = card.createDiv({cls: "media-vault-recommendation-actions"});
		const insert = actions.createEl("button", {cls: "mod-cta", text: "插入到光标位置"});
		insert.addEventListener("click", () => {
			void this.plugin.insertAsset(asset);
		});
		const detail = actions.createEl("button", {text: "详情"});
		detail.addEventListener("click", () => {
			void this.plugin.openAssetDetailInGallery(asset.id);
		});
		const dismiss = actions.createEl("button", {text: "不再推荐"});
		dismiss.addEventListener("click", () => {
			void (async () => {
				await this.plugin.services.recommendationPreferenceService.dismiss(context.notePath, asset.id);
				new Notice(`已隐藏推荐：${asset.filename}`);
				await this.render();
			})();
		});

		if (context.referencedAssetIds.size > 0 && asset.tags.length > 0) {
			card.createDiv({cls: "media-vault-recommendation-foot", text: `可补充当前笔记素材线索：${asset.tags.slice(0, 3).map((tag) => `#${tag}`).join(" ")}`});
		}
	}

	private renderReasonChip(parent: HTMLElement, asset: Asset, reason: RecommendationReason): void {
		const chip = parent.createEl("button", {cls: "media-vault-recommendation-reason", text: `${reason.label}: ${reason.detail}`});
		chip.addEventListener("click", () => {
			if (reason.type === "tag" && reason.value) {
				this.plugin.setNavQuery({tags: [reason.value]});
			} else if (reason.type === "collection" && reason.value) {
				this.plugin.setNavQuery({collections: [reason.value]});
			} else if (reason.type === "folder" && reason.value) {
				this.plugin.setNavQuery({linkedByFolder: reason.value});
			} else if (reason.type === "ocr") {
				void this.plugin.openAssetDetailInGallery(asset.id, "ocr");
			} else if (reason.type === "ai") {
				void this.plugin.openAiSuggestionsForAsset(asset);
			} else if (reason.type === "text" && reason.value) {
				this.plugin.setNavQuery({keyword: reason.value});
			}
		});
	}

	private async buildContext(note: TFile): Promise<RecommendationContext> {
		return buildRecommendationContext(this.app, this.plugin.services.assetRepository, note);
	}
}
