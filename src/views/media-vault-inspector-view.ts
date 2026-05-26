import {ItemView, MarkdownRenderer, MarkdownView, Notice, stripHeadingForLink, WorkspaceLeaf} from "obsidian";
import {MEDIA_VAULT_INSPECTOR_VIEW_TYPE} from "../constants";
import type MediaVaultPlugin from "../main";
import type {MediaVaultDetailPanelId} from "../main";
import {DEFAULT_ANNOTATION_COLOR, type Annotation, type AnnotationStorageMode, type Asset, type AssetReference, type Collection} from "../types/asset";
import type {MediaVaultGallerySortOption, MediaVaultGalleryViewMode} from "../types/gallery";
import type {AssetQuery, QuickFilterId} from "../types/query";
import type {OcrRect, OcrResult} from "../types/ocr";
import {formatDateTime, formatFileSize} from "../utils/image-utils";
import {getDuplicateCandidates} from "../services/search-service";
import {getOcrAverageConfidence, getProviderLabel} from "../services/ocr-service";
import {getParentPath} from "../utils/path-utils";
import {formatReferenceLocation} from "../utils/reference-utils";
import {parseAssetNoteMetadata} from "../utils/asset-note-metadata";

interface MatchReason {
	label: string;
	detail: string;
}

interface GraphNodeData {
	label: string;
	detail?: string;
	onClick?: () => void;
}

interface AnnotationLinkStatus {
	state: "none" | "ok" | "missing-note" | "missing-heading" | "missing-block";
	label: string;
	linkText: string | null;
	targetPath?: string;
}

interface ParsedAnnotationLinkTarget {
	path: string;
	heading?: string;
	blockId?: string;
}

type EditableListField = "tags" | "collections";

const DETAIL_INSPECTOR_PANELS: Array<{id: MediaVaultDetailPanelId; label: string}> = [
	{id: "overview", label: "详情"},
	{id: "asset-note", label: "Asset Note"},
	{id: "references", label: "引用"},
	{id: "annotations", label: "标注"},
	{id: "ocr", label: "OCR"},
	{id: "versions", label: "版本"},
	{id: "metadata", label: "元数据"},
];

interface InlineListEditorState {
	assetId: string;
	field: EditableListField;
}

export class MediaVaultInspectorView extends ItemView {
	private readonly plugin: MediaVaultPlugin;
	private unsubscribeRepository: (() => void) | null = null;
	private unsubscribeUiState: (() => void) | null = null;
	private assetNoteAssetId: string | null = null;
	private assetNoteContent = "";
	private assetNoteSavedContent = "";
	private assetNoteViewMode: "edit" | "preview" = "edit";
	private ocrDraftAssetId: string | null = null;
	private ocrDraftText = "";
	private ocrDraftLanguage = "auto";
	private selectedOcrBlockIndex: number | null = null;
	private editingFilenameAssetId: string | null = null;
	private filenameDraft = "";
	private inlineListEditor: InlineListEditorState | null = null;
	private inlineListDraft = "";

	constructor(leaf: WorkspaceLeaf, plugin: MediaVaultPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return MEDIA_VAULT_INSPECTOR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Image inspector";
	}

	getIcon(): string {
		return "image";
	}

	async onOpen(): Promise<void> {
		this.unsubscribeRepository = this.plugin.services.assetRepository.subscribe(() => this.render());
		this.unsubscribeUiState = this.plugin.subscribeUiState(() => this.render());
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribeRepository?.();
		this.unsubscribeRepository = null;
		this.unsubscribeUiState?.();
		this.unsubscribeUiState = null;
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("media-vault-inspector-root");

		const detailAsset = this.plugin.getDetailAsset();
		if (!detailAsset) {
			const activeSmartCollection = this.getActiveSmartCollection();
			if (activeSmartCollection) {
				this.renderSmartCollectionPanel(root, activeSmartCollection);
			}
		}

		const asset = detailAsset ?? this.plugin.getFocusedAsset();
		if (!asset) {
			root.createDiv({cls: "media-vault-section-title", text: "Inspector"});
			root.createDiv({cls: "media-vault-hint", text: "选择一张图片查看元数据和引用。"});
			return;
		}

		if (detailAsset) {
			this.renderDetailAsset(root, detailAsset);
		} else {
			this.renderAsset(root, asset);
		}
	}

	private renderSmartCollectionPanel(root: HTMLElement, collection: Collection): void {
		const query = this.plugin.getActiveGalleryQuery();
		const savedQuery = collection.query as AssetQuery;
		const resultCount = this.plugin.services.searchService.filterAssets(
			this.plugin.services.assetRepository.getAssets().filter((asset) => asset.status === "active"),
			"all",
			query,
		).length;
		const queryText = formatQueryExpression(query);
		const dirty = getQueryExpressionKey(query) !== getQueryExpressionKey(savedQuery);

		const panel = root.createDiv({cls: `media-vault-collection-inspector ${dirty ? "is-dirty" : ""}`});
		const head = panel.createDiv({cls: "media-vault-collection-inspector-head"});
		head.createEl("b", {text: "Collection 说明"});
		head.createSpan({text: `${resultCount} 张`});

		const body = panel.createDiv({cls: "media-vault-collection-inspector-body"});
		const dynamic = body.createDiv({cls: "media-vault-collection-inspector-item"});
		dynamic.createDiv({cls: "media-vault-collection-inspector-title", text: "动态规则"});
		dynamic.createDiv({
			cls: "media-vault-collection-inspector-desc",
			text: dirty
				? "当前结果包含未保存的筛选调整，可在主图区保存当前视图。"
				: "当图片标签、评分、引用笔记、格式或颜色变化时，此集合自动更新。",
		});

		const queryField = body.createDiv({cls: "media-vault-collection-inspector-field"});
		queryField.createDiv({cls: "media-vault-collection-inspector-label", text: "查询语句"});
		queryField.createDiv({cls: "media-vault-collection-inspector-query", text: queryText || "全部图片"});

		const sortField = body.createDiv({cls: "media-vault-collection-inspector-field"});
		sortField.createDiv({cls: "media-vault-collection-inspector-label", text: "排序 / 视图"});
		sortField.createDiv({
			cls: "media-vault-collection-inspector-input",
			text: `${getSortLabel(this.plugin.getActiveGallerySortOption())} · ${getViewModeLabel(this.plugin.getActiveGalleryViewMode())}`,
		});

		const insert = body.createEl("button", {cls: "mod-cta", text: "插入为 gallery block"});
		insert.addEventListener("click", () => {
			void this.insertSmartCollectionGalleryBlock(collection, query);
		});
	}

	private getActiveSmartCollection(): Collection | null {
		const collectionId = this.plugin.getActiveCollectionId();
		if (!collectionId) {
			return null;
		}

		const collection = this.plugin.services.assetRepository.getCollectionById(collectionId);
		return collection?.type === "smart" ? collection : null;
	}

	private async insertSmartCollectionGalleryBlock(collection: Collection, query: AssetQuery): Promise<void> {
		const block = buildGalleryBlock(
			collection,
			query,
			this.plugin.getActiveGallerySortOption(),
			this.plugin.getActiveGalleryViewMode(),
		);
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (markdownView?.file) {
			markdownView.editor.replaceSelection(block);
			new Notice("已插入 gallery block。");
			return;
		}

		try {
			await navigator.clipboard.writeText(block);
			new Notice("当前没有聚焦 Markdown 编辑器，已复制 gallery block。");
		} catch {
			new Notice("当前没有聚焦 Markdown 编辑器，且剪贴板不可用。");
		}
	}

	private renderDetailAsset(root: HTMLElement, asset: Asset): void {
		const duplicateCandidates = getDuplicateCandidates(asset, this.plugin.services.assetRepository.getAssets());
		this.renderInspectorHeader(root, asset);
		this.renderInspectorPreview(root, asset);
		this.renderInspectorFileMeta(root, asset, duplicateCandidates);
		this.renderColorPalette(root, asset);
		this.renderInspectorActions(root, asset, duplicateCandidates, true);
		const panelId = this.plugin.getDetailPanel();
		this.renderDetailPanelTabs(root, panelId);
		this.renderDetailPanel(root, asset, panelId);
	}

	private renderDetailPanelTabs(root: HTMLElement, activePanelId: MediaVaultDetailPanelId): void {
		const tabs = root.createDiv({cls: "media-vault-inspector-panel-tabs"});
		for (const panel of DETAIL_INSPECTOR_PANELS) {
			const button = tabs.createEl("button", {cls: activePanelId === panel.id ? "is-active" : "", text: panel.label});
			button.addEventListener("click", () => {
				if (activePanelId === panel.id) {
					return;
				}
				this.plugin.setDetailPanel(panel.id);
			});
		}
	}

	private renderDetailPanel(root: HTMLElement, asset: Asset, panelId: MediaVaultDetailPanelId): void {
		root.createDiv({cls: "media-vault-inspector-section-label", text: getDetailPanelLabel(panelId)});
		if (panelId === "asset-note") {
			this.renderAssetNotePanel(root, asset);
			return;
		}

		const references = this.plugin.services.assetRepository.getReferencesForAsset(asset.id);
		const annotations = this.plugin.services.assetRepository.getAnnotationsForAsset(asset.id);
		if (panelId === "references") {
			this.renderReferenceList(root, references);
			return;
		}
		if (panelId === "annotations") {
			const create = root.createEl("button", {cls: "mod-cta media-vault-inspector-panel-action", text: "新建区域标注"});
			create.addEventListener("click", () => {
				void this.plugin.openAssetDetailInGallery(asset.id, "annotation");
			});
			this.renderAnnotationList(root, asset, annotations);
			return;
		}
		if (panelId === "versions") {
			this.renderVersionsPanel(root, asset);
			return;
		}
		if (panelId === "ocr") {
			this.renderOcrPanel(root, asset);
			return;
		}
		if (panelId === "metadata") {
			this.renderMetadataPanel(root, asset);
			return;
		}

		this.renderOverviewPanel(root, asset, references, annotations);
	}

	private renderOverviewPanel(root: HTMLElement, asset: Asset, references: AssetReference[], annotations: Annotation[]): void {
		const summary = root.createDiv({cls: "media-vault-asset-note-summary media-vault-inspector-summary"});
		this.renderSummaryItem(summary, "尺寸", formatDimensions(asset));
		this.renderSummaryItem(summary, "大小", formatFileSize(asset.sizeBytes));
		this.renderSummaryItem(summary, "引用", `${references.length} 处`);
		this.renderSummaryItem(summary, "标注", `${annotations.length} 个`);
		this.renderSummaryItem(summary, "标签", asset.tags.length > 0 ? asset.tags.map((tag) => `#${tag}`).join("、") : "无");
		this.renderSummaryItem(summary, "Collections", asset.collections.length > 0 ? asset.collections.join("、") : "无");
		this.renderDetailGraph(root, asset, references, annotations);
	}

	private renderAssetNotePanel(root: HTMLElement, asset: Asset): void {
		this.loadAssetNote(asset);
		const shell = root.createDiv({cls: "media-vault-asset-note-panel media-vault-inspector-asset-note-panel"});
		const head = shell.createDiv({cls: "media-vault-asset-note-head"});
		const title = head.createDiv();
		title.createDiv({cls: "media-vault-hint", text: "frontmatter 会同步到图库、Inspector 和区域标注。"});
		const mode = head.createDiv({cls: "media-vault-asset-note-mode"});
		for (const option of [
			{id: "edit" as const, label: "编辑"},
			{id: "preview" as const, label: "预览"},
		]) {
			const button = mode.createEl("button", {cls: this.assetNoteViewMode === option.id ? "is-active" : "", text: option.label});
			button.addEventListener("click", () => {
				this.assetNoteViewMode = option.id;
				this.render();
			});
		}

		if (this.assetNoteContent === "正在加载素材笔记…") {
			shell.createDiv({cls: "media-vault-hint", text: this.assetNoteContent});
		} else if (this.assetNoteViewMode === "preview") {
			this.renderAssetNotePreview(shell, asset);
		} else {
			const textarea = shell.createEl("textarea", {
				cls: "media-vault-asset-note-editor media-vault-inspector-asset-note-editor",
				attr: {value: this.assetNoteContent},
			});
			textarea.value = this.assetNoteContent;
			textarea.addEventListener("input", () => {
				this.assetNoteContent = textarea.value;
			});
		}

		const actions = root.createDiv({cls: "media-vault-inspector-actions"});
		const save = actions.createEl("button", {cls: "mod-cta", text: asset.notePath ? "保存素材笔记" : "创建素材笔记"});
		save.disabled = this.assetNoteContent === "正在加载素材笔记…" || (Boolean(asset.notePath) && this.assetNoteContent === this.assetNoteSavedContent);
		save.addEventListener("click", () => {
			void this.saveAssetNoteFromInspector(asset);
		});
		if (asset.notePath) {
			const open = actions.createEl("button", {text: "打开素材笔记"});
			open.addEventListener("click", () => {
				void this.plugin.openReference(asset.notePath as string);
			});
		}
	}

	private loadAssetNote(asset: Asset): void {
		if (this.assetNoteAssetId === asset.id) {
			return;
		}

		this.assetNoteAssetId = asset.id;
		this.assetNoteContent = "正在加载素材笔记…";
		this.assetNoteSavedContent = "";
		void this.plugin.readAssetNote(asset).then((content) => {
			if (this.assetNoteAssetId !== asset.id) {
				return;
			}

			this.assetNoteContent = content;
			this.assetNoteSavedContent = content;
			this.render();
		});
	}

	private renderAssetNotePreview(parent: HTMLElement, asset: Asset): void {
		const metadata = parseAssetNoteMetadata(this.assetNoteContent);
		const summary = parent.createDiv({cls: "media-vault-asset-note-summary media-vault-inspector-summary"});
		this.renderSummaryItem(summary, "类型", metadata.isAssetNote ? "asset" : "未识别");
		this.renderSummaryItem(summary, "图片", metadata.filePath ?? asset.filePath);
		this.renderSummaryItem(summary, "标签", metadata.tags?.join("、") || asset.tags.join("、") || "无");
		this.renderSummaryItem(summary, "Collections", metadata.collections?.join("、") || asset.collections.join("、") || "无");
		const preview = parent.createDiv({cls: "media-vault-asset-note-preview"});
		void MarkdownRenderer.render(this.app, this.assetNoteContent || "暂无 Asset Note 内容。", preview, asset.notePath ?? asset.filePath, this);
	}

	private async saveAssetNoteFromInspector(asset: Asset): Promise<void> {
		const content = this.assetNoteContent;
		await this.plugin.saveAssetNote(asset, content);
		if (this.assetNoteAssetId !== asset.id) {
			return;
		}

		this.assetNoteSavedContent = content;
		this.render();
	}

	private renderVersionsPanel(root: HTMLElement, asset: Asset): void {
		const list = root.createDiv({cls: "media-vault-version-list"});
		this.renderVersionRow(list, {
			label: "原图",
			value: asset.filename,
			meta: `${formatDimensions(asset)} · ${formatFileSize(asset.sizeBytes)} · ${asset.ext.toUpperCase()}`,
			status: asset.status,
		});
		this.renderVersionRow(list, {
			label: "缩略图 300",
			value: asset.thumbnail.thumb300 ?? "未生成",
			meta: "小卡片和列表预览",
			status: asset.thumbnail.thumb300 ? "ready" : "missing",
		});
		this.renderVersionRow(list, {
			label: "缩略图 800",
			value: asset.thumbnail.thumb800 ?? "未生成",
			meta: "Inspector 和小预览",
			status: asset.thumbnail.thumb800 ? "ready" : "missing",
		});
		for (const candidate of getDuplicateCandidates(asset, this.plugin.services.assetRepository.getAssets()).slice(0, 8)) {
			this.renderVersionRow(list, {
				label: candidate.sha256 && candidate.sha256 === asset.sha256 ? "完全重复" : "视觉相似",
				value: candidate.filename,
				meta: `${candidate.filePath} · ${formatFileSize(candidate.sizeBytes)}`,
				status: candidate.status,
			});
		}
	}

	private renderVersionRow(parent: HTMLElement, entry: {label: string; value: string; meta: string; status: string}): void {
		const row = parent.createDiv({cls: "media-vault-version-row"});
		row.createSpan({cls: "media-vault-version-label", text: entry.label});
		const body = row.createDiv({cls: "media-vault-version-body"});
		body.createDiv({cls: "media-vault-version-value", text: entry.value});
		body.createDiv({cls: "media-vault-version-meta", text: entry.meta});
		row.createSpan({cls: "media-vault-version-status", text: entry.status});
	}

	private renderMetadataPanel(root: HTMLElement, asset: Asset): void {
		this.renderMetaRow(root, "ID", asset.id);
		this.renderMetaRow(root, "SHA-256", asset.sha256 ?? "未计算");
		this.renderMetaRow(root, "感知 hash", asset.perceptualHash ?? "未计算");
		this.renderMetaRow(root, "缩略图", [asset.thumbnail.thumb300 ? "300" : null, asset.thumbnail.thumb800 ? "800" : null].filter(Boolean).join(" / ") || "未生成");
		if (typeof asset.thumbnail.updatedAt === "number") {
			this.renderMetaRow(root, "缩略图更新", formatDateTime(asset.thumbnail.updatedAt));
		}
		this.renderValueChips(root, "标签", asset.tags, "tags", asset);
		this.renderValueChips(root, "Collections", asset.collections, "collections", asset);
	}

	private renderOcrPanel(root: HTMLElement, asset: Asset): void {
		const result = this.plugin.services.ocrService.getResult(asset.id);
		this.prepareOcrDraft(asset, result);

		const panel = root.createDiv({cls: "media-vault-inspector-ocr-panel"});
		const head = panel.createDiv({cls: "media-vault-ocr-head media-vault-inspector-ocr-head"});
		const title = head.createDiv();
		title.createDiv({
			cls: "media-vault-hint",
			text: result ? "当前显示已保存的本地识别结果，可编辑后覆盖。" : "当前版本不上传图片；先支持粘贴系统或本地识别结果。",
		});
		const status = head.createDiv({cls: `media-vault-ocr-status ${result ? "is-ready" : "is-empty"}`});
		status.createDiv({text: result ? `${result.text.length} 字` : "未保存"});
		status.createDiv({text: result ? `${result.blocks.length} 块 · ${getOcrAverageConfidence(result)}%` : "local"});

		const meta = panel.createDiv({cls: "media-vault-ocr-meta media-vault-inspector-ocr-meta"});
		this.renderOcrMetaItem(meta, "来源", result ? getProviderLabel(result.provider) : "local");
		this.renderOcrMetaItem(meta, "语言", result?.language ?? this.ocrDraftLanguage);
		this.renderOcrMetaItem(meta, "更新时间", result ? formatDateTime(result.updatedAt ?? result.createdAt) : "未保存");

		const form = panel.createDiv({cls: "media-vault-ocr-form"});
		const languageField = form.createDiv({cls: "media-vault-filter-field"});
		languageField.createEl("label", {text: "语言"});
		const language = languageField.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "text",
				placeholder: "自动或语言代码",
				value: this.ocrDraftLanguage,
			},
		});
		language.value = this.ocrDraftLanguage;
		language.addEventListener("input", () => {
			this.ocrDraftLanguage = language.value.trim() || "auto";
		});

		const textField = form.createDiv({cls: "media-vault-filter-field"});
		textField.createEl("label", {text: "识别文本"});
		const textarea = textField.createEl("textarea", {
			cls: "media-vault-ocr-textarea media-vault-inspector-ocr-textarea",
			attr: {placeholder: "粘贴识别文本，保存后可复制、搜索或写入素材笔记。"},
		});
		textarea.value = this.ocrDraftText;

		const actions = panel.createDiv({cls: "media-vault-inspector-actions media-vault-ocr-actions"});
		const save = actions.createEl("button", {cls: "mod-cta", text: result ? "保存修改" : "保存识别文本"});
		save.disabled = this.ocrDraftText.trim().length === 0;
		textarea.addEventListener("input", () => {
			this.ocrDraftText = textarea.value;
			save.disabled = this.ocrDraftText.trim().length === 0;
		});
		save.addEventListener("click", () => void this.saveOcrDraft(asset));

		const copy = actions.createEl("button", {text: "复制文本"});
		copy.disabled = !result?.text.trim();
		copy.addEventListener("click", () => void this.plugin.copyAssetOcrText(asset));

		const write = actions.createEl("button", {text: "写入素材笔记"});
		write.disabled = !result?.text.trim();
		write.addEventListener("click", () => void this.plugin.writeOcrResultToAssetNote(asset));

		const clear = actions.createEl("button", {text: "清空结果"});
		clear.disabled = !result;
		clear.addEventListener("click", () => void this.deleteOcrResult(asset));

		this.renderOcrBlocks(panel, result);
	}

	private renderOcrMetaItem(parent: HTMLElement, label: string, value: string): void {
		const item = parent.createDiv({cls: "media-vault-ocr-meta-item"});
		item.createSpan({text: label});
		item.createDiv({text: value});
	}

	private renderOcrBlocks(parent: HTMLElement, result: OcrResult | undefined): void {
		parent.createDiv({cls: "media-vault-inspector-section-label", text: "文本块"});
		if (!result || result.blocks.length === 0) {
			parent.createDiv({cls: "media-vault-hint", text: "保存文本后会按段落生成可定位的识别文本块。"});
			return;
		}

		const list = parent.createDiv({cls: "media-vault-ocr-block-list"});
		for (const [index, block] of result.blocks.entries()) {
			const item = list.createEl("button", {cls: `media-vault-ocr-block ${this.selectedOcrBlockIndex === index ? "is-active" : ""}`});
			item.createDiv({cls: "media-vault-ocr-block-text", text: block.text});
			item.createDiv({
				cls: "media-vault-ocr-block-meta",
				text: `${Math.round(block.confidence * 100)}% · ${formatOcrRect(block.rect)}`,
			});
			item.addEventListener("click", () => {
				this.selectedOcrBlockIndex = index;
				this.render();
			});
		}
	}

	private prepareOcrDraft(asset: Asset, result: OcrResult | undefined): void {
		if (this.ocrDraftAssetId === asset.id) {
			return;
		}
		this.ocrDraftAssetId = asset.id;
		this.ocrDraftText = result?.text ?? "";
		this.ocrDraftLanguage = result?.language ?? "auto";
		this.selectedOcrBlockIndex = null;
	}

	private async saveOcrDraft(asset: Asset): Promise<void> {
		const text = this.ocrDraftText.trim();
		if (!text) {
			new Notice("请先填写识别文本。");
			return;
		}
		try {
			const result = await this.plugin.services.ocrService.saveLocalText(asset, text, this.ocrDraftLanguage);
			this.ocrDraftText = result.text;
			this.ocrDraftLanguage = result.language ?? "auto";
			this.selectedOcrBlockIndex = null;
			new Notice("已保存识别文本。");
			this.render();
		} catch (error) {
			new Notice(`识别文本保存失败：${getErrorMessage(error)}`);
		}
	}

	private async deleteOcrResult(asset: Asset): Promise<void> {
		try {
			await this.plugin.services.ocrService.deleteResult(asset.id);
			this.ocrDraftText = "";
			this.ocrDraftLanguage = "auto";
			this.selectedOcrBlockIndex = null;
			new Notice("已清空识别文本。");
			this.render();
		} catch (error) {
			new Notice(`识别文本清空失败：${getErrorMessage(error)}`);
		}
	}

	private renderSummaryItem(parent: HTMLElement, label: string, value: string): void {
		const item = parent.createDiv({cls: "media-vault-asset-note-summary-item"});
		item.createSpan({text: label});
		item.createDiv({text: value});
	}

	private renderAsset(root: HTMLElement, asset: Asset): void {
		const duplicateCandidates = getDuplicateCandidates(asset, this.plugin.services.assetRepository.getAssets());
		this.renderInspectorHeader(root, asset);
		this.renderInspectorPreview(root, asset);
		this.renderInspectorFileMeta(root, asset, duplicateCandidates);
		this.renderColorPalette(root, asset);
		this.renderInspectorActions(root, asset, duplicateCandidates, false);

		const references = this.plugin.services.assetRepository.getReferencesForAsset(asset.id);
		this.renderReferenceList(root, references);

		this.renderValueChips(root, "标签", asset.tags, "tags", asset);
		this.renderValueChips(root, "Collections", asset.collections, "collections", asset);
		this.renderAssetNoteSummary(root, asset);
		root.createDiv({cls: "media-vault-inspector-section-label", text: "文件信息"});
		this.renderMetaRow(root, "路径", asset.filePath);
		this.renderMetaRow(root, "创建时间", formatDateTime(asset.ctime));
		this.renderMetaRow(root, "添加时间", formatDateTime(asset.createdAt));
		this.renderMetaRow(root, "修改时间", formatDateTime(asset.mtime));
		this.renderMatchReasons(root, asset, duplicateCandidates);
	}

	private renderInspectorHeader(root: HTMLElement, asset: Asset): void {
		const title = root.createDiv({cls: "media-vault-inspector-title-row"});
		if (this.editingFilenameAssetId === asset.id) {
			const editor = title.createDiv({cls: "media-vault-inspector-title-editor"});
			const input = editor.createEl("input", {
				attr: {
					type: "text",
					value: this.filenameDraft || asset.filename,
					"aria-label": "文件名",
				},
			});
			input.value = this.filenameDraft || asset.filename;
			input.addEventListener("input", () => {
				this.filenameDraft = input.value;
			});
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					void this.confirmFilenameEdit(asset);
				}
				if (event.key === "Escape") {
					event.preventDefault();
					this.cancelFilenameEdit();
				}
			});

			const save = editor.createEl("button", {cls: "mod-cta", text: "保存"});
			save.addEventListener("click", () => void this.confirmFilenameEdit(asset));
			const cancel = editor.createEl("button", {text: "取消"});
			cancel.addEventListener("click", () => this.cancelFilenameEdit());
			input.focus();
			input.select();
		} else {
			title.createEl("h3", {text: asset.filename});
			const rename = title.createEl("button", {cls: "media-vault-inspector-icon-button", text: "✎"});
			rename.setAttr("aria-label", "重命名文件");
			rename.addEventListener("click", () => this.startFilenameEdit(asset));
		}

		const favorite = title.createEl("button", {cls: `media-vault-inspector-favorite ${asset.favorite ? "is-active" : ""}`, text: asset.favorite ? "★" : "☆"});
		favorite.setAttr("aria-label", asset.favorite ? "取消收藏" : "收藏图片");
		favorite.addEventListener("click", () => void this.plugin.toggleAssetFavorite(asset.id));
	}

	private renderInspectorPreview(root: HTMLElement, asset: Asset): void {
		const resourcePath = this.plugin.services.thumbnailService.getResourcePath(asset, "large");
		if (resourcePath) {
			root.createEl("img", {cls: "media-vault-inspector-preview", attr: {src: resourcePath, alt: asset.filename}});
		}
	}

	private renderInspectorFileMeta(root: HTMLElement, asset: Asset, duplicateCandidates: Asset[]): void {
		const fileMeta = root.createDiv({cls: "media-vault-inspector-file-meta"});
		fileMeta.createSpan({text: asset.ext.toUpperCase()});
		fileMeta.createSpan({text: formatFileSize(asset.sizeBytes)});
		fileMeta.createSpan({text: formatDimensions(asset)});
		fileMeta.createSpan({text: `${asset.referenceCount} 引用`});
		if (duplicateCandidates.length > 0) {
			const exactCount = duplicateCandidates.filter((candidate) => asset.sha256 && candidate.sha256 === asset.sha256).length;
			const similarCount = duplicateCandidates.length - exactCount;
			fileMeta.createSpan({text: formatDuplicateSummary(exactCount, similarCount)});
		}
	}

	private renderInspectorActions(root: HTMLElement, asset: Asset, duplicateCandidates: Asset[], isDetail: boolean): void {
		const actions = root.createDiv({cls: "media-vault-inspector-actions"});
		this.renderInspectorActionButton(actions, {
			label: isDetail ? "返回图库" : "详情",
			onClick: () => {
				if (isDetail) {
					this.plugin.closeAssetDetail();
				} else {
					void this.plugin.openAssetDetailInGallery(asset.id);
				}
			},
		});
		this.renderInspectorActionButton(actions, {
			label: "插入",
			onClick: () => void this.plugin.insertAsset(asset),
		});
		this.renderInspectorActionButton(actions, {
			label: "复制链接",
			onClick: () => void this.plugin.copyAssetWikiLink(asset),
		});
		this.renderInspectorActionButton(actions, {
			label: "复制路径",
			onClick: () => void this.plugin.copyAssetPath(asset),
		});
		this.renderInspectorActionButton(actions, {
			label: this.plugin.getDetailMode() === "annotation" && isDetail ? "正在标注" : "标注",
			disabled: this.plugin.getDetailMode() === "annotation" && isDetail,
			onClick: () => {
				void this.plugin.openAssetDetailInGallery(asset.id, "annotation");
			},
		});
		this.renderInspectorActionButton(actions, {
			label: "引用图",
			onClick: () => {
				void this.plugin.openAssetDetailInGallery(asset.id, "references");
			},
		});
		this.renderInspectorActionButton(actions, {
			label: this.plugin.services.ocrService.getResult(asset.id) ? "OCR" : "录入 OCR",
			onClick: () => {
				void this.plugin.openAssetDetailInGallery(asset.id, "ocr");
			},
		});
		this.renderInspectorActionButton(actions, {
			label: "AI 标签",
			onClick: () => void this.plugin.openAiSuggestionsForAsset(asset),
		});
		this.renderInspectorActionButton(actions, {
			label: "外部打开",
			onClick: () => void this.plugin.openAssetWithDefaultApp(asset),
		});
		this.renderInspectorActionButton(actions, {
			label: "定位",
			onClick: () => void this.plugin.showAssetInFileManager(asset),
		});
		this.renderInspectorActionButton(actions, {
			label: "降级",
			disabled: !this.plugin.getActiveMarkdownFile() || asset.status !== "active",
			onClick: () => void this.plugin.demoteAssetToCurrentNoteAttachment(asset),
		});
		if (duplicateCandidates.length > 0) {
			this.renderInspectorActionButton(actions, {
				label: "相似图",
				onClick: () => void this.plugin.openSimilarAssets(asset.id),
			});
		}
	}

	private renderInspectorActionButton(parent: HTMLElement, action: {label: string; disabled?: boolean; onClick: () => void}): HTMLButtonElement {
		const button = parent.createEl("button", {text: action.label});
		button.disabled = Boolean(action.disabled);
		button.addEventListener("click", action.onClick);
		return button;
	}

	private startFilenameEdit(asset: Asset): void {
		this.editingFilenameAssetId = asset.id;
		this.filenameDraft = asset.filename;
		this.inlineListEditor = null;
		this.render();
	}

	private cancelFilenameEdit(): void {
		this.editingFilenameAssetId = null;
		this.filenameDraft = "";
		this.render();
	}

	private async confirmFilenameEdit(asset: Asset): Promise<void> {
		const filename = this.filenameDraft.trim();
		if (!filename || filename === asset.filename) {
			this.cancelFilenameEdit();
			return;
		}

		const result = await this.plugin.renameAsset(asset.id, filename, true);
		if (result.errors.length > 0) {
			new Notice(`重命名失败：${result.errors.join("；")}`);
			return;
		}

		this.editingFilenameAssetId = null;
		this.filenameDraft = "";
		const logSuffix = result.operationLogPath ? `，事务日志 ${result.operationLogPath}` : "";
		new Notice(`已重命名图片，改写 ${result.updatedNotes} 篇笔记${logSuffix}。`);
		this.render();
	}

	private renderAssetNoteSummary(root: HTMLElement, asset: Asset): void {
		root.createDiv({cls: "media-vault-inspector-section-label", text: "素材笔记"});
		const card = root.createDiv({cls: "media-vault-inspector-note-card"});
		if (asset.notePath) {
			card.createDiv({cls: "media-vault-inspector-note-title", text: getPathBasename(asset.notePath)});
			card.createDiv({cls: "media-vault-reference-context", text: asset.notePath});
			const open = card.createEl("button", {text: "在笔记中打开"});
			open.addEventListener("click", () => void this.plugin.openReference(asset.notePath as string));
			return;
		}

		card.createDiv({cls: "media-vault-reference-context", text: "暂无素材笔记。"});
		const create = card.createEl("button", {text: "创建素材笔记"});
		create.addEventListener("click", () => {
			void this.plugin.openAssetDetailInGallery(asset.id).then(() => {
				this.plugin.setDetailPanel("asset-note");
			});
		});
	}

	private renderDetailGraph(root: HTMLElement, asset: Asset, references: AssetReference[], annotations: Annotation[]): void {
		const graph = root.createDiv({cls: "media-vault-graph-card"});
		const center = graph.createDiv({cls: "media-vault-graph-center"});
		center.createDiv({cls: "media-vault-graph-node is-center", text: asset.filename});
		center.createDiv({
			cls: "media-vault-graph-summary",
			text: `${references.length} 引用 · ${asset.tags.length} 标签 · ${annotations.length} 标注`,
		});

		const groups = graph.createDiv({cls: "media-vault-graph-groups"});
		this.renderGraphGroup(groups, "引用笔记", references.slice(0, 4).map((reference) => ({
			label: getPathBasename(reference.sourceNotePath),
			detail: reference.heading ?? reference.contextPreview ?? reference.rawLink,
			onClick: () => void this.plugin.openReference(reference.sourceNotePath, reference.lineStart),
		})));
		this.renderGraphGroup(groups, "Collections", asset.collections.slice(0, 4).map((collection) => ({
			label: collection,
			detail: "Collection",
		})));
		this.renderGraphGroup(groups, "标签", asset.tags.slice(0, 6).map((tag) => ({
			label: `#${tag}`,
			detail: "Tag",
		})));
		const extensionNodes: Array<GraphNodeData | null> = [
			asset.notePath ? {label: getPathBasename(asset.notePath), detail: "Asset Note", onClick: () => void this.plugin.openReference(asset.notePath as string)} : null,
			annotations.length > 0 ? {label: `${annotations.length} 个区域标注`, detail: "Annotations", onClick: () => {
				void this.plugin.openAssetDetailInGallery(asset.id, "annotation");
			}} : null,
		];
		this.renderGraphGroup(groups, "扩展节点", extensionNodes.filter((item): item is GraphNodeData => item !== null));
	}

	private renderGraphGroup(parent: HTMLElement, title: string, nodes: GraphNodeData[]): void {
		const group = parent.createDiv({cls: "media-vault-graph-group"});
		group.createDiv({cls: "media-vault-graph-group-title", text: title});
		if (nodes.length === 0) {
			group.createDiv({cls: "media-vault-graph-empty", text: "暂无连接"});
			return;
		}

		for (const node of nodes) {
			const item = group.createEl("button", {cls: node.onClick ? "media-vault-graph-link-node" : "media-vault-graph-node"});
			item.createSpan({cls: "media-vault-graph-node-label", text: node.label});
			if (node.detail) {
				item.createSpan({cls: "media-vault-graph-node-detail", text: node.detail});
			}
			if (node.onClick) {
				item.addEventListener("click", node.onClick);
			}
		}
	}

	private renderAnnotationList(root: HTMLElement, asset: Asset, annotations: Annotation[]): void {
		root.createDiv({cls: "media-vault-inspector-section-label", text: "区域标注"});
		if (annotations.length === 0) {
			root.createDiv({cls: "media-vault-hint", text: "暂无标注。"});
			return;
		}

		for (const annotation of annotations) {
			const linkStatus = this.getAnnotationLinkStatus(annotation, asset.notePath ?? asset.filePath);
			const item = root.createDiv({cls: `media-vault-annotation-list-item is-link-${linkStatus.state}`});
			item.style.setProperty("--media-vault-annotation-color", getAnnotationColor(annotation.color));
			const row = item.createDiv({cls: "media-vault-annotation-list-head"});
			const title = row.createDiv({cls: "media-vault-annotation-title"});
			title.createSpan({cls: "media-vault-annotation-color-dot"});
			title.createSpan({cls: "media-vault-reference-path", text: annotation.label});
			const actions = row.createDiv({cls: "media-vault-annotation-list-actions"});
			const edit = actions.createEl("button", {text: "编辑"});
			edit.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.plugin.openAssetAnnotationInGallery(asset.id, annotation.id);
			});
			const open = actions.createEl("button", {text: "打开"});
			open.disabled = linkStatus.state !== "ok";
			open.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.plugin.openAnnotationTarget(annotation, asset.notePath ?? asset.filePath);
			});
			const meta = item.createDiv({cls: "media-vault-annotation-meta"});
			meta.createSpan({cls: "media-vault-annotation-storage-chip", text: getAnnotationStorageLabel(getAnnotationStorageMode(annotation))});
			const linkText = buildAnnotationLinkText(annotation);
			if (linkText) {
				meta.createSpan({cls: "media-vault-annotation-link-chip", text: `[[${linkText}]]`});
			}
			meta.createSpan({cls: `media-vault-annotation-link-status is-${linkStatus.state}`, text: linkStatus.label});
			item.createDiv({cls: "media-vault-reference-context", text: annotation.text ?? linkText ?? "未填写说明"});
			item.addEventListener("click", () => {
				void this.plugin.openAssetAnnotationInGallery(asset.id, annotation.id);
			});
			item.addEventListener("dblclick", () => {
				void this.plugin.openAnnotationTarget(annotation, asset.notePath ?? asset.filePath);
			});
		}
	}

	private renderReferenceList(root: HTMLElement, references: AssetReference[]): void {
		const uniqueNoteCount = new Set(references.map((reference) => reference.sourceNotePath)).size;
		root.createDiv({cls: "media-vault-inspector-section-label", text: uniqueNoteCount > 0 ? `引用于 ${uniqueNoteCount} 篇笔记` : "引用上下文"});
		if (references.length === 0) {
			root.createDiv({cls: "media-vault-hint", text: "暂无引用。"});
			return;
		}

		for (const reference of references.slice(0, 12)) {
			const item = root.createDiv({cls: "media-vault-reference"});
			item.createDiv({cls: "media-vault-reference-path", text: formatReferenceLocation(reference)});
			if (reference.heading) {
				item.createDiv({cls: "media-vault-reference-heading", text: reference.heading});
			}
			item.createDiv({cls: "media-vault-reference-context", text: reference.contextPreview ?? reference.rawLink});
			const actions = item.createDiv({cls: "media-vault-reference-actions"});
			const showNoteImages = actions.createEl("button", {text: "查看该笔记图片"});
			showNoteImages.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.plugin.showNoteCollection(reference.sourceNotePath);
			});
			const folderPath = getParentPath(reference.sourceNotePath);
			if (folderPath) {
				const showFolderImages = actions.createEl("button", {text: "查看该目录图片"});
				showFolderImages.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					this.plugin.showFolderCollection(folderPath);
				});
			}
			const openNote = actions.createEl("button", {text: "打开笔记"});
			openNote.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.plugin.openReference(reference.sourceNotePath, reference.lineStart);
			});
			item.addEventListener("click", () => {
				void this.plugin.openReference(reference.sourceNotePath, reference.lineStart);
			});
		}
	}

	private renderMatchReasons(root: HTMLElement, asset: Asset, duplicateCandidates: Asset[]): void {
		const reasons = getAssetMatchReasons(
			asset,
			this.plugin.getActiveGalleryQuery(),
			this.plugin.getActiveGalleryQuickFilter(),
			duplicateCandidates.length,
		);
		if (reasons.length === 0) {
			return;
		}

		root.createDiv({cls: "media-vault-inspector-section-label", text: "为什么命中"});
		const list = root.createDiv({cls: "media-vault-match-reasons"});
		for (const reason of reasons.slice(0, 8)) {
			const item = list.createDiv({cls: "media-vault-match-reason"});
			item.createSpan({cls: "media-vault-match-reason-label", text: reason.label});
			item.createSpan({cls: "media-vault-match-reason-detail", text: reason.detail});
		}
	}

	private renderColorPalette(root: HTMLElement, asset: Asset): void {
		root.createDiv({cls: "media-vault-inspector-section-label", text: "颜色"});
		const colors = asset.dominantColors ?? [];
		if (colors.length === 0) {
			root.createDiv({cls: "media-vault-hint", text: "暂无主色信息。"});
			return;
		}

		const palette = root.createDiv({cls: "media-vault-inspector-palette"});
		for (const color of colors.slice(0, 8)) {
			const swatch = palette.createEl("button", {
				cls: "media-vault-inspector-swatch",
				attr: {"aria-label": `筛选主色 ${color}`},
			});
			swatch.style.backgroundColor = color;
			swatch.addEventListener("click", () => {
				this.plugin.setNavQuery({colors: [color]});
			});
		}
	}

	private renderValueChips(root: HTMLElement, label: string, values: string[], field: EditableListField, asset: Asset): void {
		root.createDiv({cls: "media-vault-inspector-section-label", text: label});
		const row = root.createDiv({cls: "media-vault-inspector-chip-row"});
		if (values.length === 0) {
			row.createSpan({cls: "media-vault-inspector-empty-chip", text: "暂无"});
		}

		for (const value of values) {
			const chip = row.createDiv({cls: "media-vault-inspector-chip media-vault-inspector-editable-chip"});
			const filter = chip.createEl("button", {cls: "media-vault-inspector-chip-label", text: field === "tags" ? `#${value}` : value});
			filter.addEventListener("click", () => {
				if (field === "tags") {
					this.plugin.setNavQuery({tags: [value]});
				} else {
					this.plugin.setNavQuery({collections: [value]});
				}
			});
			const remove = chip.createEl("button", {cls: "media-vault-inspector-chip-remove", text: "×"});
			remove.setAttr("aria-label", `移除 ${field === "tags" ? "标签" : "Collection"} ${value}`);
			remove.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.removeAssetListValue(asset, field, value);
			});
		}

		const add = row.createEl("button", {cls: "media-vault-inspector-chip is-add", text: "+"});
		add.setAttr("aria-label", `添加${label}`);
		add.addEventListener("click", () => {
			this.startInlineListEdit(asset.id, field);
		});

		if (this.inlineListEditor?.assetId === asset.id && this.inlineListEditor.field === field) {
			const editor = root.createDiv({cls: "media-vault-inspector-inline-editor"});
			const input = editor.createEl("input", {
				attr: {
					type: "text",
					value: this.inlineListDraft,
					placeholder: field === "tags" ? "输入标签，逗号分隔" : "输入 Collection，逗号分隔",
				},
			});
			input.value = this.inlineListDraft;
			input.addEventListener("input", () => {
				this.inlineListDraft = input.value;
			});
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					void this.confirmInlineListEdit(asset, field);
				}
				if (event.key === "Escape") {
					event.preventDefault();
					this.cancelInlineListEdit();
				}
			});
			const save = editor.createEl("button", {cls: "mod-cta", text: "添加"});
			save.addEventListener("click", () => void this.confirmInlineListEdit(asset, field));
			const cancel = editor.createEl("button", {text: "取消"});
			cancel.addEventListener("click", () => this.cancelInlineListEdit());
			input.focus();
		}
	}

	private startInlineListEdit(assetId: string, field: EditableListField): void {
		this.inlineListEditor = {assetId, field};
		this.inlineListDraft = "";
		this.editingFilenameAssetId = null;
		this.render();
	}

	private cancelInlineListEdit(): void {
		this.inlineListEditor = null;
		this.inlineListDraft = "";
		this.render();
	}

	private async confirmInlineListEdit(asset: Asset, field: EditableListField): Promise<void> {
		if (!this.inlineListEditor || this.inlineListEditor.assetId !== asset.id || this.inlineListEditor.field !== field) {
			return;
		}

		const values = splitInspectorTextList(this.inlineListDraft, field);
		if (values.length === 0) {
			new Notice(field === "tags" ? "请输入标签。" : "请输入 Collection。");
			return;
		}

		await this.plugin.services.assetRepository.updateAssets([asset.id], (item) => ({
			...item,
			[field]: mergeInspectorTextList(item[field], values),
			updatedAt: Date.now(),
		}));
		if (field === "collections") {
			for (const value of values) {
				await this.addAssetToManualCollection(value, asset.id);
			}
		}

		this.inlineListEditor = null;
		this.inlineListDraft = "";
		new Notice(field === "tags" ? `已添加标签：${values.map((value) => `#${value}`).join("、")}` : `已加入 Collection：${values.join("、")}`);
		this.render();
	}

	private async removeAssetListValue(asset: Asset, field: EditableListField, value: string): Promise<void> {
		await this.plugin.services.assetRepository.updateAssets([asset.id], (item) => ({
			...item,
			[field]: removeInspectorTextList(item[field], value),
			updatedAt: Date.now(),
		}));
		if (field === "collections") {
			await this.removeAssetFromManualCollection(value, asset.id);
		}
		new Notice(field === "tags" ? `已移除标签：#${value}` : `已移出 Collection：${value}`);
	}

	private async addAssetToManualCollection(name: string, assetId: string): Promise<void> {
		const normalizedName = normalizeInspectorKey(name);
		const now = Date.now();
		const existing = this.plugin.services.assetRepository.getCollections()
			.find((collection) => normalizeInspectorKey(collection.name) === normalizedName);
		if (!existing) {
			await this.plugin.services.assetRepository.upsertCollection({
				id: createInspectorManualCollectionId(name, now),
				name,
				type: "manual",
				assetIds: [assetId],
				createdAt: now,
				updatedAt: now,
			});
			return;
		}

		if (existing.type !== "manual") {
			return;
		}

		const assetIds = mergeInspectorTextList(existing.assetIds ?? [], [assetId]);
		await this.plugin.services.assetRepository.upsertCollection({
			...existing,
			assetIds,
			updatedAt: now,
		});
	}

	private async removeAssetFromManualCollection(name: string, assetId: string): Promise<void> {
		const normalizedName = normalizeInspectorKey(name);
		const existing = this.plugin.services.assetRepository.getCollections()
			.find((collection) => collection.type === "manual" && normalizeInspectorKey(collection.name) === normalizedName);
		if (!existing || !existing.assetIds?.includes(assetId)) {
			return;
		}

		await this.plugin.services.assetRepository.upsertCollection({
			...existing,
			assetIds: existing.assetIds.filter((id) => id !== assetId),
			updatedAt: Date.now(),
		});
	}

	private renderMetaRow(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv({cls: "media-vault-meta-row"});
		row.createSpan({text: label});
		row.createSpan({text: value});
	}

	private getAnnotationLinkStatus(annotation: Pick<Annotation, "linkedNotePath" | "linkedHeading" | "linkedBlockId">, sourcePath: string): AnnotationLinkStatus {
		const linkText = buildAnnotationLinkText(annotation);
		if (!linkText) {
			return {
				state: "none",
				label: "未绑定",
				linkText: null,
			};
		}

		const parsed = parseAnnotationLinkTarget(linkText);
		if (!parsed.path) {
			return {
				state: "missing-note",
				label: "链接格式异常",
				linkText,
			};
		}

		const file = this.app.metadataCache.getFirstLinkpathDest(parsed.path, sourcePath);
		if (!file) {
			return {
				state: "missing-note",
				label: "目标笔记不存在",
				linkText,
			};
		}

		const cache = this.app.metadataCache.getFileCache(file);
		if (parsed.blockId && !cache?.blocks?.[parsed.blockId]) {
			return {
				state: "missing-block",
				label: "块引用不存在",
				linkText,
				targetPath: file.path,
			};
		}
		if (parsed.heading && !headingExists(cache?.headings ?? [], parsed.heading)) {
			return {
				state: "missing-heading",
				label: "标题不存在",
				linkText,
				targetPath: file.path,
			};
		}

		return {
			state: "ok",
			label: parsed.heading || parsed.blockId ? "目标可跳转" : "笔记存在",
			linkText,
			targetPath: file.path,
		};
	}
}

function formatDuplicateSummary(exactCount: number, similarCount: number): string {
	const parts: string[] = [];
	if (exactCount > 0) {
		parts.push(`${exactCount} 张完全重复`);
	}
	if (similarCount > 0) {
		parts.push(`${similarCount} 张相似`);
	}
	return parts.join("，");
}

function getAnnotationColor(value: string | undefined): string {
	if (!value) {
		return DEFAULT_ANNOTATION_COLOR;
	}
	const color = value.trim();
	return /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_ANNOTATION_COLOR;
}

function getAnnotationStorageMode(annotation: Pick<Annotation, "storageMode">): AnnotationStorageMode {
	return annotation.storageMode === "index" ? "index" : "asset-note";
}

function getAnnotationStorageLabel(storageMode: AnnotationStorageMode): string {
	return storageMode === "asset-note" ? "Asset Note" : "插件索引";
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function formatAnnotationPercent(value: number): string {
	return `${Math.round(value * 1000) / 10}%`;
}

function formatOcrRect(rect: OcrRect): string {
	return `${formatAnnotationPercent(clamp(rect.x, 0, 1))} / ${formatAnnotationPercent(clamp(rect.y, 0, 1))} / ${formatAnnotationPercent(clamp(rect.width, 0, 1))} / ${formatAnnotationPercent(clamp(rect.height, 0, 1))}`;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return "未知错误";
}

function getDetailPanelLabel(panelId: MediaVaultDetailPanelId): string {
	if (panelId === "asset-note") {
		return "Asset Note";
	}
	if (panelId === "references") {
		return "引用";
	}
	if (panelId === "annotations") {
		return "标注";
	}
	if (panelId === "ocr") {
		return "OCR";
	}
	if (panelId === "versions") {
		return "版本";
	}
	if (panelId === "metadata") {
		return "元数据";
	}
	return "概览";
}

function buildAnnotationLinkText(annotation: Pick<Annotation, "linkedNotePath" | "linkedHeading" | "linkedBlockId">): string | null {
	let linkText = (annotation.linkedNotePath ?? "").trim();
	if (!linkText) {
		return null;
	}

	linkText = linkText
		.replace(/^!?\[\[/, "")
		.replace(/\]\]$/, "");
	const aliasIndex = linkText.indexOf("|");
	if (aliasIndex >= 0) {
		linkText = linkText.slice(0, aliasIndex);
	}

	const heading = (annotation.linkedHeading ?? "").trim().replace(/^#/, "");
	const blockId = (annotation.linkedBlockId ?? "").trim().replace(/^\^/, "");
	if (!linkText.includes("#") && heading) {
		linkText = `${linkText}#${heading}`;
	}
	if (!linkText.includes("^") && blockId) {
		linkText = `${linkText}^${blockId}`;
	}
	return linkText;
}

function parseAnnotationLinkTarget(linkText: string): ParsedAnnotationLinkTarget {
	const withoutAlias = linkText.split("|")[0] ?? linkText;
	const blockSplit = withoutAlias.split("^");
	const beforeBlock = blockSplit[0] ?? "";
	const blockId = normalizeText(blockSplit[1]);
	const headingSplit = beforeBlock.split("#");
	const path = normalizeText(headingSplit[0]);
	const heading = normalizeText(headingSplit.slice(1).join("#"));
	return {
		path,
		heading: heading || undefined,
		blockId: blockId || undefined,
	};
}

function headingExists(headings: Array<{heading: string}>, targetHeading: string): boolean {
	const normalizedTarget = stripHeadingForLink(targetHeading).toLowerCase();
	return headings.some((heading) => stripHeadingForLink(heading.heading).toLowerCase() === normalizedTarget);
}

function normalizeText(value: string | undefined): string {
	return (value ?? "").trim();
}

function splitInspectorTextList(value: string, field: EditableListField): string[] {
	return normalizeInspectorTextList(value.split(/[,\n，]+/), field);
}

function normalizeInspectorTextList(values: string[], field: EditableListField): string[] {
	const unique = new Map<string, string>();
	for (const value of values) {
		const normalized = normalizeInspectorListValue(value, field);
		if (normalized) {
			unique.set(normalizeInspectorKey(normalized), normalized);
		}
	}
	return Array.from(unique.values());
}

function normalizeInspectorListValue(value: string | undefined, field: EditableListField): string {
	const trimmed = normalizeText(value);
	if (field === "tags") {
		return trimmed.replace(/^#+/, "").trim();
	}
	return trimmed;
}

function mergeInspectorTextList(currentValues: string[], nextValues: string[]): string[] {
	const merged = new Map<string, string>();
	for (const value of currentValues) {
		const normalized = normalizeText(value);
		if (normalized) {
			merged.set(normalizeInspectorKey(normalized), normalized);
		}
	}
	for (const value of nextValues) {
		const normalized = normalizeText(value);
		if (normalized) {
			merged.set(normalizeInspectorKey(normalized), normalized);
		}
	}
	return Array.from(merged.values());
}

function removeInspectorTextList(currentValues: string[], valueToRemove: string): string[] {
	const removal = normalizeInspectorKey(valueToRemove);
	return currentValues.filter((value) => normalizeInspectorKey(value) !== removal);
}

function normalizeInspectorKey(value: string): string {
	return value.trim().toLowerCase();
}

function createInspectorManualCollectionId(name: string, seed: number): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 36) || "collection";
	return `manual-${slug}-${seed.toString(36)}`;
}

function formatDimensions(asset: Asset): string {
	if (typeof asset.width !== "number" || typeof asset.height !== "number") {
		return "未知";
	}

	return `${asset.width} × ${asset.height}`;
}

function getAssetMatchReasons(asset: Asset, query: AssetQuery, quickFilter: QuickFilterId, duplicateCount: number): MatchReason[] {
	const reasons: MatchReason[] = [];
	if (quickFilter === "unreferenced" && asset.referenceCount === 0) {
		reasons.push({label: "未引用", detail: "当前图片没有任何笔记引用。"});
	} else if (quickFilter === "favorites" && asset.favorite) {
		reasons.push({label: "收藏", detail: "当前图片已标记为收藏。"});
	} else if (quickFilter === "recent" && isRecentAsset(asset)) {
		reasons.push({label: "最近修改", detail: `修改时间 ${formatDateTime(asset.mtime)}。`});
	} else if (quickFilter === "duplicates" && duplicateCount > 0) {
		reasons.push({label: "重复图片", detail: `找到 ${duplicateCount} 张完全重复或相似图片。`});
	} else if (quickFilter === "trash" && asset.status === "trash") {
		reasons.push({label: "回收站", detail: "当前图片已移入插件回收站。"});
	}

	if (query.keyword && matchesInspectorKeyword(asset, query.keyword, query.keywordMode)) {
		reasons.push({label: "关键词", detail: `文件名、路径、标签或集合命中「${query.keyword}」。`});
	}
	if (query.linkedByNote) {
		reasons.push({label: "关联笔记", detail: `筛选范围限定为 ${getPathBasename(query.linkedByNote)} 的引用图片。`});
	}
	if (query.linkedByFolder) {
		reasons.push({label: "关联目录", detail: `引用笔记位于 ${getPathBasename(query.linkedByFolder)}。`});
	}
	if (query.formats?.includes(asset.ext.toLowerCase())) {
		reasons.push({label: "格式", detail: `${asset.ext.toUpperCase()} 符合当前格式筛选。`});
	}
	if (typeof query.referenced === "boolean") {
		reasons.push({label: "引用状态", detail: query.referenced ? `${asset.referenceCount} 处引用。` : "没有引用记录。"});
	}
	if (typeof query.minReferenceCount === "number" && asset.referenceCount >= query.minReferenceCount) {
		reasons.push({label: "引用次数", detail: `${asset.referenceCount} ≥ ${query.minReferenceCount}。`});
	}
	if (typeof query.ratingGte === "number" && (asset.rating ?? 0) >= query.ratingGte) {
		reasons.push({label: "评分", detail: `${asset.rating ?? 0} 星 ≥ ${query.ratingGte} 星。`});
	}
	if (query.tags) {
		const matchedTags = getCaseInsensitiveIntersection(asset.tags, query.tags);
		if (matchedTags.length > 0) {
			reasons.push({label: "标签", detail: matchedTags.map((tag) => `#${tag}`).join("、")});
		}
	}
	if (query.collections) {
		const matchedCollections = getCaseInsensitiveIntersection(asset.collections, query.collections);
		if (matchedCollections.length > 0) {
			reasons.push({label: "集合", detail: matchedCollections.join("、")});
		}
	}
	if (query.colors) {
		const matchedColors = getCaseInsensitiveIntersection(asset.dominantColors ?? [], query.colors);
		if (matchedColors.length > 0) {
			reasons.push({label: "颜色", detail: matchedColors.join("、")});
		}
	}
	if (matchesSizeRange(asset, query)) {
		reasons.push({label: "大小", detail: `${formatFileSize(asset.sizeBytes)} 在筛选范围内。`});
	}
	if (matchesDimensionRange(asset.width, query.minWidth, query.maxWidth)) {
		reasons.push({label: "宽度", detail: `${asset.width} px 在筛选范围内。`});
	}
	if (matchesDimensionRange(asset.height, query.minHeight, query.maxHeight)) {
		reasons.push({label: "高度", detail: `${asset.height} px 在筛选范围内。`});
	}
	if (query.createdAfter || query.createdBefore) {
		reasons.push({label: "创建时间", detail: formatDateTime(asset.ctime)});
	}
	if (query.modifiedAfter || query.modifiedBefore) {
		reasons.push({label: "修改时间", detail: formatDateTime(asset.mtime)});
	}
	if (query.ratio && matchesInspectorRatio(asset, query.ratio)) {
		reasons.push({label: "方向", detail: getRatioReasonLabel(query.ratio)});
	}
	return reasons;
}

function matchesInspectorKeyword(asset: Asset, keyword: string, keywordMode: AssetQuery["keywordMode"]): boolean {
	const normalized = keyword.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	const parts = [asset.filename, asset.filePath, ...asset.tags, ...asset.collections].map((part) => part.toLowerCase());
	const haystack = parts.join("\n");
	if (keywordMode === "exact") {
		return parts.some((part) => part === normalized);
	}
	if (keywordMode === "regex") {
		try {
			return new RegExp(keyword, "i").test(haystack);
		} catch {
			return false;
		}
	}
	return haystack.includes(normalized);
}

function getCaseInsensitiveIntersection(values: string[], requiredValues: string[]): string[] {
	const normalizedRequired = new Set(requiredValues.map((value) => value.toLowerCase()));
	return values.filter((value) => normalizedRequired.has(value.toLowerCase()));
}

function matchesSizeRange(asset: Asset, query: AssetQuery): boolean {
	const hasSizeFilter = typeof query.minSizeKb === "number" || typeof query.maxSizeKb === "number";
	if (!hasSizeFilter) {
		return false;
	}
	const minBytes = typeof query.minSizeKb === "number" ? query.minSizeKb * 1024 : undefined;
	const maxBytes = typeof query.maxSizeKb === "number" ? query.maxSizeKb * 1024 : undefined;
	return (typeof minBytes !== "number" || asset.sizeBytes >= minBytes)
		&& (typeof maxBytes !== "number" || asset.sizeBytes <= maxBytes);
}

function matchesDimensionRange(value: number | undefined, min: number | undefined, max: number | undefined): boolean {
	if (typeof min !== "number" && typeof max !== "number") {
		return false;
	}
	if (typeof value !== "number") {
		return false;
	}
	return (typeof min !== "number" || value >= min) && (typeof max !== "number" || value <= max);
}

function matchesInspectorRatio(asset: Asset, ratio: NonNullable<AssetQuery["ratio"]>): boolean {
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

function getRatioReasonLabel(ratio: NonNullable<AssetQuery["ratio"]>): string {
	if (ratio === "landscape") {
		return "横图";
	}
	if (ratio === "portrait") {
		return "竖图";
	}
	return "方图";
}

function isRecentAsset(asset: Asset): boolean {
	return Date.now() - asset.mtime <= 30 * 24 * 60 * 60 * 1000;
}

function getPathBasename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

function buildGalleryBlock(
	collection: Collection,
	query: AssetQuery,
	sortOption: MediaVaultGallerySortOption,
	viewMode: MediaVaultGalleryViewMode,
): string {
	const payload = {
		collection: collection.name,
		collectionId: collection.id,
		query,
		sort: sortOption,
		view: viewMode,
	};
	return `\`\`\`media-vault-gallery\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}

function formatQueryExpression(query: AssetQuery): string {
	const parts: string[] = [];
	if (query.keyword) {
		parts.push(`keyword:${query.keywordMode === "regex" ? "/" : ""}${query.keyword}${query.keywordMode === "regex" ? "/" : ""}`);
	}
	if (query.formats && query.formats.length > 0) {
		parts.push(`format:${query.formats.map((format) => format.toUpperCase()).join("|")}`);
	}
	if (typeof query.referenced === "boolean") {
		parts.push(query.referenced ? "referenced:true" : "referenced:false");
	}
	if (typeof query.minReferenceCount === "number") {
		parts.push(`refs>=${query.minReferenceCount}`);
	}
	if (query.linkedByNote) {
		parts.push(`linked:[[${getPathBasename(query.linkedByNote)}]]`);
	}
	if (query.linkedByFolder) {
		parts.push(`folder:${query.linkedByFolder}`);
	}
	pushRangeExpression(parts, "sizeKB", query.minSizeKb, query.maxSizeKb);
	pushRangeExpression(parts, "width", query.minWidth, query.maxWidth);
	pushRangeExpression(parts, "height", query.minHeight, query.maxHeight);
	if (query.ratio) {
		parts.push(`ratio:${getRatioReasonLabel(query.ratio)}`);
	}
	if (typeof query.ratingGte === "number") {
		parts.push(`rating>=${query.ratingGte}`);
	}
	for (const tag of query.tags ?? []) {
		parts.push(`tag:${tag}`);
	}
	for (const collection of query.collections ?? []) {
		parts.push(`collection:${collection}`);
	}
	for (const color of query.colors ?? []) {
		parts.push(`color:${color}`);
	}
	pushDateRangeExpression(parts, "created", query.createdAfter, query.createdBefore);
	pushDateRangeExpression(parts, "modified", query.modifiedAfter, query.modifiedBefore);
	return parts.join(" ");
}

function pushRangeExpression(parts: string[], label: string, min: number | undefined, max: number | undefined): void {
	if (typeof min !== "number" && typeof max !== "number") {
		return;
	}
	if (typeof min === "number" && typeof max === "number") {
		parts.push(`${label}:${min}..${max}`);
		return;
	}
	if (typeof min === "number") {
		parts.push(`${label}>=${min}`);
		return;
	}
	parts.push(`${label}<=${max}`);
}

function pushDateRangeExpression(parts: string[], label: string, after: number | undefined, before: number | undefined): void {
	if (typeof after !== "number" && typeof before !== "number") {
		return;
	}
	const lower = typeof after === "number" ? toDateText(after) : "";
	const upper = typeof before === "number" ? toDateText(before) : "";
	parts.push(`${label}:${lower || "*"}..${upper || "*"}`);
}

function toDateText(value: number): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return String(value);
	}
	const month = date.getMonth() + 1;
	const day = date.getDate();
	return `${date.getFullYear()}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getQueryExpressionKey(query: AssetQuery): string {
	return formatQueryExpression(query);
}

function getSortLabel(sortOption: MediaVaultGallerySortOption): string {
	switch (sortOption) {
		case "mtime-asc":
			return "最旧优先";
		case "name-asc":
			return "名称 A-Z";
		case "size-desc":
			return "大文件优先";
		case "references-desc":
			return "引用次数 desc";
		case "mtime-desc":
		default:
			return "最新优先";
	}
}

function getViewModeLabel(viewMode: MediaVaultGalleryViewMode): string {
	switch (viewMode) {
		case "grid":
			return "网格";
		case "list":
			return "列表";
		case "compact":
			return "紧凑";
		case "masonry":
		default:
			return "自适应";
	}
}
