import {Editor, FileSystemAdapter, MarkdownPostProcessorContext, MarkdownView, Menu, normalizePath, Notice, Plugin, stripHeadingForLink, TAbstractFile, TFile, TFolder, WorkspaceLeaf} from "obsidian";
import {MEDIA_VAULT_INSPECTOR_VIEW_TYPE, MEDIA_VAULT_NAV_VIEW_TYPE, MEDIA_VAULT_TASK_CENTER_VIEW_TYPE, MEDIA_VAULT_VIEW_TYPE, PLUGIN_DISPLAY_NAME} from "./constants";
import {registerCommands} from "./commands";
import {createMediaVaultServices, type MediaVaultServices} from "./services";
import {loadMediaVaultSettings, MediaVaultSettingTab, saveMediaVaultSettings, type MediaVaultSettings} from "./settings";
import {DEFAULT_ANNOTATION_COLOR, type Annotation, type Asset} from "./types/asset";
import type {MediaVaultGallerySortOption, MediaVaultGalleryViewMode} from "./types/gallery";
import type {OperationLog} from "./types/operation-log";
import type {AssetQuery, QuickFilterId} from "./types/query";
import {MediaVaultInspectorView} from "./views/media-vault-inspector-view";
import {InsertImageSuggest} from "./views/insert-image-suggest";
import {MediaVaultNavView} from "./views/media-vault-nav-view";
import {MediaVaultTaskCenterView} from "./views/media-vault-task-center-view";
import {MediaVaultView} from "./views/media-vault-view";
import {RebuildIndexConfirmModal} from "./views/rebuild-index-confirm-modal";
import {getAssetNoteSyncedFieldLabels, parseAssetNoteMetadata, toAssetNoteAnnotations, toAssetNoteMetadataPatch} from "./utils/asset-note-metadata";
import {getFileExtension, getFilename, getParentPath, isSupportedImagePath, joinVaultPath, stripLeadingSlash} from "./utils/path-utils";

type UiStateListener = () => void;
type AnnotationLinkState = "none" | "ok" | "missing-note" | "missing-heading" | "missing-block";
export type MediaVaultDetailMode = "detail" | "annotation" | "references";
export type MediaVaultDetailPanelId = "overview" | "asset-note" | "references" | "annotations" | "versions" | "metadata";
export type BatchDeleteMode = "trash" | "archive" | "permanent";

interface AnnotationLinkStatus {
	state: AnnotationLinkState;
	label: string;
	linkText: string | null;
}

interface ParsedAnnotationLinkTarget {
	path: string;
	heading?: string;
	blockId?: string;
}

interface ElectronShell {
	openPath(path: string): Promise<string>;
	showItemInFolder(path: string): void;
}

interface ElectronModule {
	shell?: ElectronShell;
}

type WindowWithOptionalRequire = Window & typeof globalThis & {
	require?: (moduleName: string) => unknown;
};

export interface BatchMoveResult {
	moved: number;
	updatedNotes: number;
	skipped: number;
	errors: string[];
	operationLogPath?: string;
}

export interface RenameAssetResult {
	renamed: number;
	updatedNotes: number;
	errors: string[];
	sourcePath?: string;
	targetPath?: string;
	operationLogPath?: string;
}

export interface BatchDeleteResult {
	updated: number;
	errors: string[];
	operationLogPath?: string;
}

export interface RestoreTrashResult {
	restored: number;
	errors: string[];
	operationLogPath?: string;
}

export interface RemoveCurrentNoteReferencesResult {
	notePath?: string;
	removed: number;
	updatedNotes: number;
	skipped: number;
	errors: string[];
	operationLogPath?: string;
}

export interface DemoteAssetResult {
	moved: number;
	updatedNotes: number;
	targetFolder?: string;
	errors: string[];
	operationLogPath?: string;
}

interface AssetNoteAnnotationEntry {
	id: string;
	label: string;
	rect: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	color?: string;
	text?: string;
	link?: string;
}

export default class MediaVaultPlugin extends Plugin {
	settings: MediaVaultSettings;
	services: MediaVaultServices;
	private focusedAssetId: string | null = null;
	private quickFilter: QuickFilterId = "all";
	private activeCollectionId: string | null = null;
	private activeNavQuery: AssetQuery | null = null;
	private activeGalleryQuery: AssetQuery = {};
	private activeGalleryQuickFilter: QuickFilterId = "all";
	private activeGallerySortOption: MediaVaultGallerySortOption = "mtime-desc";
	private activeGalleryViewMode: MediaVaultGalleryViewMode = "masonry";
	private detailAssetId: string | null = null;
	private detailMode: MediaVaultDetailMode = "detail";
	private detailPanelId: MediaVaultDetailPanelId = "overview";
	private focusedAnnotationId: string | null = null;
	private lastActiveMarkdownFilePath: string | null = null;
	private taskStatusBarItem: HTMLElement | null = null;
	private unsubscribeJobQueue: (() => void) | null = null;
	private readonly uiStateListeners = new Set<UiStateListener>();

	async onload(): Promise<void> {
		this.settings = await loadMediaVaultSettings(this);
		this.services = createMediaVaultServices(this.app, this);
		await this.services.assetRepository.loadSnapshot();

		this.registerView(MEDIA_VAULT_NAV_VIEW_TYPE, (leaf) => new MediaVaultNavView(leaf, this));
		this.registerView(MEDIA_VAULT_VIEW_TYPE, (leaf) => new MediaVaultView(leaf, this));
		this.registerView(MEDIA_VAULT_INSPECTOR_VIEW_TYPE, (leaf) => new MediaVaultInspectorView(leaf, this));
		this.registerView(MEDIA_VAULT_TASK_CENTER_VIEW_TYPE, (leaf) => new MediaVaultTaskCenterView(leaf, this));
		this.registerEditorSuggest(new InsertImageSuggest(this.app, this));
		this.addRibbonIcon("images", PLUGIN_DISPLAY_NAME, () => {
			void this.activateView();
		});
		registerCommands(this);
		this.registerTaskStatusBar();
		this.addSettingTab(new MediaVaultSettingTab(this.app, this));
		this.registerVaultEvents();
		this.registerFileMenuEntries();
		this.registerNoteImageEntry();
		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			if (file instanceof TFile && file.extension === "md") {
				this.lastActiveMarkdownFilePath = file.path;
			}
		}));

		this.app.workspace.onLayoutReady(() => {
			void this.rebuildIndex(false);
		});
	}

	onunload(): void {
		this.unsubscribeJobQueue?.();
		this.unsubscribeJobQueue = null;
		this.services.taskQueue.abortAll();
		this.services.thumbnailService.abortAll();
	}

	async saveSettings(): Promise<void> {
		await saveMediaVaultSettings(this, this.settings);
	}

	async activateView(): Promise<void> {
		const navLeaf = this.getOrCreateLeftLeaf(MEDIA_VAULT_NAV_VIEW_TYPE);
		const galleryLeaf = this.getOrCreateGalleryLeaf();
		const inspectorLeaf = this.getOrCreateRightLeaf(MEDIA_VAULT_INSPECTOR_VIEW_TYPE);

		await navLeaf.setViewState({type: MEDIA_VAULT_NAV_VIEW_TYPE, active: true});
		await galleryLeaf.setViewState({type: MEDIA_VAULT_VIEW_TYPE, active: true});
		await inspectorLeaf.setViewState({type: MEDIA_VAULT_INSPECTOR_VIEW_TYPE, active: true});
		await this.app.workspace.revealLeaf(navLeaf);
		await this.app.workspace.revealLeaf(inspectorLeaf);
		await this.app.workspace.revealLeaf(galleryLeaf);
	}

	async openTaskCenter(): Promise<void> {
		const taskLeaf = this.getOrCreateRightLeaf(MEDIA_VAULT_TASK_CENTER_VIEW_TYPE);
		await taskLeaf.setViewState({type: MEDIA_VAULT_TASK_CENTER_VIEW_TYPE, active: true});
		await this.app.workspace.revealLeaf(taskLeaf);
	}

	async rebuildIndex(showNotice: boolean): Promise<void> {
		const indexJobId = this.services.jobQueue.startJob({
			type: "index",
			label: "重建图片索引",
			total: 1,
			priority: showNotice ? "normal" : "low",
			details: "扫描 vault 中的图片文件。",
		});
		let referencesJobId: string | null = null;
		try {
			const indexing = await this.services.assetIndexer.scanVault();
			this.services.jobQueue.updateJob(indexJobId, {
				progress: 1,
				details: `图片扫描完成：${indexing.totalImages} 张。`,
			});
			this.services.jobQueue.completeJob(indexJobId, `图片扫描完成：${indexing.totalImages} 张。`);
			referencesJobId = this.services.jobQueue.startJob({
				type: "references",
				label: "重建引用索引",
				total: 1,
				priority: showNotice ? "normal" : "low",
				details: "扫描 Markdown 中的图片引用。",
			});
			const references = await this.services.linkGraphService.rebuildReferences();
			const doneMessage = `索引完成：${indexing.totalImages} 张图片，${references.references} 个引用。`;
			this.services.jobQueue.completeJob(referencesJobId, doneMessage);
			if (showNotice) {
				new Notice(doneMessage);
			}
		} catch (error) {
			this.services.jobQueue.failJob(referencesJobId ?? indexJobId, error);
			if (showNotice) {
				new Notice(`索引失败：${getErrorMessage(error)}`);
			}
		}
	}

	confirmRebuildIndex(): void {
		new RebuildIndexConfirmModal(
			this.app,
			{
				assets: this.services.assetRepository.getActiveAssets().length,
				references: this.services.assetRepository.getReferences().length,
			},
			() => this.rebuildIndex(true),
		).open();
	}

	async rebuildThumbnailCache(showNotice: boolean): Promise<void> {
		const assets = this.services.assetRepository.getActiveAssets();
		const queued = await this.services.thumbnailService.rebuildCache(assets);
		if (showNotice) {
			new Notice(`缩略图缓存已清空，正在后台重建 ${queued} 张图片。`);
		}
	}

	setFocusedAsset(assetId: string): void {
		if (this.focusedAssetId === assetId) {
			return;
		}
		this.focusedAssetId = assetId;
		this.notifyUiStateChanged();
	}

	getFocusedAsset(): Asset | undefined {
		return this.services.assetRepository.getAssetById(this.focusedAssetId);
	}

	setQuickFilter(quickFilter: QuickFilterId): void {
		const hadActiveCollection = this.activeCollectionId !== null;
		const hadActiveNavQuery = this.activeNavQuery !== null;
		if (this.quickFilter === quickFilter && !hadActiveCollection && !hadActiveNavQuery) {
			return;
		}
		this.quickFilter = quickFilter;
		this.activeCollectionId = null;
		this.activeNavQuery = null;
		this.notifyUiStateChanged();
	}

	getQuickFilter(): QuickFilterId {
		return this.quickFilter;
	}

	setActiveCollection(collectionId: string | null): void {
		const hadActiveNavQuery = this.activeNavQuery !== null;
		if (this.activeCollectionId === collectionId && !hadActiveNavQuery) {
			return;
		}
		this.activeCollectionId = collectionId;
		this.activeNavQuery = null;
		if (collectionId) {
			this.quickFilter = "all";
		}
		this.notifyUiStateChanged();
	}

	getActiveCollectionId(): string | null {
		return this.activeCollectionId;
	}

	setNavQuery(query: AssetQuery | null): void {
		const nextQuery = clonePluginAssetQuery(query);
		const isSameQuery = getPluginAssetQueryKey(this.activeNavQuery) === getPluginAssetQueryKey(nextQuery);
		const hadActiveCollection = this.activeCollectionId !== null;
		const hadOtherQuickFilter = this.quickFilter !== "all";
		if (isSameQuery && !hadActiveCollection && !hadOtherQuickFilter) {
			return;
		}

		this.activeNavQuery = nextQuery;
		this.activeCollectionId = null;
		this.quickFilter = "all";
		this.notifyUiStateChanged();
	}

	getNavQuery(): AssetQuery | null {
		return clonePluginAssetQuery(this.activeNavQuery);
	}

	setActiveGalleryFilter(
		query: AssetQuery,
		quickFilter: QuickFilterId,
		sortOption: MediaVaultGallerySortOption = this.activeGallerySortOption,
		viewMode: MediaVaultGalleryViewMode = this.activeGalleryViewMode,
	): void {
		const nextQuery = clonePluginAssetQuery(query) ?? {};
		const isSameQuery = getPluginAssetQueryKey(this.activeGalleryQuery) === getPluginAssetQueryKey(nextQuery);
		if (
			isSameQuery
			&& this.activeGalleryQuickFilter === quickFilter
			&& this.activeGallerySortOption === sortOption
			&& this.activeGalleryViewMode === viewMode
		) {
			return;
		}

		this.activeGalleryQuery = nextQuery;
		this.activeGalleryQuickFilter = quickFilter;
		this.activeGallerySortOption = sortOption;
		this.activeGalleryViewMode = viewMode;
		this.notifyUiStateChanged();
	}

	getActiveGalleryQuery(): AssetQuery {
		return clonePluginAssetQuery(this.activeGalleryQuery) ?? {};
	}

	getActiveGalleryQuickFilter(): QuickFilterId {
		return this.activeGalleryQuickFilter;
	}

	getActiveGallerySortOption(): MediaVaultGallerySortOption {
		return this.activeGallerySortOption;
	}

	getActiveGalleryViewMode(): MediaVaultGalleryViewMode {
		return this.activeGalleryViewMode;
	}

	openAssetDetail(assetId: string, mode: MediaVaultDetailMode = "detail", annotationId: string | null = null): void {
		const isNewAsset = this.detailAssetId !== assetId;
		const nextMode = mode === "annotation" ? "detail" : mode;
		this.focusedAssetId = assetId;
		this.detailAssetId = assetId;
		this.detailMode = nextMode;
		this.focusedAnnotationId = nextMode === "detail" ? null : annotationId;
		if (nextMode === "references") {
			this.detailPanelId = "references";
		} else if (isNewAsset || this.detailPanelId === "annotations") {
			this.detailPanelId = "overview";
		}
		this.notifyUiStateChanged();
	}

	async openAssetDetailInGallery(assetId: string, mode: MediaVaultDetailMode = "detail", annotationId: string | null = null): Promise<void> {
		await this.activateView();
		this.openAssetDetail(assetId, mode, annotationId);
	}

	closeAssetDetail(): void {
		if (!this.detailAssetId) {
			return;
		}
		this.detailAssetId = null;
		this.detailMode = "detail";
		this.detailPanelId = "overview";
		this.focusedAnnotationId = null;
		this.notifyUiStateChanged();
	}

	getDetailAsset(): Asset | undefined {
		return this.services.assetRepository.getAssetById(this.detailAssetId);
	}

	getDetailMode(): MediaVaultDetailMode {
		return this.detailMode;
	}

	getDetailPanel(): MediaVaultDetailPanelId {
		return this.detailPanelId;
	}

	setDetailPanel(panelId: MediaVaultDetailPanelId): void {
		const nextPanelId = panelId === "annotations" ? "overview" : panelId;
		if (this.detailPanelId === nextPanelId) {
			return;
		}

		this.detailPanelId = nextPanelId;
		if (this.detailMode === "annotation") {
			this.detailMode = "detail";
			this.focusedAnnotationId = null;
		}
		this.notifyUiStateChanged();
	}

	getFocusedAnnotationId(): string | null {
		return this.focusedAnnotationId;
	}

	subscribeUiState(listener: UiStateListener): () => void {
		this.uiStateListeners.add(listener);
		return () => this.uiStateListeners.delete(listener);
	}

	async insertFocusedAsset(): Promise<void> {
		const asset = this.getFocusedAsset();
		if (!asset) {
			new Notice("请先选择图片。");
			return;
		}
		await this.insertAsset(asset);
	}

	async insertAsset(asset: Asset): Promise<void> {
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!markdownView?.file) {
			new Notice("请先打开一个 Markdown 笔记。");
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(asset.filePath);
		if (!(file instanceof TFile)) {
			new Notice("图片文件不存在，建议重建索引。");
			return;
		}

		const sourcePath = markdownView.file.path;
		const link = this.app.fileManager.generateMarkdownLink(file, sourcePath);
		markdownView.editor.replaceSelection(link.startsWith("!") ? link : `!${link}`);
		await this.services.linkGraphService.rebuildReferences();
		new Notice("已插入图片链接。");
	}

	async toggleAssetFavorite(assetId: string): Promise<void> {
		const asset = this.services.assetRepository.getAssetById(assetId);
		if (!asset) {
			return;
		}

		await this.services.assetRepository.updateAssets([assetId], (item) => ({
			...item,
			favorite: !item.favorite,
			updatedAt: Date.now(),
		}));
	}

	async copyFocusedAssetWikiLink(): Promise<void> {
		const asset = this.getFocusedAsset();
		if (!asset) {
			new Notice("请先选择图片。");
			return;
		}
		await this.copyAssetWikiLink(asset);
	}

	async copyAssetWikiLink(asset: Asset): Promise<void> {
		const wikiLink = `![[${asset.filePath}]]`;
		await navigator.clipboard.writeText(wikiLink);
		new Notice("已复制 wiki 链接。");
	}

	async copyAssetPath(asset: Asset, absolute = false): Promise<void> {
		const text = absolute ? this.getAssetSystemPath(asset) ?? asset.filePath : asset.filePath;
		await navigator.clipboard.writeText(text);
		new Notice(absolute && text !== asset.filePath ? "已复制图片绝对路径。" : "已复制图片路径。");
	}

	async removeAssetReferencesFromCurrentNote(assetIds: string[]): Promise<RemoveCurrentNoteReferencesResult> {
		const result: RemoveCurrentNoteReferencesResult = {
			removed: 0,
			updatedNotes: 0,
			skipped: 0,
			errors: [],
		};
		const note = this.getActiveMarkdownFile();
		if (!note) {
			result.errors.push("当前没有打开的 Markdown 笔记。");
			return result;
		}
		result.notePath = note.path;

		const selectedAssetIds = new Set(assetIds);
		const assets = assetIds
			.map((assetId) => this.services.assetRepository.getAssetById(assetId))
			.filter((asset): asset is Asset => Boolean(asset));
		const references = this.services.assetRepository.getReferencesForNote(note.path)
			.filter((reference) => selectedAssetIds.has(reference.assetId));
		result.skipped = Math.max(0, assetIds.length - new Set(references.map((reference) => reference.assetId)).size);

		const operationLog = await this.services.transactionLogService.create("batch-update", {
			mode: "remove-current-note-references",
			notePath: note.path,
			totalAssets: assetIds.length,
			referenceCount: references.length,
			assets: assets.map((asset) => ({
				assetId: asset.id,
				filename: asset.filename,
				filePath: asset.filePath,
				referencesInCurrentNote: references.filter((reference) => reference.assetId === asset.id).length,
			})),
		});
		result.operationLogPath = this.services.transactionLogService.getPath(operationLog);

		if (references.length === 0) {
			await this.services.transactionLogService.commit(operationLog);
			return result;
		}

		try {
			const original = await this.app.vault.read(note);
			let next = original;
			const removals: Array<{assetId: string; rawLink: string; occurrences: number}> = [];
			for (const reference of references) {
				const occurrences = countOccurrences(next, reference.rawLink);
				if (occurrences === 0) {
					continue;
				}
				next = next.split(reference.rawLink).join("");
				result.removed += occurrences;
				removals.push({
					assetId: reference.assetId,
					rawLink: reference.rawLink,
					occurrences,
				});
			}

			if (next === original) {
				await this.services.transactionLogService.commit(operationLog);
				return result;
			}

			await this.app.vault.modify(note, next);
			result.updatedNotes = 1;
			await this.services.transactionLogService.appendStep(operationLog, {
				action: "remove-current-note-references",
				details: {
					notePath: note.path,
					removedReferences: removals,
				},
			});
			await this.services.transactionLogService.appendRollbackStep(operationLog, {
				action: "manual-restore-current-note-references",
				details: {
					notePath: note.path,
					rawLinks: removals.map((removal) => removal.rawLink),
				},
			});
			await this.services.linkGraphService.rebuildReferences();
			await this.services.transactionLogService.commit(operationLog);
		} catch (error) {
			const message = `${note.path} 移除引用失败：${getErrorMessage(error)}`;
			result.errors.push(message);
			await this.services.transactionLogService.fail(operationLog, message);
		}

		return result;
	}

	async showAssetInFileManager(asset: Asset): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(asset.filePath);
		if (!(file instanceof TFile)) {
			new Notice("图片文件不存在，建议重建索引。");
			return;
		}

		const systemPath = this.getAssetSystemPath(asset);
		const shell = getElectronShell();
		if (!systemPath || !shell?.showItemInFolder) {
			await this.copyAssetPath(asset);
			new Notice("当前平台不支持系统文件管理器定位，已复制图片路径。");
			return;
		}

		shell.showItemInFolder(systemPath);
		new Notice("已在文件管理器中定位图片。");
	}

	async openAssetWithDefaultApp(asset: Asset): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(asset.filePath);
		if (!(file instanceof TFile)) {
			new Notice("图片文件不存在，建议重建索引。");
			return;
		}

		const systemPath = this.getAssetSystemPath(asset);
		const shell = getElectronShell();
		if (!systemPath || !shell?.openPath) {
			await this.copyAssetPath(asset);
			new Notice("当前平台不支持外部打开，已复制图片路径。");
			return;
		}

		const error = await shell.openPath(systemPath);
		if (error) {
			new Notice(`外部打开失败：${error}`);
			return;
		}
		new Notice("已用系统默认应用打开图片。");
	}

	async openReference(notePath: string, lineStart?: number): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) {
			new Notice("引用笔记不存在。");
			return;
		}

		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		if (typeof lineStart !== "number" || !Number.isFinite(lineStart)) {
			return;
		}

		const view = leaf.view;
		if (!(view instanceof MarkdownView)) {
			return;
		}

		const line = Math.max(0, lineStart - 1);
		view.editor.setCursor({line, ch: 0});
		view.editor.scrollIntoView({from: {line, ch: 0}, to: {line, ch: 0}}, true);
	}

	private getAssetSystemPath(asset: Asset): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			return null;
		}
		return normalizePath(`${adapter.getBasePath()}/${asset.filePath}`);
	}

	private getGalleryView(): MediaVaultView | null {
		for (const leaf of this.app.workspace.getLeavesOfType(MEDIA_VAULT_VIEW_TYPE)) {
			if (leaf.view instanceof MediaVaultView) {
				return leaf.view;
			}
		}
		return null;
	}

	private getCommandTargetAsset(): Asset | undefined {
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (markdownView?.file) {
			const asset = this.resolveAssetForEditorCursor(markdownView.editor, markdownView.file.path);
			if (asset) {
				return asset;
			}
		}
		return this.getFocusedAsset();
	}

	getActiveMarkdownFile(): TFile | null {
		const activeFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		if (activeFile) {
			this.lastActiveMarkdownFilePath = activeFile.path;
			return activeFile;
		}

		if (!this.lastActiveMarkdownFilePath) {
			return null;
		}
		const file = this.app.vault.getAbstractFileByPath(this.lastActiveMarkdownFilePath);
		if (file instanceof TFile && file.extension === "md") {
			return file;
		}
		this.lastActiveMarkdownFilePath = null;
		return null;
	}

	getActiveMarkdownFolderPath(): string | null {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			return null;
		}
		return getParentPath(file.path) || null;
	}

	async showCurrentNoteCollection(): Promise<void> {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice("当前没有打开的 Markdown 笔记。");
			return;
		}

		await this.activateView();
		this.showNoteCollection(file.path);
	}

	async showCurrentFolderCollection(): Promise<void> {
		const folderPath = this.getActiveMarkdownFolderPath();
		if (!folderPath) {
			new Notice("当前笔记没有可用目录。");
			return;
		}

		await this.activateView();
		this.showFolderCollection(folderPath);
	}

	showNoteCollection(notePath: string): void {
		this.setNavQuery({linkedByNote: notePath});
		this.closeAssetDetail();
	}

	showDuplicateAssets(): void {
		this.setQuickFilter("duplicates");
		this.closeAssetDetail();
	}

	async openSimilarAssets(assetId: string): Promise<void> {
		await this.activateView();
		this.closeAssetDetail();
		const galleryView = this.getGalleryView();
		if (!galleryView) {
			new Notice("图库视图尚未就绪，请稍后重试。");
			return;
		}
		galleryView.openSimilarAssets(assetId);
	}

	showUnusedImages(): void {
		this.setQuickFilter("unreferenced");
		this.closeAssetDetail();
	}

	showFolderCollection(folderPath: string): void {
		this.setNavQuery({linkedByFolder: normalizePath(folderPath)});
		this.closeAssetDetail();
	}

	async openAdvancedFilter(): Promise<void> {
		await this.activateView();
		const galleryView = this.getGalleryView();
		if (!galleryView) {
			new Notice("图库视图尚未就绪，请稍后重试。");
			return;
		}
		galleryView.openAdvancedFilter();
	}

	async openSmartCollectionBuilder(): Promise<void> {
		await this.activateView();
		const galleryView = this.getGalleryView();
		if (!galleryView) {
			new Notice("图库视图尚未就绪，请稍后重试。");
			return;
		}
		galleryView.openSmartCollectionBuilder();
	}

	async openCompressSelectedImagesDryRun(): Promise<void> {
		const commandTarget = this.getCommandTargetAsset();
		await this.activateView();
		const galleryView = this.getGalleryView();
		if (!galleryView) {
			new Notice("图库视图尚未就绪，请稍后重试。");
			return;
		}
		const opened = galleryView.openConvertDryRun(commandTarget?.id);
		if (!opened) {
			new Notice("请先选择要压缩/转换的图片。");
		}
	}

	async openCommandTargetAssetDetail(mode: MediaVaultDetailMode = "detail"): Promise<void> {
		const asset = this.getCommandTargetAsset();
		if (!asset) {
			new Notice("请先选择图库图片，或把光标放在 Markdown 图片链接上。");
			return;
		}
		await this.openAssetDetailInGallery(asset.id, mode);
	}

	async createAssetNoteForCommandTarget(): Promise<void> {
		const asset = this.getCommandTargetAsset();
		if (!asset) {
			new Notice("请先选择图库图片，或把光标放在 Markdown 图片链接上。");
			return;
		}
		await this.saveAssetNote(asset, await this.readAssetNote(asset));
		const nextAsset = this.services.assetRepository.getAssetById(asset.id);
		if (nextAsset?.notePath) {
			await this.openReference(nextAsset.notePath);
		}
	}

	async openOrCreateAssetNote(asset: Asset): Promise<void> {
		await this.saveAssetNote(asset, await this.readAssetNote(asset));
		const nextAsset = this.services.assetRepository.getAssetById(asset.id);
		if (nextAsset?.notePath) {
			await this.openReference(nextAsset.notePath);
		}
	}

	async promoteCurrentImageToAssetLibrary(): Promise<void> {
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!markdownView?.file) {
			new Notice("请先打开 Markdown 笔记，并把光标放在图片链接上。");
			return;
		}

		const target = findImageTargetNearCursor(
			markdownView.editor.getLine(markdownView.editor.getCursor().line),
			markdownView.editor.getCursor().ch,
		);
		if (!target) {
			new Notice("光标附近没有可加入图库的图片链接。");
			return;
		}

		const file = this.resolveLocalImageFileTarget(target, markdownView.file.path);
		if (!file) {
			new Notice(isExternalImageTarget(target) ? "暂不支持将外部图片 URL 直接加入图库。" : "未找到本地图片文件。");
			return;
		}

		await this.promoteImageFileToAssetLibrary(file, true);
	}

	async importImagesFromPicker(): Promise<void> {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = true;
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			if (files.length === 0) {
				return;
			}
			void this.importImageFiles(files);
		}, {once: true});
		input.click();
	}

	async openAnnotationTarget(annotation: Annotation, sourcePath?: string): Promise<void> {
		const linkText = this.buildAnnotationLinkText(annotation);
		if (!linkText) {
			new Notice("该标注未绑定笔记、标题或块引用。");
			return;
		}

		try {
			await this.app.workspace.openLinkText(linkText, sourcePath ?? "", false);
		} catch (error) {
			new Notice(`标注链接打开失败：${getErrorMessage(error)}`);
		}
	}

	async readAssetNote(asset: Asset): Promise<string> {
		if (!asset.notePath) {
			return this.buildDefaultAssetNote(asset);
		}
		const file = this.app.vault.getAbstractFileByPath(asset.notePath);
		if (!(file instanceof TFile)) {
			return this.buildDefaultAssetNote(asset);
		}
		return this.app.vault.read(file);
	}

	async saveAssetNote(asset: Asset, content: string): Promise<void> {
		const notePath = asset.notePath ?? this.getAssetNotePath(asset);
		await this.ensureVaultFolder(notePath.substring(0, notePath.lastIndexOf("/")));
		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(notePath, content);
		}
		const parsedMetadata = parseAssetNoteMetadata(content);
		const metadataPatch = toAssetNoteMetadataPatch(parsedMetadata);
		await this.services.assetRepository.updateAssets([asset.id], (item) => ({
			...item,
			notePath,
			...metadataPatch,
			updatedAt: Date.now(),
		}));
		if (parsedMetadata.annotations) {
			await this.services.assetRepository.replaceAssetNoteAnnotations(
				asset.id,
				toAssetNoteAnnotations(parsedMetadata, asset.id, this.services.assetRepository.getAnnotationsForAsset(asset.id)),
			);
		}
		const syncedFields = getAssetNoteSyncedFieldLabels(metadataPatch);
		if (parsedMetadata.annotations) {
			syncedFields.push("区域标注");
		}
		new Notice(syncedFields.length > 0 ? `已保存素材笔记，并同步 ${syncedFields.join("、")}。` : "已保存素材笔记。");
	}

	async syncAssetNoteAnnotations(assetId: string): Promise<void> {
		const asset = await this.ensureAssetNoteForAnnotationSync(assetId);
		if (!asset?.notePath) {
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(asset.notePath);
		if (!(file instanceof TFile)) {
			return;
		}
		const annotationEntries = this.services.assetRepository
			.getAnnotationsForAsset(asset.id)
			.filter((annotation) => (annotation.storageMode ?? "asset-note") === "asset-note")
			.map((annotation) => this.toAssetNoteAnnotationEntry(annotation));

		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				frontmatter.annotations = annotationEntries;
				frontmatter.annotation_count = annotationEntries.length;
			});
		} catch (error) {
			new Notice(`素材笔记标注同步失败：${getErrorMessage(error)}`);
		}
	}

	async moveAssetsToFolder(assetIds: string[], targetFolder: string, rewriteMarkdownLinks: boolean): Promise<BatchMoveResult> {
		const folder = normalizePath(targetFolder.trim());
		const result: BatchMoveResult = {
			moved: 0,
			updatedNotes: 0,
			skipped: 0,
			errors: [],
		};
		if (!folder) {
			result.errors.push("目标文件夹为空。");
			return result;
		}

		await this.ensureVaultFolder(folder);
		const reservedTargets = new Set<string>();
		const movePlans: Array<{asset: Asset; sourcePath: string; targetPath: string; references: ReturnType<MediaVaultServices["assetRepository"]["getReferencesForAsset"]>}> = [];
		const rewritesByNote = new Map<string, Array<{rawLink: string; newLink: string}>>();
		const movedAssetIds: string[] = [];
		const movedPaths = new Map<string, string>();

		for (const assetId of assetIds) {
			const asset = this.services.assetRepository.getAssetById(assetId);
			if (!asset) {
				result.skipped += 1;
				continue;
			}
			const file = this.app.vault.getAbstractFileByPath(asset.filePath);
			if (!(file instanceof TFile)) {
				result.errors.push(`${asset.filename} 不存在。`);
				result.skipped += 1;
				continue;
			}

			const nextPath = await this.getAvailableMovePath(normalizePath(`${folder}/${file.name}`), file.path, reservedTargets);
			if (nextPath === file.path) {
				result.skipped += 1;
				continue;
			}
			reservedTargets.add(nextPath);
			movePlans.push({
				asset,
				sourcePath: file.path,
				targetPath: nextPath,
				references: this.services.assetRepository.getReferencesForAsset(asset.id),
			});
		}

		const operationLog = await this.services.transactionLogService.create("move", {
			targetFolder: folder,
			rewriteMarkdownLinks,
			totalAssets: assetIds.length,
			skippedAssets: result.skipped,
			preflightErrors: result.errors,
			plans: movePlans.map((plan) => ({
				assetId: plan.asset.id,
				filename: plan.asset.filename,
				sourcePath: plan.sourcePath,
				targetPath: plan.targetPath,
				referenceCount: plan.references.length,
				affectedNotes: Array.from(new Set(plan.references.map((reference) => reference.sourceNotePath))).sort(),
			})),
		});
		result.operationLogPath = this.services.transactionLogService.getPath(operationLog);
		if (result.errors.length > 0) {
			await this.services.transactionLogService.fail(operationLog, "dry run 存在错误，未执行移动。", {errors: result.errors});
			return result;
		}

		for (const plan of movePlans) {
			const file = this.app.vault.getAbstractFileByPath(plan.sourcePath);
			if (!(file instanceof TFile)) {
				const message = `${plan.asset.filename} 不存在。`;
				result.errors.push(message);
				await this.services.transactionLogService.fail(operationLog, message, {sourcePath: plan.sourcePath});
				break;
			}
			try {
				await this.app.vault.rename(file, plan.targetPath);
				result.moved += 1;
				movedAssetIds.push(plan.asset.id);
				movedPaths.set(plan.asset.id, plan.targetPath);
				await this.services.transactionLogService.appendStep(operationLog, {
					action: "move-file",
					details: {
						assetId: plan.asset.id,
						from: plan.sourcePath,
						to: plan.targetPath,
					},
				});
				await this.services.transactionLogService.appendRollbackStep(operationLog, {
					action: "move-file",
					details: {
						assetId: plan.asset.id,
						from: plan.targetPath,
						to: plan.sourcePath,
					},
				});
				if (rewriteMarkdownLinks) {
					const movedFile = this.app.vault.getAbstractFileByPath(plan.targetPath);
					if (movedFile instanceof TFile) {
						for (const reference of plan.references) {
							const newLink = this.makeImageMarkdownLink(movedFile, reference.sourceNotePath);
							const rewrites = rewritesByNote.get(reference.sourceNotePath) ?? [];
							rewrites.push({rawLink: reference.rawLink, newLink});
							rewritesByNote.set(reference.sourceNotePath, rewrites);
						}
					}
				}
			} catch (error) {
				const message = `${plan.asset.filename} 移动失败：${getErrorMessage(error)}`;
				result.errors.push(message);
				await this.services.transactionLogService.fail(operationLog, message, {
					sourcePath: plan.sourcePath,
					targetPath: plan.targetPath,
				});
				break;
			}
		}

		if (rewriteMarkdownLinks) {
			result.updatedNotes = await this.rewriteMovedAssetLinks(rewritesByNote, result.errors, operationLog);
		}
		if (movedAssetIds.length > 0) {
			await this.services.assetRepository.updateAssets(movedAssetIds, (asset) => ({
				...asset,
				filePath: movedPaths.get(asset.id) ?? asset.filePath,
				filename: movedPaths.get(asset.id)?.split("/").pop() ?? asset.filename,
				updatedAt: Date.now(),
			}));
			await this.services.linkGraphService.rebuildReferences();
		}
		if (result.errors.length > 0) {
			await this.services.transactionLogService.fail(operationLog, "批量移动存在错误，已保留回滚步骤。", {errors: result.errors});
		} else {
			await this.services.transactionLogService.commit(operationLog);
		}
		return result;
	}

	async demoteFocusedAssetToCurrentNoteAttachment(): Promise<void> {
		const asset = this.getFocusedAsset();
		if (!asset) {
			new Notice("请先选择要降级为局部附件的图片。");
			return;
		}
		await this.demoteAssetToCurrentNoteAttachment(asset);
	}

	async demoteAssetToCurrentNoteAttachment(asset: Asset): Promise<void> {
		const result = await this.demoteAssetToCurrentNoteAttachmentInternal(asset);
		if (result.errors.length > 0) {
			new Notice(`降级失败：${result.errors.join("；")}`);
			return;
		}

		const logSuffix = result.operationLogPath ? `，事务日志 ${result.operationLogPath}` : "";
		new Notice(`已降级为当前笔记附件：移动 ${result.moved} 张，改写 ${result.updatedNotes} 篇笔记${logSuffix}。`);
	}

	private async demoteAssetToCurrentNoteAttachmentInternal(asset: Asset): Promise<DemoteAssetResult> {
		const note = this.getActiveMarkdownFile();
		const result: DemoteAssetResult = {
			moved: 0,
			updatedNotes: 0,
			errors: [],
		};
		if (!note) {
			result.errors.push("当前没有打开的 Markdown 笔记。");
			return result;
		}
		if (asset.status !== "active") {
			result.errors.push("只能降级 active 状态的图片。");
			return result;
		}

		const references = this.services.assetRepository.getReferencesForAsset(asset.id);
		const externalNotes = Array.from(new Set(references
			.map((reference) => reference.sourceNotePath)
			.filter((notePath) => notePath !== note.path)))
			.sort();
		if (externalNotes.length > 0) {
			result.errors.push(`该图片还被 ${externalNotes.length} 篇其它笔记引用，请先处理引用：${externalNotes.slice(0, 3).join("、")}`);
			return result;
		}

		const targetFolder = renderLocalAttachmentDirectory(this.settings.localAttachmentDirectoryTemplate, note);
		result.targetFolder = targetFolder;
		const moveResult = await this.moveAssetsToFolder([asset.id], targetFolder, true);
		result.moved = moveResult.moved;
		result.updatedNotes = moveResult.updatedNotes;
		result.operationLogPath = moveResult.operationLogPath;
		result.errors.push(...moveResult.errors);
		if (result.errors.length > 0) {
			return result;
		}

		await this.services.assetRepository.updateAssets([asset.id], (item) => ({
			...item,
			origin: "local-note",
			updatedAt: Date.now(),
		}));
		return result;
	}

	async renameAsset(assetId: string, rawFilename: string, rewriteMarkdownLinks: boolean): Promise<RenameAssetResult> {
		const result: RenameAssetResult = {
			renamed: 0,
			updatedNotes: 0,
			errors: [],
		};
		const asset = this.services.assetRepository.getAssetById(assetId);
		if (!asset) {
			result.errors.push("图片不在索引中。");
			return result;
		}
		const file = this.app.vault.getAbstractFileByPath(asset.filePath);
		if (!(file instanceof TFile)) {
			result.errors.push(`${asset.filename} 不存在。`);
			return result;
		}

		const filename = normalizeRenameFilename(rawFilename, asset.ext);
		if (!filename) {
			result.errors.push("新文件名为空。");
			return result;
		}
		if (filename.includes("/") || filename.includes("\\")) {
			result.errors.push("新文件名不能包含路径分隔符。");
			return result;
		}
		if (!filename.toLowerCase().endsWith(`.${asset.ext.toLowerCase()}`)) {
			result.errors.push(`重命名不能修改图片格式，请保留 .${asset.ext} 后缀。`);
			return result;
		}

		const targetPath = await this.getAvailableMovePath(normalizePath(`${getParentPath(file.path)}/${filename}`), file.path);
		result.sourcePath = file.path;
		result.targetPath = targetPath;
		const references = this.services.assetRepository.getReferencesForAsset(asset.id);
		const operationLog = await this.services.transactionLogService.create("rename", {
			rewriteMarkdownLinks,
			assetId: asset.id,
			filename: asset.filename,
			sourcePath: file.path,
			targetPath,
			referenceCount: references.length,
			affectedNotes: Array.from(new Set(references.map((reference) => reference.sourceNotePath))).sort(),
			preflightErrors: result.errors,
		});
		result.operationLogPath = this.services.transactionLogService.getPath(operationLog);
		if (targetPath === file.path) {
			await this.services.transactionLogService.fail(operationLog, "dry run 无有效重命名动作。", {targetPath});
			result.errors.push("新文件名与当前文件名相同。");
			return result;
		}
		if (result.errors.length > 0) {
			await this.services.transactionLogService.fail(operationLog, "dry run 存在错误，未执行重命名。", {errors: result.errors});
			return result;
		}

		try {
			await this.app.vault.rename(file, targetPath);
			result.renamed = 1;
			await this.services.transactionLogService.appendStep(operationLog, {
				action: "rename-file",
				details: {
					assetId: asset.id,
					from: result.sourcePath,
					to: targetPath,
				},
			});
			await this.services.transactionLogService.appendRollbackStep(operationLog, {
				action: "rename-file",
				details: {
					assetId: asset.id,
					from: targetPath,
					to: result.sourcePath,
				},
			});
		} catch (error) {
			const message = `${asset.filename} 重命名失败：${getErrorMessage(error)}`;
			result.errors.push(message);
			await this.services.transactionLogService.fail(operationLog, message, {sourcePath: result.sourcePath, targetPath});
			return result;
		}

		if (rewriteMarkdownLinks) {
			const renamedFile = this.app.vault.getAbstractFileByPath(targetPath);
			if (renamedFile instanceof TFile) {
				const rewritesByNote = new Map<string, Array<{rawLink: string; newLink: string}>>();
				for (const reference of references) {
					const rewrites = rewritesByNote.get(reference.sourceNotePath) ?? [];
					rewrites.push({
						rawLink: reference.rawLink,
						newLink: this.makeImageMarkdownLink(renamedFile, reference.sourceNotePath),
					});
					rewritesByNote.set(reference.sourceNotePath, rewrites);
				}
				result.updatedNotes = await this.rewriteMovedAssetLinks(rewritesByNote, result.errors, operationLog);
			}
		}

		await this.services.assetRepository.updateAssets([asset.id], (item) => ({
			...item,
			filePath: targetPath,
			filename,
			updatedAt: Date.now(),
		}));
		await this.services.linkGraphService.rebuildReferences();
		if (result.errors.length > 0) {
			await this.services.transactionLogService.fail(operationLog, "重命名完成但链接改写存在错误，已保留回滚步骤。", {errors: result.errors});
		} else {
			await this.services.transactionLogService.commit(operationLog);
		}
		return result;
	}

	async markAssetsDeleteStatus(assetIds: string[], mode: BatchDeleteMode): Promise<BatchDeleteResult> {
		const result: BatchDeleteResult = {
			updated: 0,
			errors: [],
		};
		const nextStatus: Asset["status"] = mode === "archive" ? "archived" : mode === "permanent" ? "missing" : "trash";
		const assets = assetIds
			.map((assetId) => this.services.assetRepository.getAssetById(assetId))
			.filter((asset): asset is Asset => Boolean(asset));
		const missingAssetIds = assetIds.filter((assetId) => !this.services.assetRepository.getAssetById(assetId));
		for (const assetId of missingAssetIds) {
			result.errors.push(`${assetId} 不在索引中。`);
		}

		const operationLog = await this.services.transactionLogService.create("delete", {
			mode,
			totalAssets: assetIds.length,
			preflightErrors: result.errors,
			assets: assets.map((asset) => ({
				assetId: asset.id,
				filename: asset.filename,
				filePath: asset.filePath,
				previousStatus: asset.status,
				nextStatus,
				referenceCount: this.services.assetRepository.getReferencesForAsset(asset.id).length,
				annotationCount: this.services.assetRepository.getAnnotationsForAsset(asset.id).length,
				notePath: asset.notePath,
			})),
		});
		result.operationLogPath = this.services.transactionLogService.getPath(operationLog);
		if (result.errors.length > 0) {
			await this.services.transactionLogService.fail(operationLog, "dry run 存在错误，未执行删除状态变更。", {errors: result.errors});
			return result;
		}

		if (mode === "trash") {
			const trashedAssetIds: string[] = [];
			for (const asset of assets) {
				const file = this.app.vault.getAbstractFileByPath(asset.filePath);
				if (!(file instanceof TFile)) {
					const message = `${asset.filename} 不存在，无法移入回收站。`;
					result.errors.push(message);
					await this.services.transactionLogService.fail(operationLog, message, {assetId: asset.id, filePath: asset.filePath});
					break;
				}

				try {
					await this.app.fileManager.trashFile(file);
					trashedAssetIds.push(asset.id);
					result.updated += 1;
					await this.services.transactionLogService.appendStep(operationLog, {
						action: "trash-file",
						details: {
							assetId: asset.id,
							filePath: asset.filePath,
							respectsUserTrashPreference: true,
						},
					});
					await this.services.transactionLogService.appendRollbackStep(operationLog, {
						action: "manual-restore-from-trash",
						details: {
							assetId: asset.id,
							originalPath: asset.filePath,
							status: asset.status,
						},
					});
				} catch (error) {
					const message = `${asset.filename} 移入回收站失败：${getErrorMessage(error)}`;
					result.errors.push(message);
					await this.services.transactionLogService.fail(operationLog, message, {assetId: asset.id, filePath: asset.filePath});
					break;
				}
			}

			if (trashedAssetIds.length > 0) {
				await this.services.assetRepository.updateAssets(trashedAssetIds, (asset) => ({
					...asset,
					status: "trash",
					updatedAt: Date.now(),
				}));
				await this.services.transactionLogService.appendStep(operationLog, {
					action: "mark-asset-delete-status",
					details: {
						mode,
						assetIds: trashedAssetIds,
					},
				});
				await this.services.linkGraphService.rebuildReferences();
			}
		} else if (mode === "permanent") {
			const deletedAssetIds: string[] = [];
			for (const asset of assets) {
				const file = this.app.vault.getAbstractFileByPath(asset.filePath);
				if (!(file instanceof TFile)) {
					const message = `${asset.filename} 不存在，无法永久删除。`;
					result.errors.push(message);
					await this.services.transactionLogService.fail(operationLog, message, {assetId: asset.id, filePath: asset.filePath});
					break;
				}

				try {
					// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Permanent delete is guarded by the DELETE confirmation flow.
					await this.app.vault.delete(file, true);
					deletedAssetIds.push(asset.id);
					result.updated += 1;
					await this.services.transactionLogService.appendStep(operationLog, {
						action: "permanent-delete-file",
						details: {
							assetId: asset.id,
							filePath: asset.filePath,
							notePath: asset.notePath,
							referenceCount: this.services.assetRepository.getReferencesForAsset(asset.id).length,
						},
					});
					await this.services.transactionLogService.appendRollbackStep(operationLog, {
						action: "manual-restore-from-backup",
						details: {
							assetId: asset.id,
							originalPath: asset.filePath,
							previousStatus: asset.status,
						},
					});
				} catch (error) {
					const message = `${asset.filename} 永久删除失败：${getErrorMessage(error)}`;
					result.errors.push(message);
					await this.services.transactionLogService.fail(operationLog, message, {assetId: asset.id, filePath: asset.filePath});
					break;
				}
			}

			if (deletedAssetIds.length > 0) {
				await this.services.assetRepository.updateAssets(deletedAssetIds, (asset) => ({
					...asset,
					status: "missing",
					updatedAt: Date.now(),
				}));
				await this.services.transactionLogService.appendStep(operationLog, {
					action: "mark-asset-permanent-delete-status",
					details: {
						assetIds: deletedAssetIds,
						nextStatus,
					},
				});
				await this.services.linkGraphService.rebuildReferences();
			}
		} else {
			await this.services.assetRepository.updateAssets(assetIds, (asset) => ({
				...asset,
				status: nextStatus,
				updatedAt: Date.now(),
			}));
			result.updated = assets.length;
			await this.services.transactionLogService.appendStep(operationLog, {
				action: "mark-asset-delete-status",
				details: {
					mode,
					assetIds,
				},
			});
			await this.services.transactionLogService.appendRollbackStep(operationLog, {
				action: "restore-asset-status",
				details: {
					assets: assets.map((asset) => ({
						assetId: asset.id,
						status: asset.status,
					})),
				},
			});
		}
		if (result.errors.length > 0) {
			await this.services.transactionLogService.fail(operationLog, "删除操作部分失败，已保留事务日志。", {errors: result.errors});
		} else {
			await this.services.transactionLogService.commit(operationLog);
		}
		return result;
	}

	async restoreTrashedAssets(assetIds: string[]): Promise<RestoreTrashResult> {
		const result: RestoreTrashResult = {
			restored: 0,
			errors: [],
		};
		const assets = assetIds
			.map((assetId) => this.services.assetRepository.getAssetById(assetId))
			.filter((asset): asset is Asset => Boolean(asset));
		const missingAssetIds = assetIds.filter((assetId) => !this.services.assetRepository.getAssetById(assetId));
		for (const assetId of missingAssetIds) {
			result.errors.push(`${assetId} 不在索引中。`);
		}
		const operationLog = await this.services.transactionLogService.create("delete", {
			mode: "restore-trash",
			totalAssets: assetIds.length,
			preflightErrors: result.errors,
			assets: assets.map((asset) => ({
				assetId: asset.id,
				filename: asset.filename,
				filePath: asset.filePath,
				status: asset.status,
			})),
		});
		result.operationLogPath = this.services.transactionLogService.getPath(operationLog);

		const restoredAssetIds: string[] = [];
		for (const asset of assets) {
			if (asset.status !== "trash") {
				result.errors.push(`${asset.filename} 不在回收站中。`);
				continue;
			}

			const originalFile = this.app.vault.getAbstractFileByPath(asset.filePath);
			if (originalFile instanceof TFile) {
				restoredAssetIds.push(asset.id);
				result.restored += 1;
				await this.services.transactionLogService.appendStep(operationLog, {
					action: "restore-index-status",
					details: {
						assetId: asset.id,
						filePath: asset.filePath,
					},
				});
				continue;
			}

			const localTrashPath = await this.findLocalTrashPath(asset);
			if (!localTrashPath) {
				result.errors.push(`${asset.filename} 未在原路径或本地 .trash 中找到，请先从系统回收站恢复到 ${asset.filePath}。`);
				continue;
			}

			try {
				await this.ensureVaultFolder(asset.filePath.substring(0, asset.filePath.lastIndexOf("/")));
				await this.app.vault.adapter.rename(localTrashPath, asset.filePath);
				restoredAssetIds.push(asset.id);
				result.restored += 1;
				await this.services.transactionLogService.appendStep(operationLog, {
					action: "restore-file-from-local-trash",
					details: {
						assetId: asset.id,
						from: localTrashPath,
						to: asset.filePath,
					},
				});
				await this.services.transactionLogService.appendRollbackStep(operationLog, {
					action: "trash-file",
					details: {
						assetId: asset.id,
						from: asset.filePath,
						to: localTrashPath,
					},
				});
			} catch (error) {
				result.errors.push(`${asset.filename} 恢复失败：${getErrorMessage(error)}`);
			}
		}

		if (restoredAssetIds.length > 0) {
			await this.services.assetRepository.updateAssets(restoredAssetIds, (asset) => ({
				...asset,
				status: "active",
				updatedAt: Date.now(),
			}));
			await this.services.linkGraphService.rebuildReferences();
		}
		if (result.errors.length > 0) {
			await this.services.transactionLogService.fail(operationLog, "回收站恢复存在错误。", {errors: result.errors});
		} else {
			await this.services.transactionLogService.commit(operationLog);
		}
		return result;
	}

	private registerVaultEvents(): void {
		this.registerEvent(this.app.vault.on("create", (file) => {
			void this.services.assetIndexer.handleCreate(file);
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			void this.services.assetIndexer.handleModify(file);
			if (file instanceof TFile && file.extension === "md") {
				void this.services.linkGraphService.rebuildReferences();
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			void this.handleVaultRename(file, oldPath);
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			void this.services.assetIndexer.handleDelete(file);
			void this.services.linkGraphService.rebuildReferences();
		}));
	}

	private async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
		await this.services.assetIndexer.handleRename(file, oldPath);
		if (file instanceof TFile && file.extension === "md") {
			await this.services.assetRepository.migrateNotePath(oldPath, file.path);
			this.migrateActiveLinkedNotePath(oldPath, file.path);
		} else if (file instanceof TFolder) {
			await this.services.assetRepository.migrateFolderPath(oldPath, file.path);
			this.migrateActiveLinkedFolderPath(oldPath, file.path);
		}
		await this.services.linkGraphService.rebuildReferences();
	}

	private registerNoteImageEntry(): void {
		this.registerMarkdownPostProcessor((element, context) => {
			this.attachNoteImageToolbars(element, context);
		});
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => {
			const sourcePath = info.file?.path;
			if (!sourcePath) {
				return;
			}
			this.addEditorImageMenuEntries(menu, editor, sourcePath);
		}));
	}

	private registerFileMenuEntries(): void {
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (file instanceof TFile && file.extension === "md") {
				menu.addSeparator();
				menu.addItem((item) => item
					.setTitle("显示本笔记图片")
					.setIcon("images")
					.onClick(() => {
						void this.activateView().then(() => this.showNoteCollection(file.path));
					}));
				const folderPath = getParentPath(file.path);
				if (folderPath) {
					menu.addItem((item) => item
						.setTitle("显示本目录图片")
						.setIcon("folder-search")
						.onClick(() => {
							void this.activateView().then(() => this.showFolderCollection(folderPath));
						}));
				}
				return;
			}

			if (file instanceof TFolder) {
				menu.addSeparator();
				menu.addItem((item) => item
					.setTitle("显示本目录图片")
					.setIcon("folder-search")
					.onClick(() => {
						void this.activateView().then(() => this.showFolderCollection(file.path));
					}));
			}
		}));
	}

	private attachNoteImageToolbars(element: HTMLElement, context: MarkdownPostProcessorContext): void {
		const images = Array.from(element.querySelectorAll<HTMLImageElement>("img"));
		for (const image of images) {
			if (image.dataset.mediaVaultToolbar === "true") {
				continue;
			}
			image.dataset.mediaVaultToolbar = "true";
			const asset = this.resolveAssetForRenderedImage(image, context.sourcePath);
			if (!asset) {
				this.attachUnindexedImageToolbar(image, context.sourcePath);
				continue;
			}
			this.attachIndexedImageToolbar(image, asset);
		}
	}

	private attachIndexedImageToolbar(image: HTMLImageElement, asset: Asset): void {
		const wrapper = wrapRenderedImage(image);
		const toolbar = wrapper.createDiv({cls: "media-vault-note-image-toolbar"});
		const open = toolbar.createEl("button", {text: PLUGIN_DISPLAY_NAME});
		open.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.openAssetDetailInGallery(asset.id);
		});
		const detail = toolbar.createEl("button", {text: "详情"});
		detail.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.openAssetDetailInGallery(asset.id);
		});
		const copy = toolbar.createEl("button", {text: "复制链接"});
		copy.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.copyAssetWikiLink(asset);
		});
		const refs = toolbar.createEl("button", {text: "显示引用"});
		refs.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.openAssetDetailInGallery(asset.id, "references");
		});
		this.registerDomEvent(wrapper, "contextmenu", (event) => {
			this.showNoteImageMenu(event, asset);
		});
	}

	private attachNoteImageAnnotations(wrapper: HTMLElement, asset: Asset): void {
		const annotations = this.services.assetRepository.getAnnotationsForAsset(asset.id);
		if (annotations.length === 0) {
			return;
		}

		const layer = wrapper.createDiv({cls: "media-vault-note-annotation-layer"});
		const popover = wrapper.createDiv({cls: "media-vault-note-annotation-popover"});
		popover.createDiv({cls: "media-vault-note-annotation-title", text: `区域标注 ${annotations.length}`});
		for (const annotation of annotations) {
			const linkStatus = this.getAnnotationLinkStatus(annotation, asset.notePath ?? asset.filePath);
			const color = getAnnotationColor(annotation.color);
			const box = layer.createEl("button", {cls: "media-vault-note-annotation-box"});
			box.addClass(`is-link-${linkStatus.state}`);
			box.style.setProperty("--media-vault-annotation-color", color);
			box.style.left = `${annotation.x * 100}%`;
			box.style.top = `${annotation.y * 100}%`;
			box.style.width = `${annotation.width * 100}%`;
			box.style.height = `${annotation.height * 100}%`;
			box.setAttr("aria-label", `${annotation.label}，${linkStatus.label}`);
			box.createSpan({text: annotation.label});
			box.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.openAnnotationFromNote(annotation, asset);
			});

			const item = popover.createEl("button", {cls: "media-vault-note-annotation-item"});
			item.addClass(`is-link-${linkStatus.state}`);
			item.style.setProperty("--media-vault-annotation-color", color);
			const label = item.createSpan({cls: "media-vault-note-annotation-label"});
			label.createSpan({cls: "media-vault-annotation-color-dot"});
			label.createSpan({text: annotation.label});
			item.createSpan({cls: "media-vault-note-annotation-text", text: annotation.text ?? this.buildAnnotationLinkText(annotation) ?? "未绑定说明"});
			item.createSpan({cls: `media-vault-note-annotation-status is-${linkStatus.state}`, text: linkStatus.label});
			item.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.openAnnotationFromNote(annotation, asset);
			});
		}
	}

	private async openAnnotationFromNote(annotation: Annotation, asset: Asset): Promise<void> {
		if (annotation.linkedNotePath) {
			await this.openAnnotationTarget(annotation, asset.notePath ?? asset.filePath);
			return;
		}
		await this.openAssetDetailInGallery(asset.id);
	}

	private async promoteRenderedImageToAssetLibrary(image: HTMLImageElement, sourcePath: string): Promise<void> {
		const target = this.getRenderedImageLocalTarget(image);
		if (!target) {
			new Notice("未找到可加入图库的本地图片路径。");
			return;
		}
		const file = this.resolveLocalImageFileTarget(target, sourcePath);
		if (!file) {
			new Notice(isExternalImageTarget(target) ? "暂不支持将外部图片 URL 直接加入图库。" : "未找到本地图片文件。");
			return;
		}
		await this.promoteImageFileToAssetLibrary(file, true);
	}

	private getRenderedImageLocalTarget(image: HTMLImageElement): string | null {
		for (const raw of [
			image.getAttribute("alt") ?? "",
			image.getAttribute("src") ?? "",
			image.currentSrc ?? "",
		]) {
			const target = cleanPluginMarkdownImageTarget(raw);
			if (target && !isExternalImageTarget(target)) {
				return target;
			}
		}
		return null;
	}

	private resolveLocalImageFileTarget(target: string, sourcePath: string): TFile | null {
		if (isExternalImageTarget(target)) {
			return null;
		}

		const linkedFile = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
		if (linkedFile instanceof TFile && isSupportedImagePath(linkedFile.path)) {
			return linkedFile;
		}

		const cleanTarget = normalizePath(stripLeadingSlash(target));
		for (const candidate of [
			cleanTarget,
			normalizePath(`${getParentPath(sourcePath)}/${cleanTarget}`),
		]) {
			const file = this.app.vault.getAbstractFileByPath(candidate);
			if (file instanceof TFile && isSupportedImagePath(file.path)) {
				return file;
			}
		}

		const basenameMatches = this.app.vault.getFiles()
			.filter((file) => isSupportedImagePath(file.path) && getFilename(file.path) === getFilename(cleanTarget));
		return basenameMatches.length === 1 ? basenameMatches[0] ?? null : null;
	}

	private async promoteImageFileToAssetLibrary(file: TFile, openDetail: boolean): Promise<void> {
		await this.services.assetIndexer.handleCreate(file);
		await this.services.linkGraphService.rebuildReferences();
		const asset = this.services.assetRepository.getAssetByPath(file.path);
		if (!asset) {
			new Notice("图片已加入索引，但资产记录暂未可用，请重建索引。");
			return;
		}
		if (openDetail) {
			await this.openAssetDetailInGallery(asset.id);
		}
		new Notice("已加入图库。");
	}

	private async importImageFiles(files: File[]): Promise<void> {
		const imageFiles = files.filter((file) => isSupportedImagePath(file.name));
		if (imageFiles.length === 0) {
			new Notice("没有选择支持的图片文件。");
			return;
		}

		const importedPaths: string[] = [];
		const errors: string[] = [];
		const reservedPaths = new Set<string>();
		for (const file of imageFiles) {
			try {
				const arrayBuffer = await file.arrayBuffer();
				const targetPath = await this.getImportTargetPath(file, arrayBuffer, reservedPaths);
				reservedPaths.add(targetPath);
				await this.ensureVaultFolder(getParentPath(targetPath));
				const createdFile = await this.app.vault.createBinary(targetPath, arrayBuffer);
				await this.services.assetIndexer.handleCreate(createdFile);
				importedPaths.push(createdFile.path);
			} catch (error) {
				errors.push(`${file.name} 导入失败：${getErrorMessage(error)}`);
			}
		}

		if (importedPaths.length > 0) {
			await this.services.linkGraphService.rebuildReferences();
			await this.activateView();
			const firstAsset = this.services.assetRepository.getAssetByPath(importedPaths[0] ?? "");
			if (firstAsset) {
				this.openAssetDetail(firstAsset.id);
			}
		}

		if (errors.length > 0) {
			new Notice(`导入 ${importedPaths.length} 张，失败 ${errors.length} 张。`);
			return;
		}
		new Notice(`已导入 ${importedPaths.length} 张图片。`);
	}

	private async getImportTargetPath(file: File, arrayBuffer: ArrayBuffer, reservedPaths: Set<string>): Promise<string> {
		const ext = getFileExtension(file.name) || "png";
		const now = new Date();
		const directory = renderImportTemplate(this.settings.globalAssetDirectoryTemplate || "Assets/Images/{{YYYY}}/{{MM}}/", now, file, ext);
		const hash8 = await getArrayBufferHash8(arrayBuffer);
		const filename = renderImportTemplate(this.settings.imageNamingTemplate || "{{type}}_{{date}}_{{hash8}}_{{slug}}.{{ext}}", now, file, ext, hash8);
		const targetPath = normalizePath(`${directory}/${filename}`);
		return this.getAvailableMovePath(targetPath, "", reservedPaths);
	}

	private attachUnindexedImageToolbar(image: HTMLImageElement, sourcePath: string): void {
		const wrapper = wrapRenderedImage(image);
		const toolbar = wrapper.createDiv({cls: "media-vault-note-image-toolbar"});
		const rebuild = toolbar.createEl("button", {text: "加入图库"});
		rebuild.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.promoteRenderedImageToAssetLibrary(image, sourcePath);
		});
	}

	private showNoteImageMenu(event: MouseEvent, asset: Asset): void {
		event.preventDefault();
		event.stopPropagation();
		const menu = new Menu();
		menu.addItem((item) => item
			.setTitle(`在 ${PLUGIN_DISPLAY_NAME} 中显示`)
			.setIcon("images")
			.onClick(() => void this.openAssetDetailInGallery(asset.id)));
		menu.addItem((item) => item
			.setTitle("打开图片详情")
			.setIcon("panel-right-open")
			.onClick(() => void this.openAssetDetailInGallery(asset.id)));
				menu.addItem((item) => item
					.setTitle("复制素材链接")
				.setIcon("copy")
				.onClick(() => void this.copyAssetWikiLink(asset)));
			menu.addItem((item) => item
				.setTitle("复制文件路径")
				.setIcon("clipboard")
				.onClick(() => void this.copyAssetPath(asset)));
			menu.addItem((item) => item
				.setTitle("在文件管理器中显示")
				.setIcon("folder-search")
				.onClick(() => void this.showAssetInFileManager(asset)));
			menu.addItem((item) => item
				.setTitle("外部打开")
				.setIcon("external-link")
				.onClick(() => void this.openAssetWithDefaultApp(asset)));
			menu.addItem((item) => item
				.setTitle("查看所有引用")
				.setIcon("links-coming-in")
			.onClick(() => void this.openAssetDetailInGallery(asset.id, "references")));
		menu.showAtMouseEvent(event);
	}

	private addEditorImageMenuEntries(menu: Menu, editor: Editor, sourcePath: string): void {
		const asset = this.resolveAssetForEditorCursor(editor, sourcePath);
		if (!asset) {
			return;
		}

		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle("打开图片详情")
			.setIcon("panel-right-open")
			.onClick(() => void this.openAssetDetailInGallery(asset.id)));
			menu.addItem((item) => item
				.setTitle("显示图片引用")
			.setIcon("links-coming-in")
			.onClick(() => void this.openAssetDetailInGallery(asset.id, "references")));
		menu.addItem((item) => item
			.setTitle("复制 wiki 链接")
			.setIcon("copy")
			.onClick(() => void this.copyAssetWikiLink(asset)));
	}

	private resolveAssetForRenderedImage(image: HTMLImageElement, sourcePath: string): Asset | undefined {
		const references = this.services.assetRepository.getReferencesForNote(sourcePath);
		if (references.length === 0) {
			return undefined;
		}

		const alt = safeDecode(image.getAttribute("alt") ?? "");
		const src = safeDecode(image.currentSrc || image.getAttribute("src") || "");
		const normalizedNeedles = normalizeImageNeedles([alt, src]);
		for (const reference of references) {
			const asset = this.services.assetRepository.getAssetById(reference.assetId);
			if (!asset) {
				continue;
			}
			const candidates = normalizeImageNeedles([asset.filePath, asset.filename, reference.rawLink, reference.resolvedPath ?? ""]);
			if (candidates.some((candidate) => normalizedNeedles.some((needle) => needle.includes(candidate) || candidate.includes(needle)))) {
				return asset;
			}
		}

		if (references.length === 1) {
			return this.services.assetRepository.getAssetById(references[0]?.assetId);
		}
		return undefined;
	}

	private resolveAssetForEditorCursor(editor: Editor, sourcePath: string): Asset | undefined {
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		const target = findImageTargetNearCursor(line, cursor.ch);
		if (!target || isExternalImageTarget(target)) {
			return undefined;
		}
		return this.resolveIndexedAssetTarget(target, sourcePath);
	}

	private resolveIndexedAssetTarget(target: string, sourcePath: string): Asset | undefined {
		const linkedFile = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
		if (linkedFile instanceof TFile) {
			const linkedAsset = this.services.assetRepository.getAssets().find((asset) => asset.filePath === linkedFile.path);
			if (linkedAsset) {
				return linkedAsset;
			}
		}

		const cleanTarget = normalizePath(stripLeadingSlash(target));
		const assets = this.services.assetRepository.getAssets();
		const exact = assets.find((asset) => asset.filePath === cleanTarget);
		if (exact) {
			return exact;
		}

		const relative = assets.find((asset) => asset.filePath === normalizePath(`${getParentPath(sourcePath)}/${cleanTarget}`));
		if (relative) {
			return relative;
		}

		const basenameMatches = assets.filter((asset) => getFilename(asset.filePath) === getFilename(cleanTarget));
		return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
	}

	private buildDefaultAssetNote(asset: Asset): string {
		return [
			"---",
			"type: asset",
			`asset_id: ${asset.id}`,
			`file: ${asset.filePath}`,
			"tags: []",
			"collections: []",
			"annotations: []",
			"---",
			"",
			`# ${asset.filename}`,
			"",
			"## 说明",
			"",
			"## 引用",
			"",
		].join("\n");
	}

	private buildAnnotationLinkText(annotation: Annotation): string | null {
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

		const heading = annotation.linkedHeading?.trim().replace(/^#/, "");
		const blockId = annotation.linkedBlockId?.trim().replace(/^\^/, "");
		if (!linkText.includes("#") && heading) {
			linkText = `${linkText}#${heading}`;
		}
		if (!linkText.includes("^") && blockId) {
			linkText = `${linkText}^${blockId}`;
		}
		return linkText;
	}

	private getAnnotationLinkStatus(annotation: Annotation, sourcePath: string): AnnotationLinkStatus {
		const linkText = this.buildAnnotationLinkText(annotation);
		if (!linkText) {
			return {
				state: "none",
				label: "未绑定",
				linkText: null,
			};
		}

		const parsed = parsePluginAnnotationLinkTarget(linkText);
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
			};
		}
		if (parsed.heading && !pluginHeadingExists(cache?.headings ?? [], parsed.heading)) {
			return {
				state: "missing-heading",
				label: "标题不存在",
				linkText,
			};
		}

		return {
			state: "ok",
			label: parsed.heading || parsed.blockId ? "目标可跳转" : "笔记存在",
			linkText,
		};
	}

	private toAssetNoteAnnotationEntry(annotation: Annotation): AssetNoteAnnotationEntry {
		const entry: AssetNoteAnnotationEntry = {
			id: annotation.id,
			label: annotation.label,
			rect: {
				x: annotation.x,
				y: annotation.y,
				width: annotation.width,
				height: annotation.height,
			},
			color: getAnnotationColor(annotation.color),
		};
		if (annotation.text) {
			entry.text = annotation.text;
		}
		const link = this.buildAnnotationLinkText(annotation);
		if (link) {
			entry.link = link;
		}
		return entry;
	}

	private async ensureAssetNoteForAnnotationSync(assetId: string): Promise<Asset | undefined> {
		let asset = this.services.assetRepository.getAssetById(assetId);
		if (!asset) {
			return undefined;
		}
		if (asset.notePath) {
			return asset;
		}

		const notePath = this.getAssetNotePath(asset);
		await this.ensureVaultFolder(notePath.substring(0, notePath.lastIndexOf("/")));
		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (!(existing instanceof TFile)) {
			await this.app.vault.create(notePath, this.buildDefaultAssetNote(asset));
		}
		await this.services.assetRepository.updateAssets([asset.id], (item) => ({
			...item,
			notePath,
			updatedAt: Date.now(),
		}));
		asset = this.services.assetRepository.getAssetById(assetId);
		return asset;
	}

	private async findLocalTrashPath(asset: Asset): Promise<string | null> {
		const candidates = [
			normalizePath(`.trash/${asset.filename}`),
			normalizePath(`.trash/${asset.filePath}`),
		];
		for (const candidate of candidates) {
			const stat = await this.app.vault.adapter.stat(candidate);
			if (stat?.type === "file") {
				return candidate;
			}
		}
		return null;
	}

	private getAssetNotePath(asset: Asset): string {
		const directory = normalizePath(this.settings.assetNoteDirectory || "Assets/Asset Notes");
		return normalizePath(`${directory}/${asset.id}.md`);
	}

	private async ensureVaultFolder(folderPath: string): Promise<void> {
		const normalized = normalizePath(folderPath);
		if (!normalized) {
			return;
		}
		const parts = normalized.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!await this.app.vault.adapter.exists(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	private async getAvailableMovePath(targetPath: string, currentPath: string, reservedPaths: Set<string> = new Set()): Promise<string> {
		if (targetPath === currentPath) {
			return targetPath;
		}
		if (!reservedPaths.has(targetPath) && !await this.app.vault.adapter.exists(targetPath)) {
			return targetPath;
		}

		const slashIndex = targetPath.lastIndexOf("/");
		const directory = slashIndex >= 0 ? targetPath.slice(0, slashIndex + 1) : "";
		const filename = slashIndex >= 0 ? targetPath.slice(slashIndex + 1) : targetPath;
		const dotIndex = filename.lastIndexOf(".");
		const basename = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
		const extension = dotIndex >= 0 ? filename.slice(dotIndex) : "";
		for (let index = 1; index < 1000; index += 1) {
			const candidate = normalizePath(`${directory}${basename}-${index}${extension}`);
			if (candidate === currentPath || (!reservedPaths.has(candidate) && !await this.app.vault.adapter.exists(candidate))) {
				return candidate;
			}
		}
		return targetPath;
	}

	private makeImageMarkdownLink(file: TFile, sourcePath: string): string {
		const link = this.app.fileManager.generateMarkdownLink(file, sourcePath);
		return link.startsWith("!") ? link : `!${link}`;
	}

	private async rewriteMovedAssetLinks(rewritesByNote: Map<string, Array<{rawLink: string; newLink: string}>>, errors: string[], operationLog?: OperationLog): Promise<number> {
		let updatedNotes = 0;
		for (const [notePath, rewrites] of rewritesByNote) {
			const note = this.app.vault.getAbstractFileByPath(notePath);
			if (!(note instanceof TFile)) {
				errors.push(`${notePath} 不存在，无法改写引用。`);
				continue;
			}

			try {
				const original = await this.app.vault.read(note);
				let next = original;
				for (const rewrite of rewrites) {
					next = next.split(rewrite.rawLink).join(rewrite.newLink);
				}
				if (next !== original) {
					await this.app.vault.modify(note, next);
					updatedNotes += 1;
					if (operationLog) {
						await this.services.transactionLogService.appendStep(operationLog, {
							action: "rewrite-markdown-links",
							details: {
								notePath,
								replacements: rewrites,
							},
						});
						await this.services.transactionLogService.appendRollbackStep(operationLog, {
							action: "rewrite-markdown-links",
							details: {
								notePath,
								replacements: rewrites.map((rewrite) => ({
									rawLink: rewrite.newLink,
									newLink: rewrite.rawLink,
								})),
							},
						});
					}
				}
			} catch (error) {
				errors.push(`${notePath} 改写失败：${getErrorMessage(error)}`);
			}
		}
		return updatedNotes;
	}

	private registerTaskStatusBar(): void {
		const item = this.addStatusBarItem();
		item.addClass("media-vault-task-status");
		item.setAttr("aria-label", `打开 ${PLUGIN_DISPLAY_NAME} 任务中心`);
		this.taskStatusBarItem = item;
		this.registerDomEvent(item, "click", () => {
			void this.openTaskCenter();
		});
		this.unsubscribeJobQueue = this.services.jobQueue.subscribe(() => this.renderTaskStatusBar());
		this.renderTaskStatusBar();
	}

	private renderTaskStatusBar(): void {
		const item = this.taskStatusBarItem;
		if (!item) {
			return;
		}
		const jobs = this.services.jobQueue.getJobs();
		const activeCount = jobs.filter((job) => job.status === "running" || job.status === "queued" || job.status === "paused").length;
		const failedCount = jobs.filter((job) => job.status === "failed").length;
		item.classList.toggle("is-active", activeCount > 0);
		item.classList.toggle("is-failed", failedCount > 0);
		if (failedCount > 0) {
			item.setText(`${PLUGIN_DISPLAY_NAME} 失败 ${failedCount}`);
			return;
		}
		if (activeCount > 0) {
			item.setText(`${PLUGIN_DISPLAY_NAME} 任务 ${activeCount}`);
			return;
		}
		item.setText("任务中心");
	}

	private getOrCreateLeftLeaf(viewType: string): WorkspaceLeaf {
		return this.app.workspace.getLeavesOfType(viewType)[0]
			?? this.app.workspace.getLeftLeaf(false)
			?? this.app.workspace.getLeftLeaf(true)
			?? this.app.workspace.getLeaf(true);
	}

	private getOrCreateRightLeaf(viewType: string): WorkspaceLeaf {
		return this.app.workspace.getLeavesOfType(viewType)[0]
			?? this.app.workspace.getRightLeaf(false)
			?? this.app.workspace.getRightLeaf(true)
			?? this.app.workspace.getLeaf(true);
	}

	private getOrCreateGalleryLeaf(): WorkspaceLeaf {
		return this.app.workspace.getLeavesOfType(MEDIA_VAULT_VIEW_TYPE)
			.find((leaf) => leaf.getRoot() === this.app.workspace.rootSplit)
			?? this.app.workspace.getLeaf("tab");
	}

	private notifyUiStateChanged(): void {
		for (const listener of this.uiStateListeners) {
			listener();
		}
	}

	private migrateActiveLinkedNotePath(oldPath: string, newPath: string): void {
		let changed = false;
		if (this.activeNavQuery?.linkedByNote === oldPath) {
			this.activeNavQuery = {
				...this.activeNavQuery,
				linkedByNote: newPath,
			};
			changed = true;
		}
		if (changed) {
			this.notifyUiStateChanged();
		}
	}

	private migrateActiveLinkedFolderPath(oldPath: string, newPath: string): void {
		if (!this.activeNavQuery) {
			return;
		}
		let changed = false;
		const nextQuery = {...this.activeNavQuery};
		if (nextQuery.linkedByFolder) {
			const nextFolder = replacePluginPathPrefix(nextQuery.linkedByFolder, oldPath, newPath);
			if (nextFolder) {
				nextQuery.linkedByFolder = nextFolder;
				changed = true;
			}
		}
		if (nextQuery.linkedByNote) {
			const nextNote = replacePluginPathPrefix(nextQuery.linkedByNote, oldPath, newPath);
			if (nextNote) {
				nextQuery.linkedByNote = nextNote;
				changed = true;
			}
		}
		if (!changed) {
			return;
		}

		this.activeNavQuery = nextQuery;
		this.notifyUiStateChanged();
	}
}

declare module "obsidian" {
	interface Workspace {
		getLeftLeaf(split: boolean): WorkspaceLeaf | null;
		getRightLeaf(split: boolean): WorkspaceLeaf | null;
	}
}

function clonePluginAssetQuery(query: AssetQuery | null | undefined): AssetQuery | null {
	if (!query) {
		return null;
	}

	return {
		keyword: query.keyword,
		keywordMode: query.keywordMode,
		linkedByNote: query.linkedByNote,
		linkedByFolder: query.linkedByFolder,
		formats: query.formats ? [...query.formats] : undefined,
		origin: query.origin ? [...query.origin] : undefined,
		status: query.status ? [...query.status] : undefined,
		minSizeKb: query.minSizeKb,
		maxSizeKb: query.maxSizeKb,
		minWidth: query.minWidth,
		maxWidth: query.maxWidth,
		minHeight: query.minHeight,
		maxHeight: query.maxHeight,
		ratio: query.ratio,
		tags: query.tags ? [...query.tags] : undefined,
		collections: query.collections ? [...query.collections] : undefined,
		ratingGte: query.ratingGte,
		referenced: query.referenced,
		minReferenceCount: query.minReferenceCount,
		colors: query.colors ? [...query.colors] : undefined,
		createdAfter: query.createdAfter,
		createdBefore: query.createdBefore,
		modifiedAfter: query.modifiedAfter,
		modifiedBefore: query.modifiedBefore,
	};
}

function getPluginAssetQueryKey(query: AssetQuery | null): string {
	return query ? JSON.stringify(query) : "";
}

function replacePluginPathPrefix(pathValue: string, oldPrefix: string, newPrefix: string): string | null {
	const normalizedOld = normalizePath(oldPrefix).replace(/\/+$/, "");
	const normalizedNew = normalizePath(newPrefix).replace(/\/+$/, "");
	if (pathValue === normalizedOld) {
		return normalizedNew;
	}
	if (!pathValue.startsWith(`${normalizedOld}/`)) {
		return null;
	}
	return `${normalizedNew}${pathValue.slice(normalizedOld.length)}`;
}

function renderImportTemplate(template: string, date: Date, file: File, ext: string, hash8 = ""): string {
	const originalName = file.name.replace(/\.[^.]+$/, "");
	const values: Record<string, string> = {
		YYYY: String(date.getFullYear()),
		MM: String(date.getMonth() + 1).padStart(2, "0"),
		DD: String(date.getDate()).padStart(2, "0"),
		date: formatImportDate(date),
		type: "image",
		hash8: hash8 || String(date.getTime()).slice(-8),
		slug: slugifyImportName(originalName) || "image",
		ext,
	};
	return normalizePath(template.replace(/\{\{(\w+)}}/g, (_match, key: string) => values[key] ?? ""));
}

function renderLocalAttachmentDirectory(template: string, note: TFile): string {
	const noteFilename = getFilename(note.path);
	const noteName = noteFilename.replace(/\.md$/i, "");
	const parentPath = getParentPath(note.path);
	const values: Record<string, string> = {
		noteName,
		noteFilename,
		noteFolder: parentPath,
	};
	const rendered = normalizePath((template || "{{noteName}}.assets/").replace(/\{\{(\w+)}}/g, (_match, key: string) => values[key] ?? ""));
	if (!rendered) {
		return joinVaultPath(parentPath, `${noteName}.assets`);
	}
	if (template.trim().startsWith("/")) {
		return normalizePath(stripLeadingSlash(rendered));
	}
	if (template.includes("{{noteFolder}}") || (parentPath && rendered.startsWith(`${parentPath}/`))) {
		return normalizePath(rendered);
	}
	return joinVaultPath(parentPath, rendered);
}

function formatImportDate(date: Date): string {
	return [
		String(date.getFullYear()),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

function slugifyImportName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

async function getArrayBufferHash8(arrayBuffer: ArrayBuffer): Promise<string> {
	if (!window.crypto?.subtle) {
		return "";
	}
	const digest = await window.crypto.subtle.digest("SHA-256", arrayBuffer);
	return Array.from(new Uint8Array(digest.slice(0, 4)))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function normalizeRenameFilename(rawFilename: string, ext: string): string {
	const trimmed = rawFilename.trim();
	if (!trimmed) {
		return "";
	}
	if (trimmed.includes(".")) {
		return trimmed;
	}
	return `${trimmed}.${ext}`;
}

function wrapRenderedImage(image: HTMLImageElement): HTMLElement {
	const existingWrapper = image.closest<HTMLElement>(".media-vault-note-image-wrapper");
	if (existingWrapper) {
		return existingWrapper;
	}

	const target = image.parentElement?.tagName.toLowerCase() === "a" ? image.parentElement : image;
	const parent = target.parentElement;
	if (!parent) {
		return image;
	}

	const wrapper = document.createElement("span");
	wrapper.addClass("media-vault-note-image-wrapper");
	parent.insertBefore(wrapper, target);
	wrapper.appendChild(target);
	return wrapper;
}

function findImageTargetNearCursor(line: string, cursorCh: number): string | null {
	const matches: Array<{target: string; start: number; end: number}> = [];
	for (const match of line.matchAll(/!\[\[([^\]]+)\]\]/g)) {
		matches.push({
			target: cleanPluginWikiImageTarget(match[1] ?? ""),
			start: match.index ?? 0,
			end: (match.index ?? 0) + (match[0]?.length ?? 0),
		});
	}
	for (const match of line.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
		matches.push({
			target: cleanPluginMarkdownImageTarget(match[1] ?? ""),
			start: match.index ?? 0,
			end: (match.index ?? 0) + (match[0]?.length ?? 0),
		});
	}
	for (const match of line.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
		matches.push({
			target: cleanPluginMarkdownImageTarget(match[1] ?? ""),
			start: match.index ?? 0,
			end: (match.index ?? 0) + (match[0]?.length ?? 0),
		});
	}

	if (matches.length === 0) {
		return null;
	}

	const containing = matches.find((match) => cursorCh >= match.start && cursorCh <= match.end);
	if (containing) {
		return containing.target;
	}

	return matches.length === 1 ? matches[0]?.target ?? null : null;
}

function cleanPluginWikiImageTarget(target: string): string {
	return stripQueryAndHash(target
		.split("|")[0]
		?.split("#")[0]
		?.trim() ?? "");
}

function cleanPluginMarkdownImageTarget(target: string): string {
	const withoutTitle = target.trim().split(/\s+["'][^"']*["']$/)[0] ?? target.trim();
	return stripQueryAndHash(safeDecode(withoutTitle));
}

function isExternalImageTarget(target: string): boolean {
	return /^(https?:|data:|file:)/i.test(target.trim());
}

function normalizeImageNeedles(values: string[]): string[] {
	return values
		.map((value) => stripQueryAndHash(value).toLowerCase().trim())
		.filter((value) => value.length > 0)
		.flatMap((value) => {
			const parts = [value];
			const lastSlash = value.lastIndexOf("/");
			if (lastSlash >= 0) {
				parts.push(value.slice(lastSlash + 1));
			}
			return parts;
		});
}

function stripQueryAndHash(value: string): string {
	return value.split("#")[0]?.split("?")[0] ?? value;
}

function countOccurrences(text: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	let count = 0;
	let index = text.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = text.indexOf(needle, index + needle.length);
	}
	return count;
}

function parsePluginAnnotationLinkTarget(linkText: string): ParsedAnnotationLinkTarget {
	const withoutAlias = linkText.split("|")[0] ?? linkText;
	const blockSplit = withoutAlias.split("^");
	const beforeBlock = blockSplit[0] ?? "";
	const blockId = normalizePluginText(blockSplit[1]);
	const headingSplit = beforeBlock.split("#");
	const path = normalizePluginText(headingSplit[0]);
	const heading = normalizePluginText(headingSplit.slice(1).join("#"));
	return {
		path,
		heading: heading || undefined,
		blockId: blockId || undefined,
	};
}

function pluginHeadingExists(headings: Array<{heading: string}>, targetHeading: string): boolean {
	const normalizedTarget = stripHeadingForLink(targetHeading).toLowerCase();
	return headings.some((heading) => stripHeadingForLink(heading.heading).toLowerCase() === normalizedTarget);
}

function normalizePluginText(value: string | undefined): string {
	return (value ?? "").trim();
}

function getAnnotationColor(value: string | undefined): string {
	if (!value) {
		return DEFAULT_ANNOTATION_COLOR;
	}
	const color = value.trim();
	return /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_ANNOTATION_COLOR;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function getElectronShell(): ElectronShell | null {
	const maybeRequire = (window as WindowWithOptionalRequire).require;
	if (!maybeRequire) {
		return null;
	}

	try {
		const electron = maybeRequire("electron") as ElectronModule;
		return electron.shell ?? null;
	} catch {
		return null;
	}
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
