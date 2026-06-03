import {App, ItemView, MarkdownRenderer, Menu, Modal, Notice, setIcon, stripHeadingForLink, TFile, WorkspaceLeaf} from "obsidian";
import {MEDIA_VAULT_VIEW_TYPE, PLUGIN_DISPLAY_NAME} from "../constants";
import type MediaVaultPlugin from "../main";
import type {BatchDeleteMode, MediaVaultDetailMode, MediaVaultDetailPanelId} from "../main";
import {ANNOTATION_COLOR_SWATCHES, DEFAULT_ANNOTATION_COLOR, type Annotation, type AnnotationStorageMode, type Asset, type AssetReference, type Collection} from "../types/asset";
import {DEFAULT_GALLERY_DISPLAY_FIELDS} from "../settings/defaults";
import type {MediaVaultGalleryDisplayField, MediaVaultGallerySortOption as SortOption, MediaVaultGalleryViewMode as GalleryViewMode} from "../types/gallery";
import type {OperationLog} from "../types/operation-log";
import type {AssetQuery, QuickFilterId} from "../types/query";
import type {OcrRect, OcrResult} from "../types/ocr";
import {formatDate, formatDateTime, formatFileSize} from "../utils/image-utils";
import {createEmptySmartCondition, getDefaultOperator, getDefaultValue, type SmartCollectionDraft, type SmartCondition, type SmartConditionField, type SmartConditionOperator} from "../services/collection-service";
import {getDuplicateAssetIds, getDuplicateCandidates, getDuplicateGroups, type DuplicateGroup} from "../services/search-service";
import type {SimilarityCandidate, SimilaritySortOption} from "../services/similarity-service";
import {getParentPath, joinVaultPath} from "../utils/path-utils";
import {formatReferenceLocation} from "../utils/reference-utils";
import type {BatchOperationDraft, BatchConvertFormat} from "../types/batch";
import {loadBatchOperationDraft, saveBatchOperationDraft} from "../storage/plugin-data-store";
import {parseAssetNoteMetadata} from "../utils/asset-note-metadata";
import {getOcrAverageConfidence, getProviderLabel} from "../services/ocr-service";

interface VirtualGridLayout {
	columns: number;
	cardWidth: number;
	cardHeight: number;
	previewHeight: number;
	gap: number;
	leftInset: number;
	rowStride: number;
}

interface MasonryLayout {
	columns: number;
	cardWidth: number;
	gap: number;
	leftInset: number;
}

interface MasonryItem {
	asset: Asset;
	x: number;
	y: number;
	cardHeight: number;
	previewHeight: number;
}

interface GalleryScrollAnchor {
	assetId: string;
	viewportOffset: number;
}

interface CurrentNoteReferenceImpact {
	notePath: string | null;
	referenceCount: number;
	assetCount: number;
}

interface MasonryInteractionScrollLock {
	scrollTop: number;
	anchor: GalleryScrollAnchor | null;
	expiresAt: number;
}

interface FilterChip {
	label: string;
	remove: () => void;
}

interface ClientSelectionRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

const GRID_BASE_CARD_WIDTH = 216;
const GRID_BASE_PREVIEW_HEIGHT = 152;
const GRID_GAP = 8;
const GRID_OVERSCAN_ROWS = 3;
const COMPACT_BASE_CARD_WIDTH = 136;
const COMPACT_BASE_PREVIEW_HEIGHT = 112;
const COMPACT_GAP = 6;
const GALLERY_EDGE_PADDING = 6;
const GALLERY_CARD_MIN_WIDTH_RATIO = 0.82;
const GALLERY_CARD_MAX_WIDTH_RATIO = 1.32;
const MASONRY_BASE_CARD_WIDTH = 216;
const MASONRY_GAP = 8;
const MASONRY_MIN_PREVIEW_HEIGHT = 126;
const MASONRY_MAX_PREVIEW_HEIGHT = 292;
const MASONRY_INTERACTION_SCROLL_LOCK_MS = 1200;
const MASONRY_RATIO_REFRESH_DEBOUNCE_MS = 150;
const MASONRY_RATIO_REFRESH_SCROLL_IDLE_MS = 250;
const DEFAULT_ASPECT_RATIO = 1.45;
const DETAIL_ZOOM_MIN = 0.1;
const DETAIL_ZOOM_MAX = 32;
const DETAIL_ZOOM_STEP = 0.2;
const DETAIL_ZOOM_WHEEL_FACTOR = 1.12;
const THUMBNAIL_SCALE_MIN = 0.8;
const THUMBNAIL_SCALE_MAX = 1.4;
const ANNOTATION_MIN_SIZE = 0.03;
const FILTER_FORMATS = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
const SORT_OPTIONS: Array<{id: SortOption; label: string}> = [
	{id: "mtime-desc", label: "最新优先"},
	{id: "mtime-asc", label: "最旧优先"},
	{id: "name-asc", label: "名称 A-Z"},
	{id: "size-desc", label: "大文件优先"},
	{id: "references-desc", label: "引用最多"},
];
const GALLERY_LAYOUT_OPTIONS: Array<{id: GalleryViewMode; label: string; icon: string; description: string}> = [
	{id: "masonry", label: "自适应", icon: "▦", description: "按图片比例自适应排列"},
	{id: "grid", label: "网格", icon: "▧", description: "统一缩略图尺寸"},
	{id: "list", label: "列表", icon: "☰", description: "表格化查看元数据"},
	{id: "compact", label: "紧凑", icon: "▩", description: "高密度缩略图墙"},
];
const GALLERY_DISPLAY_FIELD_OPTIONS: Array<{id: MediaVaultGalleryDisplayField; label: string}> = [
	{id: "filename", label: "文件名"},
	{id: "description", label: "简介"},
	{id: "extension", label: "扩展名"},
	{id: "dimensions", label: "尺寸"},
	{id: "size", label: "大小"},
	{id: "tags", label: "标签"},
	{id: "rating", label: "评分"},
	{id: "references", label: "引用数"},
	{id: "mtime", label: "修改时间"},
	{id: "path", label: "路径"},
];
const SIMILARITY_SORT_OPTIONS: Array<{id: SimilaritySortOption; label: string}> = [
	{id: "similarity-desc", label: "相似度"},
	{id: "references-desc", label: "引用次数"},
	{id: "size-desc", label: "文件大小"},
];
const SMART_CONDITION_FIELDS: Array<{id: SmartConditionField; label: string}> = [
	{id: "tag", label: "标签"},
	{id: "rating", label: "评分"},
	{id: "linked", label: "被引用于"},
	{id: "used-in-folder", label: "使用目录"},
	{id: "format", label: "格式"},
	{id: "width", label: "宽度"},
	{id: "height", label: "高度"},
	{id: "size", label: "大小 KB"},
	{id: "collection", label: "集合"},
	{id: "color", label: "颜色"},
	{id: "unused", label: "未引用"},
	{id: "source", label: "来源"},
	{id: "has-ocr", label: "有 OCR"},
	{id: "has-annotation", label: "有标注"},
];
const SMART_CONDITION_OPERATORS: Array<{id: SmartConditionOperator; label: string}> = [
	{id: "contains", label: "包含"},
	{id: "equals", label: "等于"},
	{id: "gte", label: "大于等于"},
	{id: "lte", label: "小于等于"},
	{id: "exists", label: "存在"},
];

const BOOLEAN_SMART_FIELDS = new Set<SmartConditionField>(["unused", "has-ocr", "has-annotation"]);

type NumericQueryField = "minSizeKb" | "maxSizeKb" | "minWidth" | "maxWidth" | "minHeight" | "maxHeight" | "minReferenceCount" | "ratingGte";
type DateQueryField = "createdAfter" | "createdBefore" | "modifiedAfter" | "modifiedBefore";
type DetailTabId = MediaVaultDetailPanelId;
type DeleteMode = "trash" | "archive" | "permanent";
type BatchRiskLevel = "low" | "medium" | "high";
type BatchFocusField = "addTags" | "addCollections" | "moveToFolder" | "convert" | null;
type AnnotationLinkState = "none" | "ok" | "missing-note" | "missing-heading" | "missing-block";
type AnnotationResizeHandle = "nw" | "ne" | "sw" | "se";
type AnnotationTransformMode = "move" | AnnotationResizeHandle;
type AssetNoteViewMode = "edit" | "preview";

interface BatchPreflightItem {
	asset: Asset;
	referenceNotes: string[];
	referenceCount: number;
	annotationCount: number;
	variantCount: number;
	targetPath?: string;
	markdownRewriteCount: number;
	proposedAction: string;
	riskLevel: BatchRiskLevel;
	warnings: string[];
}

interface BatchNoteRewritePlan {
	notePath: string;
	rewriteCount: number;
}

interface BatchPreflightResult {
	totalAssets: number;
	referencedAssets: number;
	affectedNotes: number;
	annotatedAssets: number;
	annotationCount: number;
	variantAssets: number;
	variantCount: number;
	brokenLinksIfNotRewrite: number;
	plannedMoves: number;
	plannedMarkdownLinkRewrites: number;
	plannedRollbackSteps: number;
	newCollections: number;
	noteRewritePlans: BatchNoteRewritePlan[];
	warnings: string[];
	errors: string[];
	steps: string[];
	items: BatchPreflightItem[];
}

interface GraphNodeData {
	label: string;
	detail?: string;
	onClick?: () => void;
}

interface AnnotationDraft {
	label: string;
	text: string;
	linkedNotePath: string;
	linkedHeading: string;
	linkedBlockId: string;
	storageMode: AnnotationStorageMode;
	color: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

interface AnnotationRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface AnnotationLinkStatus {
	state: AnnotationLinkState;
	label: string;
	linkText: string | null;
	targetPath?: string;
}

interface ParsedAnnotationLinkTarget {
	path: string;
	heading?: string;
	blockId?: string;
}

export class MediaVaultView extends ItemView {
	private readonly plugin: MediaVaultPlugin;
	private unsubscribeRepository: (() => void) | null = null;
	private unsubscribeUiState: (() => void) | null = null;
	private focusedAssetId: string | null = null;
	private quickFilter: QuickFilterId;
	private activeCollectionId: string | null = null;
	private navQuery: AssetQuery | null = null;
	private navQueryKey = "";
	private viewMode: GalleryViewMode = "masonry";
	private sortOption: SortOption = "mtime-desc";
	private thumbnailScale = 1;
	private searchText = "";
	private appliedQuery: AssetQuery = {};
	private appliedQuerySource: "manual" | "nav" | "collection" = "manual";
	private draftQuery: AssetQuery = {};
	private filterDrawerOpen = false;
	private layoutPopoverOpen = false;
	private smartBuilderOpen = false;
	private smartBuilderDraft: SmartCollectionDraft;
	private readonly selectedAssetIds = new Set<string>();
	private lastSelectedAssetId: string | null = null;
	private batchModalOpen = false;
	private deleteRiskModalOpen = false;
	private readonly skippedDuplicateGroupIds = new Set<string>();
	private batchDraft: BatchOperationDraft = createEmptyBatchDraft();
	private batchFocusField: BatchFocusField = null;
	private batchOperationErrors: string[] = [];
	private deleteMode: DeleteMode = "trash";
	private permanentDeleteConfirmText = "";
	private deleteIncludeVariants = false;
	private detailAssetId: string | null = null;
	private detailMode: MediaVaultDetailMode = "detail";
	private focusedAnnotationId: string | null = null;
	private detailTab: DetailTabId = "overview";
	private similaritySourceAssetId: string | null = null;
	private similarityThreshold = 90;
	private similaritySortOption: SimilaritySortOption = "similarity-desc";
	private similarityKeepAssetId: string | null = null;
	private detailZoom = 1;
	private detailPanX = 0;
	private detailPanY = 0;
	private previewAssetId: string | null = null;
	private previewZoom = 1;
	private previewPanX = 0;
	private previewPanY = 0;
	private previewRotation = 0;
	private previewFlipX = false;
	private previewFlipY = false;
	private previewInvert = false;
	private assetNoteAssetId: string | null = null;
	private assetNoteContent = "";
	private assetNoteSavedContent = "";
	private assetNoteViewMode: AssetNoteViewMode = "edit";
	private selectedAnnotationId: string | null = null;
	private annotationDraft = createEmptyAnnotationDraft();
	private suppressNextAnnotationClick = false;
	private ocrDraftAssetId: string | null = null;
	private ocrDraftText = "";
	private ocrDraftLanguage = "auto";
	private selectedOcrBlockIndex: number | null = null;
	private gridScrollTop = 0;
	private pendingScrollFrame: number | null = null;
	private protectedScrollTop: number | null = null;
	private protectedScrollAnchor: GalleryScrollAnchor | null = null;
	private masonryInteractionScrollLock: MasonryInteractionScrollLock | null = null;
	private pendingScrollRestoreFrame: number | null = null;
	private lastKnownGalleryWidth = 0;
	private virtualGalleryEl: HTMLDivElement | null = null;
	private virtualSpacerEl: HTMLDivElement | null = null;
	private virtualAssets: Asset[] = [];
	private virtualFocusedAssetId: string | null = null;
	private readonly virtualRenderedCards = new Map<string, HTMLDivElement>();
	private galleryResizeObserver: ResizeObserver | null = null;
	private pendingGalleryResizeFrame: number | null = null;
	private readonly imageAspectRatios = new Map<string, number>();
	private cachedMasonryResult: {items: MasonryItem[]; height: number} | null = null;
	private cachedMasonryKey = "";
	private readonly pendingRatioUpdates = new Set<string>();
	private ratioRefreshTimeout: number | null = null;
	private lastGalleryScrollAt = 0;

	constructor(leaf: WorkspaceLeaf, plugin: MediaVaultPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.quickFilter = plugin.getQuickFilter();
		this.sortOption = plugin.getActiveGallerySortOption();
		this.viewMode = plugin.getActiveGalleryViewMode();
		this.navQuery = plugin.getNavQuery();
		this.navQueryKey = getQueryKey(this.navQuery);
		this.smartBuilderDraft = plugin.services.collectionService.createDraft();
		this.annotationDraft = this.createAnnotationDraft();
	}

	getViewType(): string {
		return MEDIA_VAULT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return PLUGIN_DISPLAY_NAME;
	}

	getIcon(): string {
		return "images";
	}

	async onOpen(): Promise<void> {
		this.activeCollectionId = this.plugin.getActiveCollectionId();
		this.sortOption = this.plugin.getActiveGallerySortOption();
		this.viewMode = this.plugin.getActiveGalleryViewMode();
		this.navQuery = this.plugin.getNavQuery();
		this.navQueryKey = getQueryKey(this.navQuery);
		this.detailAssetId = this.plugin.getDetailAsset()?.id ?? null;
		this.detailMode = this.plugin.getDetailMode();
		this.detailTab = this.plugin.getDetailPanel();
		this.focusedAnnotationId = this.plugin.getFocusedAnnotationId();
		this.applyPluginFilterSource();
		await this.restoreSavedBatchDraft();
		this.unsubscribeRepository = this.plugin.services.assetRepository.subscribe(() => this.render());
		this.unsubscribeUiState = this.plugin.subscribeUiState(() => {
			const nextQuickFilter = this.plugin.getQuickFilter();
			const nextCollectionId = this.plugin.getActiveCollectionId();
			const nextNavQuery = this.plugin.getNavQuery();
			const nextNavQueryKey = getQueryKey(nextNavQuery);
			const nextFocusedAssetId = this.plugin.getFocusedAsset()?.id ?? null;
			const nextDetailAssetId = this.plugin.getDetailAsset()?.id ?? null;
			const nextDetailMode = this.plugin.getDetailMode();
			const nextDetailTab = this.plugin.getDetailPanel();
			const nextFocusedAnnotationId = this.plugin.getFocusedAnnotationId();
			if (nextDetailAssetId !== this.detailAssetId || nextDetailMode !== this.detailMode || nextDetailTab !== this.detailTab) {
				if (nextDetailAssetId !== this.detailAssetId) {
					this.resetDetailViewport();
				}
				this.detailAssetId = nextDetailAssetId;
				this.detailMode = nextDetailMode;
				this.detailTab = nextDetailTab;
				this.focusedAnnotationId = nextFocusedAnnotationId;
				this.applyFocusedAnnotationFromPlugin(nextDetailAssetId, nextFocusedAnnotationId);
				this.focusedAssetId = nextFocusedAssetId;
				this.render();
				return;
			}
			if (nextQuickFilter !== this.quickFilter || nextCollectionId !== this.activeCollectionId || nextNavQueryKey !== this.navQueryKey) {
				this.quickFilter = nextQuickFilter;
				this.activeCollectionId = nextCollectionId;
				this.navQuery = nextNavQuery;
				this.navQueryKey = nextNavQueryKey;
				this.similaritySourceAssetId = null;
				this.similarityKeepAssetId = null;
				this.applyPluginFilterSource();
				this.clearSelection(false);
				this.gridScrollTop = 0;
				this.focusedAssetId = nextFocusedAssetId;
				this.render();
				return;
			}

			if (nextFocusedAssetId !== this.focusedAssetId) {
				this.focusedAssetId = nextFocusedAssetId;
				this.virtualFocusedAssetId = nextFocusedAssetId;
				this.updateFocusedAssetHighlight();
			}
			if (nextFocusedAnnotationId !== this.focusedAnnotationId) {
				this.focusedAnnotationId = nextFocusedAnnotationId;
				if (this.applyFocusedAnnotationFromPlugin(nextDetailAssetId, nextFocusedAnnotationId)) {
					this.render();
				}
			}
		});
		this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => this.handleGlobalKeydown(event));
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribeRepository?.();
		this.unsubscribeRepository = null;
		this.unsubscribeUiState?.();
		this.unsubscribeUiState = null;
		if (this.pendingScrollFrame !== null) {
			window.cancelAnimationFrame(this.pendingScrollFrame);
			this.pendingScrollFrame = null;
		}
		if (this.pendingScrollRestoreFrame !== null) {
			window.cancelAnimationFrame(this.pendingScrollRestoreFrame);
			this.pendingScrollRestoreFrame = null;
		}
		if (this.pendingGalleryResizeFrame !== null) {
			window.cancelAnimationFrame(this.pendingGalleryResizeFrame);
			this.pendingGalleryResizeFrame = null;
		}
		this.galleryResizeObserver?.disconnect();
		this.galleryResizeObserver = null;
		if (this.ratioRefreshTimeout !== null) {
			window.clearTimeout(this.ratioRefreshTimeout);
			this.ratioRefreshTimeout = null;
		}
		this.pendingRatioUpdates.clear();
	}

	private handleGlobalKeydown(event: KeyboardEvent): void {
		const target = event.target;
		if (this.previewAssetId) {
			if (isTextEntryTarget(target)) {
				return;
			}
			if (event.key === "Escape" || event.key === " " || event.key === "Spacebar") {
				event.preventDefault();
				event.stopPropagation();
				this.closeAssetPreview();
				return;
			}
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				event.stopPropagation();
				this.navigatePreviewAsset(-1);
				return;
			}
			if (event.key === "ArrowRight") {
				event.preventDefault();
				event.stopPropagation();
				this.navigatePreviewAsset(1);
				return;
			}
			if (event.key === "+" || event.key === "=") {
				event.preventDefault();
				this.adjustPreviewZoom(DETAIL_ZOOM_STEP);
				return;
			}
			if (event.key === "-") {
				event.preventDefault();
				this.adjustPreviewZoom(-DETAIL_ZOOM_STEP);
				return;
			}
			if (event.key === "0") {
				event.preventDefault();
				this.resetPreviewViewport();
				this.syncPreviewViewportElements(this.contentEl);
				return;
			}
		}

		if (target instanceof Node && !this.contentEl.contains(target)) {
			return;
		}

		if (this.isAnnotationEditMode()) {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.cancelCurrentAnnotationDraft();
				return;
			}
			if ((event.key === "Delete" || event.key === "Backspace") && this.selectedAnnotationId && !isTextEntryTarget(target)) {
				const asset = this.plugin.getDetailAsset();
				const selectedAnnotation = asset ? this.getSelectedAnnotation(asset) : undefined;
				if (selectedAnnotation) {
					event.preventDefault();
					event.stopPropagation();
					this.deleteAnnotation(selectedAnnotation);
				}
				return;
			}
		}

		const detailAsset = this.plugin.getDetailAsset();
		if (detailAsset && !isTextEntryTarget(target)) {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.confirmAssetNoteLeave(detailAsset, () => this.plugin.closeAssetDetail());
				return;
			}
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				event.stopPropagation();
				this.navigateDetailAssetByDelta(detailAsset, -1);
				return;
			}
			if (event.key === "ArrowRight") {
				event.preventDefault();
				event.stopPropagation();
				this.navigateDetailAssetByDelta(detailAsset, 1);
				return;
			}
			if (event.key === "+" || event.key === "=") {
				event.preventDefault();
				this.adjustDetailZoom(DETAIL_ZOOM_STEP);
				return;
			}
			if (event.key === "-") {
				event.preventDefault();
				this.adjustDetailZoom(-DETAIL_ZOOM_STEP);
				return;
			}
			if (event.key === "0") {
				event.preventDefault();
				this.resetDetailViewport();
				this.render();
				return;
			}
			if (event.key === "1") {
				event.preventDefault();
				this.detailZoom = 1;
				this.detailPanX = 0;
				this.detailPanY = 0;
				this.render();
				return;
			}
		}

		if (event.key === "Escape" && this.selectedAssetIds.size > 0) {
			this.clearSelection();
		}

		if (!detailAsset && !isTextEntryTarget(target) && (event.key === " " || event.key === "Spacebar")) {
			const asset = this.getPreviewTargetAsset();
			if (asset) {
				event.preventDefault();
				event.stopPropagation();
				this.openAssetPreview(asset.id);
			}
		}
	}

	focusAsset(assetId: string): void {
		const gallery = this.virtualGalleryEl;
		const currentScrollTop = gallery ? this.readGalleryScrollTopForFocus(gallery) : this.gridScrollTop;
		const lockedScroll = this.getActiveMasonryInteractionScrollLock();
		const scrollAnchor = gallery ? (lockedScroll?.anchor ?? this.captureGalleryScrollAnchor(gallery, assetId)) : null;
		this.protectGalleryScroll(currentScrollTop, scrollAnchor);
		this.focusedAssetId = assetId;
		this.virtualFocusedAssetId = assetId;
		this.updateFocusedAssetHighlight();
		this.plugin.setFocusedAsset(assetId);
		if (gallery && this.viewMode === "masonry" && currentScrollTop > 1) {
			gallery.scrollTop = currentScrollTop;
		}
		this.protectGalleryScroll(currentScrollTop, scrollAnchor);
	}

	openSimilarAssets(assetId: string): void {
		const asset = this.plugin.services.assetRepository.getAssetById(assetId);
		if (!asset) {
			new Notice("目标图片不在索引中。");
			return;
		}
		const jobId = this.plugin.services.jobQueue.startJob({
			type: "similarity",
			assetId,
			label: `查找相似图片：${asset.filename}`,
			total: 1,
			priority: "high",
			details: "使用当前索引中的 SHA-256 和感知 hash 生成候选。",
		});
		this.similaritySourceAssetId = assetId;
		this.similarityKeepAssetId = null;
		this.plugin.setDetailPanel("overview");
		this.gridScrollTop = 0;
		this.clearSelection(false);
		this.plugin.services.jobQueue.completeJob(jobId, "相似图片候选已刷新。");
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.removeClass("media-vault-root");
		root.addClass("media-vault-gallery-root");

		const detailAsset = this.plugin.getDetailAsset();
		if (detailAsset) {
			this.previewAssetId = null;
			const main = root.createDiv({cls: "media-vault-main"});
			this.renderDetailWorkspace(main, detailAsset);
			return;
		}

		const similaritySource = this.getSimilaritySourceAsset();
		if (similaritySource) {
			const main = root.createDiv({cls: "media-vault-main"});
			this.renderSimilarityWorkspace(main, similaritySource);
			return;
		}

		if (this.smartBuilderOpen) {
			const main = root.createDiv({cls: "media-vault-main"});
			this.renderSmartCollectionBuilder(main);
			return;
		}

		this.quickFilter = this.plugin.getQuickFilter();
		const assets = this.getFilteredAssets();
		this.pruneSelection(assets);
		const focusedAsset = this.getFocusedAsset(assets);
		const activeSmartCollection = this.getActiveSmartCollection();

		const main = root.createDiv({cls: "media-vault-main"});
		this.applyGalleryDisplayFieldClasses(main);
		this.renderToolbar(main, assets.length);
		if (activeSmartCollection) {
			this.renderActiveCollectionHeader(main, activeSmartCollection, assets.length);
		} else {
			this.renderFilterChips(main);
		}
		if (this.quickFilter === "duplicates") {
			this.renderDuplicateChecker(main, assets);
		}
		this.renderGallery(main, assets, focusedAsset);
		this.renderBatchBar(main);
		if (this.filterDrawerOpen) {
			this.renderAdvancedFilterDrawer(main);
		}
		if (this.batchModalOpen) {
			this.renderBatchOperationModal(main);
		}
		if (this.deleteRiskModalOpen) {
			this.renderDeleteRiskModal(main);
		}
		if (this.previewAssetId) {
			this.renderPreviewOverlay(main);
		}
	}

	private renderSidebar(root: Element): void {
		const sidebar = root.createDiv({cls: "media-vault-sidebar"});
		sidebar.createDiv({cls: "media-vault-logo", text: PLUGIN_DISPLAY_NAME});

		const allAssets = this.plugin.services.assetRepository.getAssets();
		const activeAssets = allAssets.filter((asset) => asset.status === "active");
		const trashAssets = allAssets.filter((asset) => asset.status === "trash");
		const filters: Array<{id: QuickFilterId; label: string; count: number}> = [
			{id: "all", label: "所有图片", count: activeAssets.length},
			{id: "unreferenced", label: "未引用", count: activeAssets.filter((asset) => asset.referenceCount === 0).length},
			{id: "favorites", label: "收藏", count: activeAssets.filter((asset) => asset.favorite).length},
			{id: "recent", label: "最近修改", count: activeAssets.filter((asset) => Date.now() - asset.mtime <= 30 * 24 * 60 * 60 * 1000).length},
			{id: "duplicates", label: "重复图片", count: getDuplicateAssetIds(activeAssets).size},
			{id: "trash", label: "回收站", count: trashAssets.length},
		];

		sidebar.createDiv({cls: "media-vault-section-title", text: "Collections"});
		for (const filter of filters) {
			const item = sidebar.createDiv({cls: `media-vault-sidebar-item ${this.quickFilter === filter.id ? "is-active" : ""}`});
			item.createSpan({text: filter.label});
			item.createSpan({cls: "media-vault-count", text: String(filter.count)});
			item.addEventListener("click", () => {
				this.quickFilter = filter.id;
				this.gridScrollTop = 0;
				this.render();
			});
		}

		sidebar.createDiv({cls: "media-vault-section-title", text: "状态"});
		sidebar.createDiv({cls: "media-vault-hint", text: "索引、引用和缩略图缓存均可重建。"});
	}

	private renderDetailWorkspace(main: Element, asset: Asset): void {
		this.loadAssetNote(asset);
		this.detailTab = this.plugin.getDetailPanel();

		const layout = main.createDiv({cls: "media-vault-detail-layout"});
		this.renderDetailCenter(layout, asset);
	}

	private renderSimilarityWorkspace(main: Element, source: Asset): void {
		const result = this.plugin.services.similarityService.findSimilarAssets(
			source,
			this.plugin.services.assetRepository.getActiveAssets(),
			this.plugin.services.assetRepository.getAnnotations(),
			this.similarityThreshold,
			this.similaritySortOption,
		);
		const keepAssetId = this.getSimilarityKeepAssetId(result.recommendedAssetId, result.candidates);
		const relatedAssetIds = [source.id, ...result.candidates.map((candidate) => candidate.asset.id)];
		const duplicateTargetIds = relatedAssetIds.filter((assetId) => assetId !== keepAssetId);

		const page = main.createDiv({cls: "media-vault-similarity-page"});
		const toolbar = page.createDiv({cls: "media-vault-similarity-toolbar"});
		const back = toolbar.createEl("button", {text: "返回图库"});
		back.addEventListener("click", () => {
			this.similaritySourceAssetId = null;
			this.similarityKeepAssetId = null;
			this.render();
		});
		const title = toolbar.createDiv({cls: "media-vault-similarity-title"});
		title.createDiv({cls: "media-vault-detail-title", text: "查找相似图片"});
		title.createDiv({cls: "media-vault-similarity-subtitle", text: `源图片：${source.filename}`});

		const controls = toolbar.createDiv({cls: "media-vault-similarity-controls"});
		controls.createSpan({text: `阈值 ${this.similarityThreshold}%`});
		const threshold = controls.createEl("input", {
			type: "range",
			attr: {min: "80", max: "100", step: "1", value: String(this.similarityThreshold)},
		});
		threshold.addEventListener("input", () => {
			this.similarityThreshold = Number(threshold.value);
			this.similarityKeepAssetId = null;
			this.render();
		});
		const sort = controls.createEl("select");
		for (const option of SIMILARITY_SORT_OPTIONS) {
			sort.createEl("option", {
				text: option.label,
				value: option.id,
				attr: {selected: String(option.id === this.similaritySortOption)},
			});
		}
		sort.addEventListener("change", () => {
			this.similaritySortOption = sort.value as SimilaritySortOption;
			this.render();
		});
		const rebuild = controls.createEl("button", {cls: "mod-cta", text: "重新计算"});
		rebuild.addEventListener("click", () => this.openSimilarAssets(source.id));

		const body = page.createDiv({cls: "media-vault-similarity-body"});
		const sourcePanel = body.createDiv({cls: "media-vault-similarity-source"});
		this.renderSimilarityAssetCard(sourcePanel, source, {
			label: "源图片",
			score: 100,
			isKeep: keepAssetId === source.id,
			onKeep: () => {
				this.similarityKeepAssetId = source.id;
				this.render();
			},
		});

		const resultPanel = body.createDiv({cls: "media-vault-similarity-results"});
		const resultHead = resultPanel.createDiv({cls: "media-vault-similarity-section-head"});
		resultHead.createDiv({cls: "media-vault-section-title", text: "相似结果"});
		resultHead.createDiv({cls: "media-vault-similarity-subtitle", text: `${result.candidates.length} 张候选 · 按 ${getSimilaritySortLabel(this.similaritySortOption)} 排序`});
		if (result.candidates.length === 0) {
			resultPanel.createDiv({cls: "media-vault-hint", text: "当前阈值下没有相似候选。降低阈值或重建索引后再试。"});
		} else {
			const grid = resultPanel.createDiv({cls: "media-vault-similarity-grid"});
			for (const candidate of result.candidates) {
				this.renderSimilarityCandidateCard(grid, candidate, keepAssetId);
			}
		}

		const recommendation = body.createDiv({cls: "media-vault-similarity-recommendation"});
		recommendation.createDiv({cls: "media-vault-section-title", text: "保留建议"});
		const keepAsset = this.plugin.services.assetRepository.getAssetById(keepAssetId) ?? source;
		recommendation.createDiv({cls: "media-vault-similarity-keep", text: keepAsset.filename});
		const reasons = this.similarityKeepAssetId ? ["用户已选择该图片作为保留项"] : result.recommendedReasons;
		for (const reason of reasons) {
			recommendation.createDiv({cls: "media-vault-similarity-reason", text: reason});
		}
		const actions = recommendation.createDiv({cls: "media-vault-similarity-actions"});
		const keep = actions.createEl("button", {cls: "mod-cta", text: "保留选中"});
		keep.addEventListener("click", () => {
			this.similarityKeepAssetId = keepAssetId;
			new Notice(`已选择保留：${keepAsset.filename}`);
			this.render();
		});
		const move = actions.createEl("button", {text: "移动到重复图片"});
		move.disabled = duplicateTargetIds.length === 0;
		move.addEventListener("click", () => void this.moveSimilarityCandidatesToDuplicateCollection(duplicateTargetIds));
		const deleteCandidates = actions.createEl("button", {cls: "mod-warning", text: "删除候选"});
		deleteCandidates.disabled = duplicateTargetIds.length === 0;
		deleteCandidates.addEventListener("click", () => this.openDeleteRiskForAssets(duplicateTargetIds));
		const detail = actions.createEl("button", {text: "打开保留项详情"});
		detail.addEventListener("click", () => {
			this.similaritySourceAssetId = null;
			this.similarityKeepAssetId = null;
			void this.plugin.openAssetDetailInGallery(keepAssetId);
		});

		if (this.deleteRiskModalOpen) {
			this.renderDeleteRiskModal(main);
		}
	}

	private renderSimilarityCandidateCard(parent: Element, candidate: SimilarityCandidate, keepAssetId: string): void {
		this.renderSimilarityAssetCard(parent, candidate.asset, {
			label: formatSimilarityKind(candidate.kind),
			score: candidate.score,
			isKeep: keepAssetId === candidate.asset.id,
			reasons: candidate.reasons,
			onKeep: () => {
				this.similarityKeepAssetId = candidate.asset.id;
				this.render();
			},
		});
	}

	private renderSimilarityAssetCard(
		parent: Element,
		asset: Asset,
		options: {label: string; score: number; isKeep: boolean; reasons?: string[]; onKeep: () => void},
	): void {
		const card = parent.createDiv({cls: `media-vault-similarity-card ${options.isKeep ? "is-keep" : ""}`});
		const preview = card.createDiv({cls: "media-vault-similarity-preview"});
		const resourcePath = this.plugin.services.thumbnailService.getResourcePath(asset);
		if (resourcePath) {
			preview.createEl("img", {attr: {src: resourcePath, alt: asset.filename, loading: "lazy", decoding: "async"}});
		}
		preview.createSpan({cls: "media-vault-similarity-score", text: `${options.score}%`});
		const body = card.createDiv({cls: "media-vault-similarity-card-body"});
		body.createDiv({cls: "media-vault-similarity-card-label", text: options.label});
		body.createDiv({cls: "media-vault-similarity-card-title", text: asset.filename});
		body.createDiv({
			cls: "media-vault-similarity-card-meta",
			text: `${formatDimensions(asset)} · ${formatFileSize(asset.sizeBytes)} · ${asset.referenceCount} 引用`,
		});
		if (options.reasons && options.reasons.length > 0) {
			body.createDiv({cls: "media-vault-similarity-card-meta", text: options.reasons.join(" / ")});
		}
		const actions = card.createDiv({cls: "media-vault-similarity-card-actions"});
		const keep = actions.createEl("button", {text: options.isKeep ? "保留项" : "保留此图"});
		keep.disabled = options.isKeep;
		keep.addEventListener("click", options.onKeep);
		const detail = actions.createEl("button", {text: "详情"});
		detail.addEventListener("click", () => {
			this.similaritySourceAssetId = null;
			this.similarityKeepAssetId = null;
			void this.plugin.openAssetDetailInGallery(asset.id);
		});
	}

	private getSimilaritySourceAsset(): Asset | null {
		const asset = this.plugin.services.assetRepository.getAssetById(this.similaritySourceAssetId);
		if (!asset || asset.status !== "active") {
			this.similaritySourceAssetId = null;
			this.similarityKeepAssetId = null;
			return null;
		}
		return asset;
	}

	private getSimilarityKeepAssetId(recommendedAssetId: string, candidates: SimilarityCandidate[]): string {
		const relatedAssetIds = new Set([this.similaritySourceAssetId ?? "", ...candidates.map((candidate) => candidate.asset.id)]);
		if (this.similarityKeepAssetId && relatedAssetIds.has(this.similarityKeepAssetId)) {
			return this.similarityKeepAssetId;
		}
		return recommendedAssetId;
	}

	private async moveSimilarityCandidatesToDuplicateCollection(assetIds: string[]): Promise<void> {
		if (assetIds.length === 0) {
			new Notice("没有需要移动的候选图片。");
			return;
		}
		await this.plugin.services.assetRepository.updateAssets(assetIds, (asset) => ({
			...asset,
			collections: Array.from(new Set([...asset.collections, "重复图片"])),
			updatedAt: Date.now(),
		}));
		new Notice(`已将 ${assetIds.length} 张候选图片加入“重复图片”集合。`);
		this.render();
	}

	private renderSmartCollectionBuilder(main: Element): void {
		const {query, errors} = this.getSmartBuilderQuery();
		const validationErrors = errors.length > 0 ? errors : validateFilterQuery(query);
		const assets = validationErrors.length > 0
			? []
			: sortAssets(this.plugin.services.searchService.filterAssets(this.plugin.services.assetRepository.getActiveAssets(), "all", query), this.sortOption);
		const page = main.createDiv({cls: "media-vault-smart-builder-page"});
		const toolbar = page.createDiv({cls: "media-vault-smart-builder-toolbar"});
		const cancel = toolbar.createEl("button", {text: "取消"});
		cancel.addEventListener("click", () => {
			this.smartBuilderOpen = false;
			this.render();
		});
		const title = toolbar.createDiv({cls: "media-vault-smart-builder-title"});
		title.createDiv({cls: "media-vault-detail-title", text: this.smartBuilderDraft.id ? "编辑 Smart Collection" : "新建 Smart Collection"});
		title.createDiv({cls: "media-vault-smart-builder-subtitle", text: validationErrors.length > 0 ? validationErrors[0] : `实时预览 ${assets.length} 张图片`});
		const save = toolbar.createEl("button", {cls: "mod-cta", text: "保存集合"});
		save.disabled = validationErrors.length > 0 || !this.smartBuilderDraft.name.trim();
		save.addEventListener("click", () => {
			void this.saveSmartBuilderCollection(query, assets.length);
		});

		const content = page.createDiv({cls: "media-vault-smart-builder-content"});
		const form = content.createDiv({cls: "media-vault-smart-builder-form"});
		this.renderSmartBuilderBasics(form);
		this.renderSmartBuilderMode(form, query, validationErrors);

		const preview = content.createDiv({cls: "media-vault-smart-builder-preview"});
		const previewHead = preview.createDiv({cls: "media-vault-smart-builder-preview-head"});
		previewHead.createDiv({cls: "media-vault-section-title", text: "结果预览"});
		previewHead.createSpan({cls: validationErrors.length > 0 ? "media-vault-filter-hit is-error" : "media-vault-filter-hit", text: validationErrors.length > 0 ? "条件有误" : `${assets.length} 项`});
		if (validationErrors.length > 0) {
			preview.createDiv({cls: "media-vault-hint", text: validationErrors.join("；")});
			return;
		}
		if (assets.length === 0) {
			preview.createDiv({cls: "media-vault-hint", text: "没有图片匹配当前条件。"});
			return;
		}
		const grid = preview.createDiv({cls: "media-vault-smart-preview-grid"});
		for (const asset of assets.slice(0, 12)) {
			const item = grid.createEl("button", {cls: "media-vault-smart-preview-item"});
			const resourcePath = this.plugin.services.thumbnailService.getResourcePath(asset);
			if (resourcePath) {
				item.createEl("img", {attr: {src: resourcePath, alt: asset.filename, loading: "lazy", decoding: "async"}});
			}
			item.createSpan({text: asset.filename});
			item.addEventListener("click", () => {
				this.smartBuilderOpen = false;
				void this.plugin.openAssetDetailInGallery(asset.id);
			});
		}
	}

	private renderSmartBuilderBasics(parent: Element): void {
		const basics = parent.createDiv({cls: "media-vault-smart-builder-card"});
		basics.createDiv({cls: "media-vault-section-title", text: "基础信息"});
		const name = this.renderSmartInput(basics, "名称", this.smartBuilderDraft.name, "例如 高分架构图");
		name.addEventListener("change", () => {
			this.smartBuilderDraft.name = name.value;
			this.render();
		});
		const description = basics.createDiv({cls: "media-vault-filter-field"});
		description.createEl("label", {text: "描述"});
		const textarea = description.createEl("textarea", {
			cls: "media-vault-smart-builder-textarea",
			attr: {placeholder: "可选说明，用来解释该集合的使用场景。"},
		});
		textarea.value = this.smartBuilderDraft.description;
		textarea.addEventListener("change", () => {
			this.smartBuilderDraft.description = textarea.value;
			this.render();
		});
		const appearance = basics.createDiv({cls: "media-vault-smart-builder-appearance"});
		const icon = this.renderSmartInput(appearance, "图标", this.smartBuilderDraft.icon, "▧");
		icon.addEventListener("change", () => {
			this.smartBuilderDraft.icon = icon.value.trim() || "▧";
			this.render();
		});
		const colorField = appearance.createDiv({cls: "media-vault-filter-field"});
		colorField.createEl("label", {text: "颜色"});
		const color = colorField.createEl("input", {attr: {type: "color", value: this.smartBuilderDraft.color}});
		color.addEventListener("change", () => {
			this.smartBuilderDraft.color = color.value;
			this.render();
		});
	}

	private renderSmartBuilderMode(parent: Element, query: AssetQuery, validationErrors: string[]): void {
		const card = parent.createDiv({cls: "media-vault-smart-builder-card"});
		const head = card.createDiv({cls: "media-vault-smart-builder-mode-head"});
		head.createDiv({cls: "media-vault-section-title", text: "查询条件"});
		const modes = head.createDiv({cls: "media-vault-smart-builder-mode-switch"});
		const visual = modes.createEl("button", {cls: this.smartBuilderDraft.mode === "visual" ? "is-active" : "", text: "可视化"});
		visual.addEventListener("click", () => {
			this.smartBuilderDraft.mode = "visual";
			this.smartBuilderDraft.conditions = this.plugin.services.collectionService.assetQueryToConditions(query);
			this.render();
		});
		const dsl = modes.createEl("button", {cls: this.smartBuilderDraft.mode === "dsl" ? "is-active" : "", text: "语法"});
		dsl.addEventListener("click", () => {
			this.smartBuilderDraft.mode = "dsl";
			this.smartBuilderDraft.dsl = this.plugin.services.collectionService.stringifySmartQuery(query);
			this.render();
		});
		if (this.smartBuilderDraft.mode === "dsl") {
				const textarea = card.createEl("textarea", {
					cls: "media-vault-smart-builder-dsl",
					attr: {placeholder: "输入查询语法"},
				});
			textarea.value = this.smartBuilderDraft.dsl;
			textarea.addEventListener("change", () => {
				this.smartBuilderDraft.dsl = textarea.value;
				this.render();
			});
		} else {
			this.renderSmartConditionRows(card);
		}
		const syntax = card.createDiv({cls: "media-vault-smart-builder-syntax"});
		syntax.createSpan({text: validationErrors.length > 0 ? "语法预览不可用" : this.plugin.services.collectionService.stringifySmartQuery(query) || "未设置条件"});
	}

	private renderSmartConditionRows(parent: Element): void {
		const rows = parent.createDiv({cls: "media-vault-smart-condition-list"});
		if (this.smartBuilderDraft.conditions.length === 0) {
			rows.createDiv({cls: "media-vault-hint", text: "添加条件后会实时刷新右侧预览。"});
		}
		for (const condition of this.smartBuilderDraft.conditions) {
			this.renderSmartConditionRow(rows, condition);
		}
		const add = parent.createEl("button", {text: "+ 添加条件"});
		add.addEventListener("click", () => {
			this.smartBuilderDraft.conditions.push(createEmptySmartCondition());
			this.render();
		});
	}

	private renderSmartConditionRow(parent: Element, condition: SmartCondition): void {
		const row = parent.createDiv({cls: "media-vault-smart-condition-row"});
		const field = row.createEl("select");
		for (const option of SMART_CONDITION_FIELDS) {
			const optionEl = field.createEl("option", {text: option.label, value: option.id});
			optionEl.selected = condition.field === option.id;
		}
		field.addEventListener("change", () => {
			condition.field = field.value as SmartConditionField;
			condition.operator = getDefaultOperator(condition.field);
			condition.value = getDefaultValue(condition.field);
			this.render();
		});
		const operator = row.createEl("select");
		for (const option of SMART_CONDITION_OPERATORS.filter((item) => isSmartOperatorAvailable(condition.field, item.id))) {
			const optionEl = operator.createEl("option", {text: option.label, value: option.id});
			optionEl.selected = condition.operator === option.id;
		}
		operator.addEventListener("change", () => {
			condition.operator = operator.value as SmartConditionOperator;
			this.render();
		});
		if (BOOLEAN_SMART_FIELDS.has(condition.field)) {
			const value = row.createEl("select");
			for (const option of [
				{label: "是", value: "true"},
				{label: "否", value: "false"},
			]) {
				const optionEl = value.createEl("option", {text: option.label, value: option.value});
				optionEl.selected = (condition.value || "true").toLowerCase() === option.value;
			}
			value.disabled = condition.operator === "exists";
			value.addEventListener("change", () => {
				condition.value = value.value;
				this.render();
			});
		} else {
			const value = row.createEl("input", {
				attr: {
					type: "text",
					value: condition.value,
					placeholder: getSmartConditionPlaceholder(condition.field),
				},
			});
			value.value = condition.value;
			value.disabled = condition.operator === "exists";
			value.addEventListener("change", () => {
				condition.value = value.value;
				this.render();
			});
		}
		const remove = row.createEl("button", {text: "×"});
		remove.addEventListener("click", () => {
			this.smartBuilderDraft.conditions = this.smartBuilderDraft.conditions.filter((item) => item.id !== condition.id);
			this.render();
		});
	}

	private renderSmartInput(parent: Element, label: string, value: string, placeholder: string): HTMLInputElement {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: label});
		const input = field.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "text",
				value,
				placeholder,
			},
		});
		input.value = value;
		return input;
	}

	private getSmartBuilderQuery(): {query: AssetQuery; errors: string[]} {
		if (this.smartBuilderDraft.mode === "dsl") {
			return this.plugin.services.collectionService.parseSmartQueryDsl(this.smartBuilderDraft.dsl);
		}
		return {
			query: this.plugin.services.collectionService.conditionsToAssetQuery(this.smartBuilderDraft.conditions),
			errors: [],
		};
	}

	private async saveSmartBuilderCollection(query: AssetQuery, hitCount: number): Promise<void> {
		const normalized = normalizeQuery(query);
		if (!this.smartBuilderDraft.name.trim()) {
			new Notice("请输入集合名称。");
			return;
		}
		if (isQueryEmpty(normalized)) {
			new Notice("请先设置筛选条件。");
			return;
		}
		const now = Date.now();
		const existing = this.smartBuilderDraft.id
			? this.plugin.services.assetRepository.getCollectionById(this.smartBuilderDraft.id)
			: undefined;
		const collection: Collection = {
			id: existing?.id ?? `smart-${now}`,
			name: this.smartBuilderDraft.name.trim(),
			description: this.smartBuilderDraft.description.trim() || undefined,
			type: "smart",
			icon: this.smartBuilderDraft.icon.trim() || "▧",
			color: this.smartBuilderDraft.color,
			query: normalized as Record<string, unknown>,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		await this.plugin.services.assetRepository.upsertCollection(collection);
		this.searchText = normalized.keyword ?? "";
		this.appliedQuery = removeKeywordFromQuery(normalized);
		this.appliedQuerySource = "collection";
		this.smartBuilderOpen = false;
		this.filterDrawerOpen = false;
		this.gridScrollTop = 0;
		this.plugin.setActiveCollection(collection.id);
		new Notice(`已保存智能集合：${collection.name}，命中 ${hitCount} 张图片。`);
	}

	private renderDetailLeftPanel(parent: Element, asset: Asset): void {
		const left = parent.createDiv({cls: "media-vault-detail-left"});
		left.createDiv({cls: "media-vault-logo", text: "Asset detail"});
		const resourcePath = this.plugin.services.thumbnailService.getResourcePath(asset, "large");
		if (resourcePath) {
			left.createEl("img", {cls: "media-vault-detail-left-preview", attr: {src: resourcePath, alt: asset.filename}});
		}
		left.createDiv({cls: "media-vault-detail-left-title", text: asset.filename});
		this.renderDetailAssetNavigation(left, asset);
		const actions = left.createDiv({cls: "media-vault-detail-left-actions"});
		const back = actions.createEl("button", {text: "返回图库"});
		back.addEventListener("click", () => {
			this.confirmAssetNoteLeave(asset, () => {
				this.plugin.closeAssetDetail();
			});
		});
		const annotate = actions.createEl("button", {text: "新建区域标注"});
		annotate.addEventListener("click", () => {
			this.startNewAnnotationMode(asset);
		});
		if (asset.status === "trash") {
			const restore = actions.createEl("button", {cls: "mod-cta", text: "恢复图片"});
			restore.addEventListener("click", () => {
				void this.restoreAssets([asset.id]);
			});
		}

		this.renderMetaRow(left, "路径", asset.filePath);
		this.renderMetaRow(left, "格式", asset.ext.toUpperCase());
		this.renderMetaRow(left, "大小", formatFileSize(asset.sizeBytes));
		this.renderMetaRow(left, "引用", `${asset.referenceCount} 处`);
	}

	private renderDetailAssetNavigation(parent: Element, asset: Asset): void {
		const assets = this.getDetailNavigationAssets(asset);
		const currentIndex = assets.findIndex((item) => item.id === asset.id);
		if (currentIndex < 0) {
			return;
		}

		const nav = parent.createDiv({cls: "media-vault-detail-asset-nav"});
		nav.createDiv({
			cls: "media-vault-section-title",
			text: "资产导航",
		});
		nav.createDiv({
			cls: "media-vault-detail-asset-nav-count",
			text: `${currentIndex + 1} / ${assets.length}`,
		});
		const controls = nav.createDiv({cls: "media-vault-detail-asset-nav-controls"});
		const previous = controls.createEl("button", {text: "上一张"});
		previous.disabled = currentIndex <= 0;
		previous.addEventListener("click", () => {
			const previousAsset = assets[currentIndex - 1];
			if (previousAsset) {
				this.navigateDetailAsset(asset, previousAsset.id);
			}
		});
		const next = controls.createEl("button", {text: "下一张"});
		next.disabled = currentIndex >= assets.length - 1;
		next.addEventListener("click", () => {
			const nextAsset = assets[currentIndex + 1];
			if (nextAsset) {
				this.navigateDetailAsset(asset, nextAsset.id);
			}
		});
	}

	private getDetailNavigationAssets(asset: Asset): Asset[] {
		const assets = sortAssets(
			this.plugin.services.searchService.filterAssets(
				this.plugin.services.assetRepository.getAssets(),
				this.quickFilter,
				this.getEffectiveQuery(),
			),
			this.sortOption,
		);
		if (assets.some((item) => item.id === asset.id)) {
			return assets;
		}
		return [asset, ...assets];
	}

	private navigateDetailAsset(currentAsset: Asset, nextAssetId: string): void {
			this.confirmAssetNoteLeave(currentAsset, () => {
				this.selectedAnnotationId = null;
				this.annotationDraft = this.createAnnotationDraft();
				this.plugin.openAssetDetail(nextAssetId, this.detailMode);
			});
	}

	private navigateDetailAssetByDelta(currentAsset: Asset, delta: number): void {
		const assets = this.getDetailNavigationAssets(currentAsset);
		const currentIndex = assets.findIndex((item) => item.id === currentAsset.id);
		const nextAsset = currentIndex >= 0 ? assets[currentIndex + delta] : undefined;
		if (!nextAsset) {
			return;
		}
		this.navigateDetailAsset(currentAsset, nextAsset.id);
	}

	private resetDetailViewport(): void {
		this.detailZoom = 1;
		this.detailPanX = 0;
		this.detailPanY = 0;
	}

	private enableDetailCanvasInteractions(canvas: HTMLElement): void {
		canvas.addEventListener("wheel", (event: WheelEvent) => {
			if (isTextEntryTarget(event.target)) {
				return;
			}
			event.preventDefault();
			const nextZoom = event.deltaY > 0
				? this.detailZoom / DETAIL_ZOOM_WHEEL_FACTOR
				: this.detailZoom * DETAIL_ZOOM_WHEEL_FACTOR;
			this.setDetailZoomFromCanvas(canvas, nextZoom, event.clientX, event.clientY);
		});

		canvas.addEventListener("pointerdown", (event: PointerEvent) => {
			if (event.button !== 0 || this.isAnnotationEditMode()) {
				return;
			}
			const target = event.target;
			if (target instanceof HTMLElement && target.closest("button, input, textarea, select, .media-vault-annotation-box")) {
				return;
			}

			event.preventDefault();
			canvas.focus();
			canvas.addClass("is-panning");
			canvas.setPointerCapture(event.pointerId);
			const startX = event.clientX;
			const startY = event.clientY;
			const initialPanX = this.detailPanX;
			const initialPanY = this.detailPanY;
			const stage = canvas.querySelector<HTMLElement>(".media-vault-detail-image-stage");
			const applyPan = (moveEvent: PointerEvent) => {
				this.detailPanX = initialPanX + moveEvent.clientX - startX;
				this.detailPanY = initialPanY + moveEvent.clientY - startY;
				if (stage) {
					stage.style.setProperty("--media-vault-detail-pan-x", `${this.detailPanX}px`);
					stage.style.setProperty("--media-vault-detail-pan-y", `${this.detailPanY}px`);
				}
			};
			const endPan = (endEvent: PointerEvent) => {
				applyPan(endEvent);
				canvas.removeClass("is-panning");
				canvas.removeEventListener("pointermove", applyPan);
				canvas.removeEventListener("pointerup", endPan);
				canvas.removeEventListener("pointercancel", cancelPan);
				if (canvas.hasPointerCapture(endEvent.pointerId)) {
					canvas.releasePointerCapture(endEvent.pointerId);
				}
			};
			const cancelPan = () => {
				canvas.removeClass("is-panning");
				canvas.removeEventListener("pointermove", applyPan);
				canvas.removeEventListener("pointerup", endPan);
				canvas.removeEventListener("pointercancel", cancelPan);
			};
			canvas.addEventListener("pointermove", applyPan);
			canvas.addEventListener("pointerup", endPan);
			canvas.addEventListener("pointercancel", cancelPan);
		});
	}

	private setDetailZoomFromCanvas(canvas: HTMLElement, nextZoom: number, clientX: number, clientY: number): void {
		const oldZoom = this.detailZoom;
		const zoom = roundDetailZoom(clamp(nextZoom, DETAIL_ZOOM_MIN, DETAIL_ZOOM_MAX));
		if (zoom === oldZoom) {
			return;
		}

		const rect = canvas.getBoundingClientRect();
		const anchorX = clientX - rect.left - rect.width / 2;
		const anchorY = clientY - rect.top - rect.height / 2;
		const ratio = zoom / oldZoom;
		this.detailPanX = anchorX - (anchorX - this.detailPanX) * ratio;
		this.detailPanY = anchorY - (anchorY - this.detailPanY) * ratio;
		this.detailZoom = zoom;
		const stage = canvas.querySelector<HTMLElement>(".media-vault-detail-image-stage");
		if (stage) {
			stage.style.setProperty("--media-vault-detail-zoom", String(this.detailZoom));
			stage.style.setProperty("--media-vault-detail-pan-x", `${this.detailPanX}px`);
			stage.style.setProperty("--media-vault-detail-pan-y", `${this.detailPanY}px`);
		}
		const readout = canvas.parentElement?.querySelector<HTMLElement>(".media-vault-detail-zoom-readout");
		if (readout) {
			readout.setText(`${Math.round(this.detailZoom * 100)}%`);
		}
		const zoomBarValue = canvas.querySelector<HTMLElement>(".media-vault-detail-zoom-value");
		if (zoomBarValue) {
			zoomBarValue.setText(`${Math.round(this.detailZoom * 100)}%`);
		}
	}

	private renderDetailMiniMap(parent: Element): void {
		const map = parent.createDiv({cls: "media-vault-detail-minimap"});
		map.createDiv({cls: "media-vault-detail-minimap-paper"});
		map.createDiv({cls: "media-vault-detail-minimap-view"});
		map.createDiv({cls: "media-vault-detail-minimap-label", text: "视口"});
	}

	private openAssetPreview(assetId: string): void {
		const asset = this.plugin.services.assetRepository.getAssetById(assetId);
		if (!asset) {
			return;
		}
		this.previewAssetId = asset.id;
		this.resetPreviewViewport();
		this.focusAsset(asset.id);
		this.render();
	}

	private closeAssetPreview(): void {
		this.previewAssetId = null;
		this.resetPreviewViewport();
		this.render();
	}

	private resetPreviewViewport(): void {
		this.previewZoom = 1;
		this.previewPanX = 0;
		this.previewPanY = 0;
		this.previewRotation = 0;
		this.previewFlipX = false;
		this.previewFlipY = false;
		this.previewInvert = false;
	}

	private getPreviewTargetAsset(): Asset | null {
		const assets = this.getFilteredAssets();
		const selected = assets.find((asset) => this.selectedAssetIds.has(asset.id));
		if (selected) {
			return selected;
		}
		return this.getFocusedAsset(assets) ?? null;
	}

	private getPreviewNavigationAssets(asset: Asset): Asset[] {
		const assets = this.getFilteredAssets();
		if (assets.some((item) => item.id === asset.id)) {
			return assets;
		}
		return [asset, ...assets];
	}

	private navigatePreviewAsset(delta: number): void {
		if (!this.previewAssetId) {
			return;
		}
		const asset = this.plugin.services.assetRepository.getAssetById(this.previewAssetId);
		if (!asset) {
			this.closeAssetPreview();
			return;
		}
		const assets = this.getPreviewNavigationAssets(asset);
		const currentIndex = assets.findIndex((item) => item.id === asset.id);
		const nextAsset = currentIndex >= 0 ? assets[currentIndex + delta] : undefined;
		if (!nextAsset) {
			return;
		}
		this.previewAssetId = nextAsset.id;
		this.resetPreviewViewport();
		this.focusAsset(nextAsset.id);
		this.render();
	}

	private adjustPreviewZoom(delta: number): void {
		this.previewZoom = roundDetailZoom(clamp(this.previewZoom + delta, DETAIL_ZOOM_MIN, DETAIL_ZOOM_MAX));
		this.syncPreviewViewportElements(this.contentEl);
	}

	private rotatePreview(degrees: number): void {
		this.previewRotation = normalizeDegrees(this.previewRotation + degrees);
		this.syncPreviewViewportElements(this.contentEl);
	}

	private togglePreviewFlipX(): void {
		this.previewFlipX = !this.previewFlipX;
		this.syncPreviewViewportElements(this.contentEl);
	}

	private togglePreviewFlipY(): void {
		this.previewFlipY = !this.previewFlipY;
		this.syncPreviewViewportElements(this.contentEl);
	}

	private togglePreviewInvert(): void {
		this.previewInvert = !this.previewInvert;
		this.syncPreviewViewportElements(this.contentEl);
	}

	private enablePreviewCanvasInteractions(canvas: HTMLElement): void {
		let suppressBlankClose = false;

		canvas.addEventListener("click", (event: MouseEvent) => {
			if (suppressBlankClose) {
				suppressBlankClose = false;
				return;
			}
			if (event.target === canvas) {
				event.preventDefault();
				event.stopPropagation();
				this.closeAssetPreview();
			}
		});

		canvas.addEventListener("wheel", (event: WheelEvent) => {
			if (isTextEntryTarget(event.target)) {
				return;
			}
			event.preventDefault();
			const nextZoom = event.deltaY > 0
				? this.previewZoom / DETAIL_ZOOM_WHEEL_FACTOR
				: this.previewZoom * DETAIL_ZOOM_WHEEL_FACTOR;
			this.setPreviewZoomFromCanvas(canvas, nextZoom, event.clientX, event.clientY);
		}, {passive: false});

		canvas.addEventListener("pointerdown", (event: PointerEvent) => {
			if (event.button !== 0) {
				return;
			}
			const target = event.target;
			if (target instanceof HTMLElement && target.closest("button")) {
				return;
			}

			event.preventDefault();
			canvas.focus();
			canvas.addClass("is-panning");
			canvas.setPointerCapture(event.pointerId);
			const startX = event.clientX;
			const startY = event.clientY;
			const initialPanX = this.previewPanX;
			const initialPanY = this.previewPanY;
			let didDrag = false;
			const applyPan = (moveEvent: PointerEvent) => {
				if (Math.abs(moveEvent.clientX - startX) > 4 || Math.abs(moveEvent.clientY - startY) > 4) {
					didDrag = true;
				}
				this.previewPanX = initialPanX + moveEvent.clientX - startX;
				this.previewPanY = initialPanY + moveEvent.clientY - startY;
				this.syncPreviewViewportElements(canvas);
			};
			const endPan = (endEvent: PointerEvent) => {
				applyPan(endEvent);
				suppressBlankClose = didDrag;
				if (didDrag) {
					window.setTimeout(() => {
						suppressBlankClose = false;
					}, 0);
				}
				canvas.removeClass("is-panning");
				canvas.removeEventListener("pointermove", applyPan);
				canvas.removeEventListener("pointerup", endPan);
				canvas.removeEventListener("pointercancel", cancelPan);
				if (canvas.hasPointerCapture(endEvent.pointerId)) {
					canvas.releasePointerCapture(endEvent.pointerId);
				}
			};
			const cancelPan = () => {
				canvas.removeClass("is-panning");
				canvas.removeEventListener("pointermove", applyPan);
				canvas.removeEventListener("pointerup", endPan);
				canvas.removeEventListener("pointercancel", cancelPan);
			};
			canvas.addEventListener("pointermove", applyPan);
			canvas.addEventListener("pointerup", endPan);
			canvas.addEventListener("pointercancel", cancelPan);
		});
	}

	private setPreviewZoomFromCanvas(canvas: HTMLElement, nextZoom: number, clientX: number, clientY: number): void {
		const oldZoom = this.previewZoom;
		const zoom = roundDetailZoom(clamp(nextZoom, DETAIL_ZOOM_MIN, DETAIL_ZOOM_MAX));
		if (zoom === oldZoom) {
			return;
		}

		const rect = canvas.getBoundingClientRect();
		const anchorX = clientX - rect.left - rect.width / 2;
		const anchorY = clientY - rect.top - rect.height / 2;
		const ratio = zoom / oldZoom;
		this.previewPanX = anchorX - (anchorX - this.previewPanX) * ratio;
		this.previewPanY = anchorY - (anchorY - this.previewPanY) * ratio;
		this.previewZoom = zoom;
		this.syncPreviewViewportElements(canvas);
	}

	private syncPreviewViewportElements(scope: ParentNode): void {
		const root = scope instanceof HTMLElement
			? (scope.closest(".media-vault-preview-overlay") ?? scope)
			: scope;
		const stage = root.querySelector<HTMLElement>(".media-vault-preview-stage");
		if (stage) {
			stage.style.setProperty("--media-vault-preview-zoom", String(this.previewZoom));
			stage.style.setProperty("--media-vault-preview-pan-x", `${this.previewPanX}px`);
			stage.style.setProperty("--media-vault-preview-pan-y", `${this.previewPanY}px`);
			stage.style.setProperty("--media-vault-preview-rotate", `${this.previewRotation}deg`);
			stage.style.setProperty("--media-vault-preview-scale-x", this.previewFlipX ? "-1" : "1");
			stage.style.setProperty("--media-vault-preview-scale-y", this.previewFlipY ? "-1" : "1");
			stage.style.setProperty("--media-vault-preview-filter", this.previewInvert ? "invert(1) hue-rotate(180deg)" : "none");
		}
		const readout = root.querySelector<HTMLElement>(".media-vault-preview-zoom-value");
		if (readout) {
			readout.setText(`${Math.round(this.previewZoom * 100)}%`);
		}
		const zoomOut = root.querySelector<HTMLButtonElement>("[data-preview-action='zoom-out']");
		if (zoomOut) {
			zoomOut.disabled = this.previewZoom <= DETAIL_ZOOM_MIN;
		}
		const zoomIn = root.querySelector<HTMLButtonElement>("[data-preview-action='zoom-in']");
		if (zoomIn) {
			zoomIn.disabled = this.previewZoom >= DETAIL_ZOOM_MAX;
		}
		this.syncPreviewActiveButton(root, "flip-x", this.previewFlipX);
		this.syncPreviewActiveButton(root, "flip-y", this.previewFlipY);
		this.syncPreviewActiveButton(root, "invert", this.previewInvert);
	}

	private syncPreviewActiveButton(root: ParentNode, action: string, isActive: boolean): void {
		const button = root.querySelector<HTMLButtonElement>(`[data-preview-action='${action}']`);
		if (button) {
			button.classList.toggle("is-active", isActive);
		}
	}

	private renderPreviewOverlay(parent: Element): void {
		if (!this.previewAssetId) {
			return;
		}
		const asset = this.plugin.services.assetRepository.getAssetById(this.previewAssetId);
		if (!asset) {
			this.previewAssetId = null;
			return;
		}
		const assets = this.getPreviewNavigationAssets(asset);
		const currentIndex = Math.max(0, assets.findIndex((item) => item.id === asset.id));
		const overlay = parent.createDiv({cls: "media-vault-preview-overlay"});
		overlay.tabIndex = -1;
		overlay.addEventListener("click", (event) => {
			if (event.target === overlay) {
				this.closeAssetPreview();
			}
		});

		const modal = overlay.createDiv({cls: "media-vault-preview-modal"});
		const header = modal.createDiv({cls: "media-vault-preview-header"});
		const title = header.createDiv({cls: "media-vault-preview-title"});
		title.createSpan({text: asset.filename});
		title.createSpan({cls: "media-vault-preview-count", text: `${currentIndex + 1} / ${assets.length}`});
		const topActions = header.createDiv({cls: "media-vault-preview-top-actions"});
		const close = this.createPreviewIconButton(topActions, "x", "关闭预览");
		close.addEventListener("click", () => this.closeAssetPreview());

		const body = modal.createDiv({cls: "media-vault-preview-body"});
		const canvas = body.createDiv({cls: "media-vault-preview-canvas"});
		canvas.tabIndex = 0;
		this.enablePreviewCanvasInteractions(canvas);
		const previous = this.createPreviewIconButton(body, "chevron-left", "上一张", "media-vault-preview-nav is-prev");
		previous.disabled = currentIndex <= 0;
		previous.addEventListener("click", () => this.navigatePreviewAsset(-1));
		const stage = canvas.createDiv({cls: "media-vault-preview-stage"});
		stage.style.setProperty("--media-vault-preview-zoom", String(this.previewZoom));
		stage.style.setProperty("--media-vault-preview-pan-x", `${this.previewPanX}px`);
		stage.style.setProperty("--media-vault-preview-pan-y", `${this.previewPanY}px`);
		stage.style.setProperty("--media-vault-preview-rotate", `${this.previewRotation}deg`);
		stage.style.setProperty("--media-vault-preview-scale-x", this.previewFlipX ? "-1" : "1");
		stage.style.setProperty("--media-vault-preview-scale-y", this.previewFlipY ? "-1" : "1");
		stage.style.setProperty("--media-vault-preview-filter", this.previewInvert ? "invert(1) hue-rotate(180deg)" : "none");
		const resourcePath = this.getDetailImageResourcePath(asset);
		if (resourcePath) {
			stage.createEl("img", {attr: {src: resourcePath, alt: asset.filename}});
		} else {
			stage.createDiv({cls: "media-vault-empty-title", text: "无法读取图片资源"});
		}
		const next = this.createPreviewIconButton(body, "chevron-right", "下一张", "media-vault-preview-nav is-next");
		next.disabled = currentIndex >= assets.length - 1;
		next.addEventListener("click", () => this.navigatePreviewAsset(1));

		const toolbar = modal.createDiv({cls: "media-vault-preview-toolbar"});
		const zoomOut = this.createPreviewIconButton(toolbar, "minus", "缩小预览");
		zoomOut.dataset.previewAction = "zoom-out";
		zoomOut.disabled = this.previewZoom <= DETAIL_ZOOM_MIN;
		zoomOut.addEventListener("click", () => this.adjustPreviewZoom(-DETAIL_ZOOM_STEP));
		toolbar.createSpan({cls: "media-vault-preview-zoom-value", text: `${Math.round(this.previewZoom * 100)}%`});
		const zoomIn = this.createPreviewIconButton(toolbar, "plus", "放大预览");
		zoomIn.dataset.previewAction = "zoom-in";
		zoomIn.disabled = this.previewZoom >= DETAIL_ZOOM_MAX;
		zoomIn.addEventListener("click", () => this.adjustPreviewZoom(DETAIL_ZOOM_STEP));
		const fit = this.createPreviewIconButton(toolbar, "maximize-2", "适应窗口");
		fit.addEventListener("click", () => {
			this.resetPreviewViewport();
			this.syncPreviewViewportElements(toolbar);
		});
		const rotateLeft = this.createPreviewIconButton(toolbar, "rotate-ccw", "向左旋转");
		rotateLeft.addEventListener("click", () => this.rotatePreview(-90));
		const rotateRight = this.createPreviewIconButton(toolbar, "rotate-cw", "向右旋转");
		rotateRight.addEventListener("click", () => this.rotatePreview(90));
		const flipX = this.createPreviewIconButton(toolbar, "flip-horizontal", "水平翻转");
		flipX.dataset.previewAction = "flip-x";
		flipX.classList.toggle("is-active", this.previewFlipX);
		flipX.addEventListener("click", () => this.togglePreviewFlipX());
		const flipY = this.createPreviewIconButton(toolbar, "flip-vertical", "垂直翻转");
		flipY.dataset.previewAction = "flip-y";
		flipY.classList.toggle("is-active", this.previewFlipY);
		flipY.addEventListener("click", () => this.togglePreviewFlipY());
		const invert = this.createPreviewIconButton(toolbar, "contrast", "深色反转");
		invert.dataset.previewAction = "invert";
		invert.classList.toggle("is-active", this.previewInvert);
		invert.addEventListener("click", () => this.togglePreviewInvert());
	}

	private createPreviewIconButton(parent: Element, icon: string, label: string, className = ""): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: ["media-vault-preview-icon-button", className].filter(Boolean).join(" "),
			attr: {
				type: "button",
				"aria-label": label,
				title: label,
			},
		});
		setIcon(button, icon);
		return button;
	}

	private renderDetailCenter(parent: Element, asset: Asset): void {
		const center = parent.createDiv({cls: "media-vault-detail-center media-vault-detail-viewer"});
		const navAssets = this.getDetailNavigationAssets(asset);
		const currentIndex = Math.max(0, navAssets.findIndex((item) => item.id === asset.id));
		const toolbar = center.createDiv({cls: "media-vault-detail-toolbar media-vault-detail-viewer-toolbar"});
		const title = toolbar.createDiv({cls: "media-vault-detail-title-group"});
		const back = title.createEl("button", {text: "返回图库"});
		back.addEventListener("click", () => {
			this.confirmAssetNoteLeave(asset, () => {
				this.plugin.closeAssetDetail();
			});
		});
		title.createDiv({cls: "media-vault-detail-title", text: asset.filename});
		this.renderAssetNoteStatus(title, asset);

		const controls = toolbar.createDiv({cls: "media-vault-detail-viewer-controls"});
		const previous = controls.createEl("button", {text: "‹", attr: {"aria-label": "上一张"}});
		previous.disabled = currentIndex <= 0;
		previous.addEventListener("click", () => this.navigateDetailAssetByDelta(asset, -1));
		controls.createSpan({cls: "media-vault-detail-counter", text: `${currentIndex + 1} / ${navAssets.length}`});
		const next = controls.createEl("button", {text: "›", attr: {"aria-label": "下一张"}});
		next.disabled = currentIndex >= navAssets.length - 1;
		next.addEventListener("click", () => this.navigateDetailAssetByDelta(asset, 1));
		controls.createSpan({cls: "media-vault-detail-zoom-readout", text: `${Math.round(this.detailZoom * 100)}%`});
		const fit = controls.createEl("button", {text: "适应"});
		fit.addEventListener("click", () => {
			this.resetDetailViewport();
			this.render();
		});
		const actual = controls.createEl("button", {text: "1:1"});
		actual.addEventListener("click", () => {
			this.detailZoom = 1;
			this.detailPanX = 0;
			this.detailPanY = 0;
			this.render();
		});

		const canvas = center.createDiv({cls: "media-vault-detail-canvas media-vault-detail-viewer-canvas"});
		canvas.tabIndex = 0;
		this.enableDetailCanvasInteractions(canvas);
		canvas.createDiv({cls: "media-vault-detail-canvas-hint", text: "双指缩放 · 滚轮缩放 · 拖拽平移"});
		const resourcePath = this.getDetailImageResourcePath(asset);
		if (resourcePath) {
			const selectedAnnotation = this.getSelectedAnnotation(asset);
			const imageWrap = canvas.createDiv({cls: `media-vault-detail-image-wrap ${selectedAnnotation ? "has-selected-annotation" : ""} ${this.detailZoom !== 1 || this.detailPanX !== 0 || this.detailPanY !== 0 ? "is-zoomed" : ""}`});
			const imageStage = imageWrap.createDiv({cls: `media-vault-detail-image-stage ${selectedAnnotation ? "is-focused" : ""}`});
			imageStage.style.setProperty("--media-vault-detail-zoom", String(this.getDetailImageScale(Boolean(selectedAnnotation))));
			imageStage.style.setProperty("--media-vault-detail-pan-x", `${this.detailPanX}px`);
			imageStage.style.setProperty("--media-vault-detail-pan-y", `${this.detailPanY}px`);
			if (selectedAnnotation) {
				const focusX = clamp(selectedAnnotation.x + selectedAnnotation.width / 2, 0, 1);
				const focusY = clamp(selectedAnnotation.y + selectedAnnotation.height / 2, 0, 1);
				imageStage.style.setProperty("--media-vault-annotation-focus-x", `${focusX * 100}%`);
				imageStage.style.setProperty("--media-vault-annotation-focus-y", `${focusY * 100}%`);
				imageWrap.createDiv({cls: "media-vault-annotation-focus-caption", text: `已定位：${selectedAnnotation.label}`});
			}
			imageStage.createEl("img", {attr: {src: resourcePath, alt: asset.filename}});
			if (this.detailTab === "annotations" && this.detailMode === "annotation") {
				imageStage.addClass("is-annotating");
				imageStage.tabIndex = 0;
				imageStage.addEventListener("pointerdown", () => imageStage.focus());
				imageStage.createDiv({cls: "media-vault-annotation-drag-hint", text: "拖拽图片区域创建或调整标注框；标注信息在右侧检查器维护。"});
				this.enableAnnotationDragSelection(imageStage);
			}
			this.renderAnnotationOverlays(imageStage, asset);
			if (this.detailTab === "ocr") {
				this.renderOcrOverlays(imageStage, asset);
			}
			this.renderDetailZoomControls(canvas, asset);
			this.renderDetailMiniMap(canvas);
		} else {
			canvas.createDiv({cls: "media-vault-empty-title", text: "无法读取图片资源"});
		}
	}

	private getDetailImageResourcePath(asset: Asset): string | null {
		const file = this.app.vault.getAbstractFileByPath(asset.filePath);
		if (file instanceof TFile) {
			return this.app.vault.getResourcePath(file);
		}

		return this.plugin.services.thumbnailService.getResourcePath(asset, "large");
	}

	private renderDetailOverview(parent: Element, asset: Asset): void {
		const references = this.plugin.services.assetRepository.getReferencesForAsset(asset.id);
		const annotations = this.plugin.services.assetRepository.getAnnotationsForAsset(asset.id);
		const summary = parent.createDiv({cls: "media-vault-asset-note-summary"});
		this.renderAssetNoteSummaryItem(summary, "尺寸", asset.width && asset.height ? `${asset.width} x ${asset.height}` : "未知");
		this.renderAssetNoteSummaryItem(summary, "大小", formatFileSize(asset.sizeBytes));
		this.renderAssetNoteSummaryItem(summary, "引用", `${references.length} 处`);
		this.renderAssetNoteSummaryItem(summary, "标注", `${annotations.length} 个`);
		this.renderAssetNoteSummaryItem(summary, "标签", asset.tags.length > 0 ? asset.tags.map((tag) => `#${tag}`).join("、") : "无");
		this.renderAssetNoteSummaryItem(summary, "Collections", asset.collections.length > 0 ? asset.collections.join("、") : "无");

		const actions = parent.createDiv({cls: "media-vault-detail-actions"});
		const editAssetNote = actions.createEl("button", {text: asset.notePath ? "编辑 Asset Note" : "创建 Asset Note"});
		editAssetNote.addEventListener("click", () => {
			this.plugin.setDetailPanel("asset-note");
		});
		if (asset.notePath) {
			const openAssetNote = actions.createEl("button", {text: "打开素材笔记"});
			openAssetNote.addEventListener("click", () => {
				void this.plugin.openReference(asset.notePath as string);
			});
		}
	}

	private renderSimilarStrip(parent: Element, asset: Asset): void {
		const candidates = this.getVersionCandidates(asset).slice(0, 8);
		if (candidates.length === 0) {
			return;
		}

		const strip = parent.createDiv({cls: "media-vault-similar-strip"});
		const head = strip.createDiv({cls: "media-vault-similar-strip-head"});
		head.createDiv({cls: "media-vault-section-title", text: "相似图片"});
		const openVersions = head.createEl("button", {text: "查看全部"});
		openVersions.addEventListener("click", () => {
			void this.plugin.openSimilarAssets(asset.id);
		});
		const list = strip.createDiv({cls: "media-vault-similar-strip-list"});
		for (const candidate of candidates) {
			const item = list.createEl("button", {cls: "media-vault-similar-item"});
			const resourcePath = this.plugin.services.thumbnailService.getResourcePath(candidate);
			const preview = item.createDiv({cls: "media-vault-similar-preview"});
			if (resourcePath) {
				preview.createEl("img", {attr: {src: resourcePath, alt: candidate.filename, loading: "lazy", decoding: "async"}});
			}
			const body = item.createDiv({cls: "media-vault-similar-body"});
			body.createDiv({cls: "media-vault-similar-title", text: candidate.filename});
			const isExact = Boolean(asset.sha256 && candidate.sha256 === asset.sha256);
			body.createDiv({
				cls: "media-vault-similar-meta",
				text: `${isExact ? "完全重复" : "视觉相似"} · ${formatFileSize(candidate.sizeBytes)} · ${candidate.referenceCount} 引用`,
			});
			item.addEventListener("click", () => {
				this.confirmAssetNoteLeave(asset, () => {
					this.selectedAnnotationId = null;
					this.annotationDraft = this.createAnnotationDraft();
					this.plugin.openAssetDetail(candidate.id, "detail");
				});
			});
		}
		}

		private renderOcrPanel(parent: Element, asset: Asset): void {
			const result = this.plugin.services.ocrService.getResult(asset.id);
			this.prepareOcrDraft(asset, result);

			const panel = parent.createDiv({cls: "media-vault-ocr-panel"});
			const preview = panel.createDiv({cls: "media-vault-ocr-preview-panel"});
			preview.createDiv({cls: "media-vault-section-title", text: "识别区域"});
			const imageWrap = preview.createDiv({cls: "media-vault-ocr-preview"});
			const resourcePath = this.getDetailImageResourcePath(asset);
			if (resourcePath) {
				imageWrap.createEl("img", {attr: {src: resourcePath, alt: asset.filename, loading: "lazy", decoding: "async"}});
			}
			if (result) {
				this.renderOcrPreviewOverlays(imageWrap, result);
			} else {
				imageWrap.createDiv({cls: "media-vault-ocr-empty-overlay", text: "暂无识别区域"});
			}

			const side = panel.createDiv({cls: "media-vault-ocr-side"});
			const head = side.createDiv({cls: "media-vault-ocr-head"});
			const title = head.createDiv();
			title.createDiv({cls: "media-vault-section-title", text: "识别文本"});
			title.createDiv({
				cls: "media-vault-hint",
				text: result ? "当前显示已保存的本地识别结果，可编辑后覆盖。" : "当前版本不上传图片；先支持粘贴系统或本地识别结果。",
			});
			const status = head.createDiv({cls: `media-vault-ocr-status ${result ? "is-ready" : "is-empty"}`});
			status.createDiv({text: result ? `${result.text.length} 字` : "未保存"});
			status.createDiv({text: result ? `${result.blocks.length} 块 · ${getOcrAverageConfidence(result)}%` : "local"});

			const meta = side.createDiv({cls: "media-vault-ocr-meta"});
			this.renderOcrMetaItem(meta, "来源", result ? getProviderLabel(result.provider) : "local");
			this.renderOcrMetaItem(meta, "语言", result?.language ?? this.ocrDraftLanguage);
			this.renderOcrMetaItem(meta, "更新时间", result ? formatDateTime(result.updatedAt ?? result.createdAt) : "未保存");

			const form = side.createDiv({cls: "media-vault-ocr-form"});
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
				cls: "media-vault-ocr-textarea",
				attr: {
					placeholder: "粘贴识别文本，保存后可复制、搜索或写入素材笔记。",
				},
			});
			textarea.value = this.ocrDraftText;

			const actions = side.createDiv({cls: "media-vault-detail-actions media-vault-ocr-actions"});
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

			this.renderOcrBlocks(side, result);
		}

		private renderOcrMetaItem(parent: Element, label: string, value: string): void {
			const item = parent.createDiv({cls: "media-vault-ocr-meta-item"});
			item.createSpan({text: label});
			item.createDiv({text: value});
		}

		private renderOcrBlocks(parent: Element, result: OcrResult | undefined): void {
			parent.createDiv({cls: "media-vault-section-title", text: "文本块"});
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

		private renderOcrPreviewOverlays(parent: HTMLElement, result: OcrResult): void {
			const layer = parent.createDiv({cls: "media-vault-ocr-layer"});
			for (const [index, block] of result.blocks.entries()) {
				const box = layer.createEl("button", {cls: `media-vault-ocr-box ${this.selectedOcrBlockIndex === index ? "is-active" : ""}`});
				setOcrRectStyle(box, block.rect);
				box.setAttr("aria-label", block.text);
				box.addEventListener("click", () => {
					this.selectedOcrBlockIndex = index;
					this.render();
				});
			}
		}

		private renderOcrOverlays(parent: HTMLElement, asset: Asset): void {
			const result = this.plugin.services.ocrService.getResult(asset.id);
			if (!result || result.blocks.length === 0) {
				return;
			}
			this.renderOcrPreviewOverlays(parent, result);
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
			} catch (error) {
				new Notice(`识别文本清空失败：${getErrorMessage(error)}`);
			}
		}

		private renderDetailRightPanel(parent: Element, asset: Asset): void {
			const right = parent.createDiv({cls: "media-vault-detail-right"});
		const references = this.plugin.services.assetRepository.getReferencesForAsset(asset.id);
		const annotations = this.plugin.services.assetRepository.getAnnotationsForAsset(asset.id);
		if (this.detailTab === "annotations") {
			this.renderAnnotationAssistPanel(right, asset);
		}

		right.createDiv({cls: "media-vault-section-title", text: "关系图谱"});
		this.renderDetailGraph(right, asset, references, annotations);

		right.createDiv({cls: "media-vault-section-title", text: "引用上下文"});
		if (references.length === 0) {
			right.createDiv({cls: "media-vault-hint", text: "暂无引用。"});
		}
		for (const reference of references.slice(0, 8)) {
			const item = right.createDiv({cls: "media-vault-reference"});
			item.createDiv({cls: "media-vault-reference-path", text: formatReferenceLocation(reference)});
			this.renderReferenceHeading(item, reference);
			item.createDiv({cls: "media-vault-reference-context", text: reference.contextPreview ?? reference.rawLink});
			item.addEventListener("click", () => {
				void this.plugin.openReference(reference.sourceNotePath, reference.lineStart);
			});
		}

		right.createDiv({cls: "media-vault-section-title", text: "区域标注"});
		if (annotations.length === 0) {
			right.createDiv({cls: "media-vault-hint", text: "暂无标注。"});
		}
		for (const annotation of annotations) {
			const linkStatus = this.getAnnotationLinkStatus(annotation, asset.notePath ?? asset.filePath);
			const item = right.createDiv({cls: `media-vault-annotation-list-item ${this.selectedAnnotationId === annotation.id ? "is-active" : ""}`});
			item.addClass(`is-link-${linkStatus.state}`);
			item.style.setProperty("--media-vault-annotation-color", getAnnotationColor(annotation.color));
			const row = item.createDiv({cls: "media-vault-annotation-list-head"});
			const title = row.createDiv({cls: "media-vault-annotation-title"});
			title.createSpan({cls: "media-vault-annotation-color-dot"});
			title.createSpan({cls: "media-vault-reference-path", text: annotation.label});
			const actions = row.createDiv({cls: "media-vault-annotation-list-actions"});
			const locate = actions.createEl("button", {text: "定位"});
			locate.addEventListener("click", (event) => {
				event.stopPropagation();
				this.focusAnnotation(annotation);
			});
			const edit = actions.createEl("button", {text: "编辑"});
			edit.addEventListener("click", (event) => {
				event.stopPropagation();
				this.editAnnotation(annotation);
			});
			const open = actions.createEl("button", {text: "打开"});
			open.disabled = linkStatus.state !== "ok";
			open.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.plugin.openAnnotationTarget(annotation, asset.notePath ?? asset.filePath);
			});
			const remove = actions.createEl("button", {cls: "mod-warning", text: "删除"});
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				this.deleteAnnotation(annotation);
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
				this.focusAnnotation(annotation);
			});
			item.addEventListener("dblclick", () => {
				void this.plugin.openAnnotationTarget(annotation, asset.notePath ?? asset.filePath);
			});
		}
	}

	private renderAnnotationAssistPanel(parent: Element, asset: Asset): void {
		const status = this.getAnnotationDraftLinkStatus();
		const panel = parent.createDiv({cls: "media-vault-annotation-assist"});

		panel.createDiv({cls: "media-vault-section-title", text: "链接预览"});
		const target = panel.createDiv({cls: "media-vault-annotation-assist-target"});
		target.createDiv({
			cls: "media-vault-annotation-assist-link",
			text: status.linkText ? `[[${status.linkText}]]` : "未绑定笔记、标题或块引用",
		});
		target.createDiv({cls: `media-vault-annotation-assist-status is-${status.state}`, text: status.label});

		panel.createDiv({cls: "media-vault-section-title", text: "标注写入方式"});
		panel.createDiv({
			cls: "media-vault-annotation-assist-summary",
			text: this.getAnnotationDraftStorageSummary(asset),
		});
		panel.createEl("pre", {
			cls: "media-vault-annotation-assist-code",
			text: this.buildAnnotationDraftStoragePreview(asset),
		});

		panel.createDiv({cls: "media-vault-section-title", text: "交互规则"});
		const rules = panel.createDiv({cls: "media-vault-annotation-assist-rules"});
		for (const rule of [
			"点击标注框会在图片中定位并进入编辑态。",
			"双击已有标注会跳转到绑定的笔记、标题或块。",
			"保存后，图片详情页和笔记内图片悬浮面板都会显示该标注。",
		]) {
			rules.createDiv({text: rule});
		}
	}

	private renderDetailZoomControls(parent: Element, asset: Asset): void {
		const controls = parent.createDiv({cls: "media-vault-detail-zoom-bar"});
		const zoomOut = controls.createEl("button", {
			text: "−",
			attr: {"aria-label": "缩小图片"},
		});
		zoomOut.disabled = this.detailZoom <= DETAIL_ZOOM_MIN;
		zoomOut.addEventListener("click", () => {
			this.adjustDetailZoom(-DETAIL_ZOOM_STEP);
		});
		controls.createSpan({cls: "media-vault-detail-zoom-value", text: `${Math.round(this.detailZoom * 100)}%`});
		const zoomIn = controls.createEl("button", {
			text: "+",
			attr: {"aria-label": "放大图片"},
		});
		zoomIn.disabled = this.detailZoom >= DETAIL_ZOOM_MAX;
		zoomIn.addEventListener("click", () => {
			this.adjustDetailZoom(DETAIL_ZOOM_STEP);
		});
		const fit = controls.createEl("button", {text: "适应"});
		fit.disabled = this.detailZoom === 1 && this.detailPanX === 0 && this.detailPanY === 0;
		fit.addEventListener("click", () => {
			this.resetDetailViewport();
			this.render();
		});
		const actualSize = controls.createEl("button", {text: "1:1"});
		actualSize.disabled = this.detailZoom === 1 && this.detailPanX === 0 && this.detailPanY === 0;
		actualSize.addEventListener("click", () => {
			this.detailZoom = 1;
			this.detailPanX = 0;
			this.detailPanY = 0;
			this.render();
		});
		const annotationMode = controls.createEl("button", {
			cls: this.isAnnotationEditMode() ? "is-active" : "",
			text: this.isAnnotationEditMode() ? "框选区域" : "标注模式",
		});
		annotationMode.addEventListener("click", () => {
			if (this.isAnnotationEditMode()) {
				return;
			}
			this.startNewAnnotationMode(asset);
		});
	}

	private adjustDetailZoom(delta: number): void {
		this.detailZoom = roundDetailZoom(clamp(this.detailZoom + delta, DETAIL_ZOOM_MIN, DETAIL_ZOOM_MAX));
		this.render();
	}

	private getDetailImageScale(hasSelectedAnnotation: boolean): number {
		if (hasSelectedAnnotation && this.detailZoom === 1) {
			return 1.12;
		}
		return this.detailZoom;
	}

	private renderDetailGraph(parent: Element, asset: Asset, references: AssetReference[], annotations: Annotation[]): void {
		const graph = parent.createDiv({cls: "media-vault-graph-card"});
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
				this.plugin.setDetailPanel("annotations");
			}} : null,
		];
		this.renderGraphGroup(groups, "扩展节点", extensionNodes.filter((item): item is GraphNodeData => item !== null));
	}

	private renderGraphGroup(parent: Element, title: string, nodes: GraphNodeData[]): void {
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

	private renderAnnotationOverlays(parent: HTMLElement, asset: Asset): void {
		const isEditing = this.isAnnotationEditMode();
		for (const annotation of this.plugin.services.assetRepository.getAnnotationsForAsset(asset.id)) {
			const isSelected = this.selectedAnnotationId === annotation.id;
			const rect = isEditing && isSelected ? this.annotationDraft : annotation;
			const linkStatus = this.getAnnotationLinkStatus(annotation, asset.notePath ?? asset.filePath);
			const overlay = parent.createDiv({cls: `media-vault-annotation-box ${isSelected ? "is-active" : ""}`});
			overlay.dataset.mediaVaultAnnotationId = annotation.id;
			overlay.addClass(`is-link-${linkStatus.state}`);
			if (isEditing) {
				overlay.addClass("is-editable");
			}
			overlay.setAttr("aria-label", `${annotation.label}，${linkStatus.label}`);
			setAnnotationRectStyle(overlay, rect);
			setAnnotationColorStyle(overlay, isSelected ? this.annotationDraft.color : annotation.color);
			overlay.createSpan({cls: "media-vault-annotation-label", text: isSelected && this.annotationDraft.label ? this.annotationDraft.label : annotation.label});
			if (isEditing) {
				overlay.addEventListener("pointerdown", (event) => {
					this.startAnnotationBoxTransform(parent, annotation, event, "move");
				});
			}
			overlay.addEventListener("click", (event) => {
				event.stopPropagation();
				if (this.suppressNextAnnotationClick) {
					this.suppressNextAnnotationClick = false;
					return;
				}
				this.selectAnnotation(annotation);
			});
			overlay.addEventListener("dblclick", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.plugin.openAnnotationTarget(annotation, asset.notePath ?? asset.filePath);
			});
			if (isEditing && isSelected) {
				this.renderAnnotationResizeHandles(parent, overlay, annotation);
			}
		}
		if (isEditing && !this.selectedAnnotationId) {
			const draft = parent.createDiv({cls: "media-vault-annotation-box is-draft"});
			setAnnotationRectStyle(draft, this.annotationDraft);
			setAnnotationColorStyle(draft, this.annotationDraft.color);
			draft.createSpan({cls: "media-vault-annotation-label", text: this.annotationDraft.label || "新标注"});
		}
	}

	private isAnnotationEditMode(): boolean {
		return this.detailTab === "annotations" && this.detailMode === "annotation";
	}

	private createAnnotationDraft(): AnnotationDraft {
		return createEmptyAnnotationDraft(this.plugin.settings.syncAnnotationsToAssetNote ? "asset-note" : "index");
	}

	private cancelCurrentAnnotationDraft(): void {
		this.selectedAnnotationId = null;
		this.annotationDraft = this.createAnnotationDraft();
		this.render();
	}

	private applyFocusedAnnotationFromPlugin(assetId: string | null, annotationId: string | null): boolean {
		if (!assetId || !annotationId) {
			return false;
		}
		const annotation = this.plugin.services.assetRepository
			.getAnnotationsForAsset(assetId)
			.find((item) => item.id === annotationId);
		if (!annotation) {
			return false;
		}

		this.selectedAnnotationId = annotation.id;
		this.detailTab = "annotations";
		this.detailMode = "annotation";
		this.annotationDraft = annotationToDraft(annotation);
		return true;
	}

	private startNewAnnotationMode(asset: Asset): void {
		this.confirmAssetNoteLeave(asset, () => {
			this.detailMode = "annotation";
			this.detailTab = "annotations";
			this.selectedAnnotationId = null;
			this.annotationDraft = this.createAnnotationDraft();
			this.plugin.openAssetDetail(asset.id, "annotation");
		});
	}

	private renderAnnotationResizeHandles(parent: HTMLElement, overlay: HTMLElement, annotation: Annotation): void {
		for (const handle of ["nw", "ne", "sw", "se"] as AnnotationResizeHandle[]) {
			const handleEl = overlay.createEl("button", {
				cls: `media-vault-annotation-resize-handle is-${handle}`,
				attr: {
					type: "button",
					"aria-label": `调整标注区域 ${handle.toUpperCase()}`,
				},
			});
			handleEl.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
			});
			handleEl.addEventListener("pointerdown", (event) => {
				this.startAnnotationBoxTransform(parent, annotation, event, handle);
			});
		}
	}

	private startAnnotationBoxTransform(parent: HTMLElement, annotation: Annotation, event: PointerEvent, mode: AnnotationTransformMode): void {
		if (!this.isAnnotationEditMode()) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		const wasSelected = this.selectedAnnotationId === annotation.id;
		this.selectedAnnotationId = annotation.id;
		if (!wasSelected) {
			this.annotationDraft = annotationToDraft(annotation);
		}
		parent.setPointerCapture(event.pointerId);
		const start = getRelativePoint(parent, event);
		const initialRect: AnnotationRect = {
			x: this.annotationDraft.x,
			y: this.annotationDraft.y,
			width: this.annotationDraft.width,
			height: this.annotationDraft.height,
		};

		const handleMove = (moveEvent: PointerEvent) => {
			const current = getRelativePoint(parent, moveEvent);
			const nextRect = mode === "move"
				? moveAnnotationRect(initialRect, current.x - start.x, current.y - start.y)
				: resizeAnnotationRect(initialRect, start, current, mode);
			this.setAnnotationDraftRect(nextRect);
			const overlay = findAnnotationOverlay(parent, annotation.id);
			if (overlay) {
				setAnnotationRectStyle(overlay, nextRect);
			}
		};
		const handleEnd = (endEvent: PointerEvent) => {
			handleMove(endEvent);
			parent.removeEventListener("pointermove", handleMove);
			parent.removeEventListener("pointerup", handleEnd);
			parent.removeEventListener("pointercancel", handleCancel);
			if (parent.hasPointerCapture(endEvent.pointerId)) {
				parent.releasePointerCapture(endEvent.pointerId);
			}
			this.suppressNextAnnotationClick = true;
			window.setTimeout(() => {
				this.suppressNextAnnotationClick = false;
			}, 0);
			this.render();
		};
		const handleCancel = () => {
			parent.removeEventListener("pointermove", handleMove);
			parent.removeEventListener("pointerup", handleEnd);
			parent.removeEventListener("pointercancel", handleCancel);
			this.render();
		};

		parent.addEventListener("pointermove", handleMove);
		parent.addEventListener("pointerup", handleEnd);
		parent.addEventListener("pointercancel", handleCancel);
	}

	private setAnnotationDraftRect(rect: AnnotationRect): void {
		this.annotationDraft.x = rect.x;
		this.annotationDraft.y = rect.y;
		this.annotationDraft.width = rect.width;
		this.annotationDraft.height = rect.height;
	}

	private enableAnnotationDragSelection(parent: HTMLElement): void {
		parent.addEventListener("pointerdown", (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof HTMLElement && target.closest(".media-vault-annotation-box")) {
				return;
			}

			event.preventDefault();
			parent.setPointerCapture(event.pointerId);
			const start = getRelativePoint(parent, event);
			this.applyAnnotationDraftRect(start, start, parent);

			const handleMove = (moveEvent: PointerEvent) => {
				this.applyAnnotationDraftRect(start, getRelativePoint(parent, moveEvent), parent);
			};
			const handleEnd = (endEvent: PointerEvent) => {
				this.applyAnnotationDraftRect(start, getRelativePoint(parent, endEvent), parent);
				parent.removeEventListener("pointermove", handleMove);
				parent.removeEventListener("pointerup", handleEnd);
				parent.removeEventListener("pointercancel", handleCancel);
				if (parent.hasPointerCapture(endEvent.pointerId)) {
					parent.releasePointerCapture(endEvent.pointerId);
				}
				this.render();
			};
			const handleCancel = () => {
				parent.removeEventListener("pointermove", handleMove);
				parent.removeEventListener("pointerup", handleEnd);
				parent.removeEventListener("pointercancel", handleCancel);
			};

			parent.addEventListener("pointermove", handleMove);
			parent.addEventListener("pointerup", handleEnd);
			parent.addEventListener("pointercancel", handleCancel);
		});
	}

	private applyAnnotationDraftRect(start: {x: number; y: number}, end: {x: number; y: number}, parent: HTMLElement): void {
		const rect = normalizeDraftRect(start, end);
		this.setAnnotationDraftRect(rect);
		const draft = parent.querySelector<HTMLElement>(".media-vault-annotation-box.is-draft");
		if (!draft) {
			return;
		}
		setAnnotationRectStyle(draft, rect);
	}

	private renderAssetNoteEditor(parent: Element, asset: Asset): void {
		const shell = parent.createDiv({cls: "media-vault-asset-note-panel"});
		const head = shell.createDiv({cls: "media-vault-asset-note-head"});
		const title = head.createDiv();
		title.createDiv({cls: "media-vault-section-title", text: "Asset Note"});
		title.createDiv({
			cls: "media-vault-hint",
			text: "保存后会从 frontmatter 同步 tags、collections、rating、favorite 和 colors 到图库与 Inspector。",
		});
		const mode = head.createDiv({cls: "media-vault-asset-note-mode"});
		for (const option of [
			{id: "edit" as const, label: "编辑"},
			{id: "preview" as const, label: "预览"},
		]) {
			const button = mode.createEl("button", {cls: this.assetNoteViewMode === option.id ? "is-active" : "", text: option.label});
			button.addEventListener("click", () => {
				if (this.assetNoteViewMode === option.id) {
					return;
				}
				this.assetNoteViewMode = option.id;
				this.render();
			});
		}

		if (this.assetNoteViewMode === "preview") {
			this.renderAssetNotePreview(shell, asset);
		} else {
			const textarea = shell.createEl("textarea", {
				cls: "media-vault-asset-note-editor",
				attr: {value: this.assetNoteContent},
			});
			textarea.value = this.assetNoteContent;
			textarea.addEventListener("input", () => {
				this.assetNoteContent = textarea.value;
				this.updateAssetNoteStatus(asset);
			});
		}
		const actions = parent.createDiv({cls: "media-vault-detail-actions"});
		const save = actions.createEl("button", {cls: "mod-cta", text: asset.notePath ? "保存素材笔记" : "创建素材笔记"});
		save.addEventListener("click", () => {
			void this.saveAssetNoteFromDetail(asset);
		});
		if (asset.notePath) {
			const open = actions.createEl("button", {text: "打开素材笔记"});
			open.addEventListener("click", () => {
				this.confirmAssetNoteLeave(asset, () => {
					void this.plugin.openReference(asset.notePath as string);
				});
			});
		}
	}

	private renderAssetNotePreview(parent: Element, asset: Asset): void {
		const metadata = parseAssetNoteMetadata(this.assetNoteContent);
		const summary = parent.createDiv({cls: "media-vault-asset-note-summary"});
		this.renderAssetNoteSummaryItem(summary, "类型", metadata.isAssetNote ? "asset" : "未识别");
		this.renderAssetNoteSummaryItem(summary, "图片", metadata.filePath ?? asset.filePath);
		this.renderAssetNoteSummaryItem(summary, "标签", metadata.tags?.join("、") || asset.tags.join("、") || "无");
		this.renderAssetNoteSummaryItem(summary, "Collections", metadata.collections?.join("、") || asset.collections.join("、") || "无");
		this.renderAssetNoteSummaryItem(summary, "评分", typeof metadata.rating === "number" ? `${metadata.rating} 星` : typeof asset.rating === "number" ? `${asset.rating} 星` : "未评分");
		this.renderAssetNoteSummaryItem(summary, "标注", `${metadata.annotations?.length ?? this.plugin.services.assetRepository.getAnnotationsForAsset(asset.id).length} 个`);

		const preview = parent.createDiv({cls: "media-vault-asset-note-preview"});
		void MarkdownRenderer.render(
			this.app,
			this.assetNoteContent || "暂无 Asset Note 内容。",
			preview,
			asset.notePath ?? asset.filePath,
			this,
		);
	}

	private renderAssetNoteSummaryItem(parent: Element, label: string, value: string): void {
		const item = parent.createDiv({cls: "media-vault-asset-note-summary-item"});
		item.createSpan({text: label});
		item.createDiv({text: value});
	}

	private renderDetailReferences(parent: Element, asset: Asset): void {
		const references = this.plugin.services.assetRepository.getReferencesForAsset(asset.id);
		parent.createDiv({cls: "media-vault-section-title", text: `引用上下文 ${references.length}`});
		for (const reference of references) {
			const item = parent.createDiv({cls: "media-vault-reference"});
			item.createDiv({cls: "media-vault-reference-path", text: formatReferenceLocation(reference)});
			this.renderReferenceHeading(item, reference);
			item.createDiv({cls: "media-vault-reference-context", text: reference.contextPreview ?? reference.rawLink});
			const actions = item.createDiv({cls: "media-vault-reference-actions"});
			const showNoteImages = actions.createEl("button", {text: "查看该笔记图片"});
			showNoteImages.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.plugin.showNoteCollection(reference.sourceNotePath);
			});
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
		if (references.length === 0) {
			parent.createDiv({cls: "media-vault-hint", text: "暂无引用。"});
		}
	}

	private renderAnnotationsPanel(parent: Element, asset: Asset): void {
		if (this.isAnnotationEditMode()) {
			this.renderAnnotationEditor(parent, asset);
			return;
		}

		const annotations = this.plugin.services.assetRepository.getAnnotationsForAsset(asset.id);
		const head = parent.createDiv({cls: "media-vault-annotation-tab-head"});
		const title = head.createDiv();
		title.createDiv({cls: "media-vault-section-title", text: `区域标注 ${annotations.length}`});
		title.createDiv({
			cls: "media-vault-hint",
			text: "点击标注会在大图中定位；编辑、跳转和删除需要显式操作。",
		});
		const actions = head.createDiv({cls: "media-vault-annotation-tab-actions"});
		const create = actions.createEl("button", {cls: "mod-cta", text: "新建区域标注"});
		create.addEventListener("click", () => this.startNewAnnotationMode(asset));
		if (this.selectedAnnotationId) {
			const selectedAnnotation = this.getSelectedAnnotation(asset);
			const editSelected = actions.createEl("button", {text: "编辑选中"});
			editSelected.disabled = !selectedAnnotation;
			editSelected.addEventListener("click", () => {
				if (selectedAnnotation) {
					this.editAnnotation(selectedAnnotation);
				}
			});
		}

		if (annotations.length === 0) {
			const empty = parent.createDiv({cls: "media-vault-annotation-empty"});
			empty.createDiv({cls: "media-vault-empty-title", text: "暂无区域标注"});
			empty.createDiv({text: "进入标注模式后，在图片上拖拽框选区域并绑定 Obsidian 笔记、标题或块引用。"});
			return;
		}

		const list = parent.createDiv({cls: "media-vault-annotation-tab-list"});
		for (const annotation of annotations) {
			this.renderAnnotationTabItem(list, asset, annotation);
		}
	}

	private renderAnnotationTabItem(parent: Element, asset: Asset, annotation: Annotation): void {
		const linkStatus = this.getAnnotationLinkStatus(annotation, asset.notePath ?? asset.filePath);
		const linkText = buildAnnotationLinkText(annotation);
		const item = parent.createEl("button", {
			cls: `media-vault-annotation-tab-item ${this.selectedAnnotationId === annotation.id ? "is-active" : ""}`,
		});
		item.addClass(`is-link-${linkStatus.state}`);
		item.style.setProperty("--media-vault-annotation-color", getAnnotationColor(annotation.color));
		const head = item.createDiv({cls: "media-vault-annotation-tab-item-head"});
		const title = head.createDiv({cls: "media-vault-annotation-title"});
		title.createSpan({cls: "media-vault-annotation-color-dot"});
		title.createSpan({text: annotation.label});
		head.createSpan({cls: `media-vault-annotation-link-status is-${linkStatus.state}`, text: linkStatus.label});
		item.createDiv({
			cls: "media-vault-annotation-tab-text",
			text: annotation.text ?? (linkText ? `[[${linkText}]]` : "未填写说明"),
		});
		const meta = item.createDiv({cls: "media-vault-annotation-tab-meta"});
		meta.createSpan({text: getAnnotationStorageLabel(getAnnotationStorageMode(annotation))});
		meta.createSpan({text: `区域 ${formatAnnotationPercent(annotation.x)} / ${formatAnnotationPercent(annotation.y)} / ${formatAnnotationPercent(annotation.width)} / ${formatAnnotationPercent(annotation.height)}`});
		if (linkText) {
			meta.createSpan({text: `[[${linkText}]]`});
		}
		const actions = item.createDiv({cls: "media-vault-annotation-tab-item-actions"});
		const locate = actions.createEl("span", {text: "定位"});
		locate.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.focusAnnotation(annotation);
		});
		const edit = actions.createEl("span", {text: "编辑"});
		edit.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.editAnnotation(annotation);
		});
		const open = actions.createEl("span", {text: "打开目标"});
		if (linkStatus.state !== "ok") {
			open.addClass("is-disabled");
		}
		open.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (linkStatus.state === "ok") {
				void this.plugin.openAnnotationTarget(annotation, asset.notePath ?? asset.filePath);
			}
		});
		const remove = actions.createEl("span", {cls: "is-danger", text: "删除"});
		remove.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.deleteAnnotation(annotation);
		});
		item.addEventListener("click", () => this.focusAnnotation(annotation));
	}

	private renderAnnotationEditor(parent: Element, asset: Asset): void {
		const selectedAnnotation = this.getSelectedAnnotation(asset);
		parent.createDiv({cls: "media-vault-section-title", text: selectedAnnotation ? `编辑区域标注：${selectedAnnotation.label}` : "区域标注编辑"});
		parent.createDiv({
			cls: "media-vault-annotation-edit-hint",
			text: selectedAnnotation ? "拖动标注框或四角调整区域；Esc 取消当前编辑，Delete 删除选中标注。" : "在图片上拖拽创建区域，填写信息后保存；Esc 可取消当前框选。",
		});
		const form = parent.createDiv({cls: "media-vault-annotation-form"});
		this.renderAnnotationInput(form, "标注名称", "label");
		this.renderAnnotationInput(form, "说明", "text");
		this.renderAnnotationInput(form, "链接笔记", "linkedNotePath");
		this.renderAnnotationInput(form, "链接标题", "linkedHeading");
		this.renderAnnotationInput(form, "链接块 ID", "linkedBlockId");
		this.renderAnnotationTargetPicker(form, asset);
		this.renderAnnotationColorPicker(form);
		this.renderAnnotationStorageOptions(form);
		this.renderAnnotationLinkPreview(form);
		const rect = form.createDiv({cls: "media-vault-annotation-rect-grid"});
		this.renderAnnotationNumber(rect, "X", "x");
		this.renderAnnotationNumber(rect, "Y", "y");
		this.renderAnnotationNumber(rect, "宽", "width");
		this.renderAnnotationNumber(rect, "高", "height");
		const validationErrors = this.getAnnotationDraftValidationErrors();
		this.renderAnnotationValidation(parent, validationErrors);
		const actions = parent.createDiv({cls: "media-vault-detail-actions"});
		const save = actions.createEl("button", {cls: "mod-cta", text: selectedAnnotation ? "保存修改" : "保存标注"});
		save.disabled = validationErrors.length > 0;
		save.addEventListener("click", () => {
			void this.saveAnnotation(asset);
		});
		if (selectedAnnotation) {
			const linkStatus = this.getAnnotationLinkStatus(selectedAnnotation, asset.notePath ?? asset.filePath);
			const open = actions.createEl("button", {text: "打开目标"});
			open.disabled = linkStatus.state !== "ok";
			open.addEventListener("click", () => {
				void this.plugin.openAnnotationTarget(selectedAnnotation, asset.notePath ?? asset.filePath);
			});
			const remove = actions.createEl("button", {cls: "mod-warning", text: "删除标注"});
			remove.addEventListener("click", () => {
				this.deleteAnnotation(selectedAnnotation);
			});
		}
		const create = actions.createEl("button", {text: "新建标注"});
		create.addEventListener("click", () => {
			this.selectedAnnotationId = null;
			this.annotationDraft = this.createAnnotationDraft();
			this.detailMode = "annotation";
			this.render();
		});
		const cancel = actions.createEl("button", {text: "取消标注模式"});
		cancel.addEventListener("click", () => {
			this.detailMode = "detail";
			this.annotationDraft = this.createAnnotationDraft();
			this.render();
		});
	}

	private renderAnnotationColorPicker(parent: Element): void {
		const wrapper = parent.createDiv({cls: "media-vault-annotation-color-field"});
		wrapper.createEl("label", {text: "标注颜色"});
		const swatches = wrapper.createDiv({cls: "media-vault-annotation-color-swatches"});
		for (const color of ANNOTATION_COLOR_SWATCHES) {
			const button = swatches.createEl("button", {
				cls: this.annotationDraft.color === color ? "is-active" : "",
				attr: {
					type: "button",
					"aria-label": `选择颜色 ${color}`,
				},
			});
			button.style.setProperty("--media-vault-annotation-color", color);
			button.addEventListener("click", () => {
				this.annotationDraft.color = color;
				this.render();
			});
		}
		const custom = wrapper.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "text",
				value: this.annotationDraft.color,
				placeholder: "#5a50d8",
			},
		});
		custom.addEventListener("input", () => {
			this.annotationDraft.color = custom.value.trim();
			this.updateAnnotationDraftColorPreview();
			this.updateAnnotationAssistPreview();
		});
		const preview = wrapper.createDiv({cls: "media-vault-annotation-color-preview"});
		preview.style.setProperty("--media-vault-annotation-color", getAnnotationColor(this.annotationDraft.color));
	}

	private renderAnnotationValidation(parent: Element, errors: string[]): void {
		if (errors.length === 0) {
			parent.createDiv({cls: "media-vault-annotation-validation is-ok", text: "标注坐标和链接目标有效。"});
			return;
		}

		const panel = parent.createDiv({cls: "media-vault-annotation-validation"});
		panel.createDiv({cls: "media-vault-annotation-validation-title", text: "保存前需要修正"});
		for (const error of errors) {
			panel.createDiv({text: error});
		}
	}

	private updateAnnotationDraftColorPreview(): void {
		const color = getAnnotationColor(this.annotationDraft.color);
		const preview = this.contentEl.querySelector<HTMLElement>(".media-vault-annotation-color-preview");
		if (preview) {
			preview.style.setProperty("--media-vault-annotation-color", color);
		}
		const overlay = this.selectedAnnotationId
			? findAnnotationOverlay(this.contentEl, this.selectedAnnotationId)
			: this.contentEl.querySelector<HTMLElement>(".media-vault-annotation-box.is-draft");
		if (overlay) {
			overlay.style.setProperty("--media-vault-annotation-color", color);
		}
	}

	private renderAnnotationInput(parent: Element, label: string, field: "label" | "text" | "linkedNotePath" | "linkedHeading" | "linkedBlockId"): void {
		const wrapper = parent.createDiv({cls: "media-vault-filter-field"});
		wrapper.createEl("label", {text: label});
		const input = wrapper.createEl("input", {cls: "media-vault-filter-input", attr: {type: "text", value: this.annotationDraft[field]}});
		input.addEventListener("input", () => {
			this.annotationDraft[field] = input.value;
			this.updateAnnotationLinkPreview();
		});
	}

	private renderAnnotationTargetPicker(parent: Element, asset: Asset): void {
		const wrapper = parent.createDiv({cls: "media-vault-annotation-target-picker"});
		wrapper.createEl("label", {text: "快捷绑定目标"});

		const notes = this.getAnnotationTargetNoteCandidates(asset);
		const noteRow = wrapper.createDiv({cls: "media-vault-annotation-target-row"});
		if (notes.length === 0) {
			noteRow.createSpan({cls: "media-vault-annotation-target-empty", text: "当前没有可用 Markdown 笔记。"});
		}
		for (const note of notes.slice(0, 8)) {
			const button = noteRow.createEl("button", {
				cls: this.annotationDraft.linkedNotePath === note.path ? "is-active" : "",
				text: getPathBasename(note.path),
			});
			button.setAttr("aria-label", `绑定到 ${note.path}`);
			button.addEventListener("click", () => {
				this.annotationDraft.linkedNotePath = note.path;
				this.annotationDraft.linkedHeading = "";
				this.annotationDraft.linkedBlockId = "";
				this.render();
			});
		}

		const targetFile = this.getAnnotationDraftTargetFile(asset) ?? notes[0];
		if (!targetFile) {
			return;
		}

		const cache = this.app.metadataCache.getFileCache(targetFile);
		const headings = cache?.headings ?? [];
		const blocks = Object.keys(cache?.blocks ?? {});
		const headingRow = wrapper.createDiv({cls: "media-vault-annotation-target-row"});
		headingRow.createSpan({cls: "media-vault-annotation-target-label", text: "标题"});
		if (headings.length === 0) {
			headingRow.createSpan({cls: "media-vault-annotation-target-empty", text: "无标题"});
		}
		for (const heading of headings.slice(0, 8)) {
			const active = stripHeadingForLink(this.annotationDraft.linkedHeading).toLowerCase() === stripHeadingForLink(heading.heading).toLowerCase();
			const button = headingRow.createEl("button", {cls: active ? "is-active" : "", text: `# ${heading.heading}`});
			button.addEventListener("click", () => {
				this.annotationDraft.linkedNotePath = targetFile.path;
				this.annotationDraft.linkedHeading = heading.heading;
				this.annotationDraft.linkedBlockId = "";
				this.render();
			});
		}
		if (headings.length > 8) {
			headingRow.createSpan({cls: "media-vault-annotation-target-more", text: `+${headings.length - 8}`});
		}

		const blockRow = wrapper.createDiv({cls: "media-vault-annotation-target-row"});
		blockRow.createSpan({cls: "media-vault-annotation-target-label", text: "块"});
		if (blocks.length === 0) {
			blockRow.createSpan({cls: "media-vault-annotation-target-empty", text: "无块引用"});
		}
		for (const blockId of blocks.slice(0, 8)) {
			const normalizedBlockId = blockId.replace(/^\^/, "");
			const active = this.annotationDraft.linkedBlockId.replace(/^\^/, "") === normalizedBlockId;
			const button = blockRow.createEl("button", {cls: active ? "is-active" : "", text: `^${normalizedBlockId}`});
			button.addEventListener("click", () => {
				this.annotationDraft.linkedNotePath = targetFile.path;
				this.annotationDraft.linkedHeading = "";
				this.annotationDraft.linkedBlockId = normalizedBlockId;
				this.render();
			});
		}
		if (blocks.length > 8) {
			blockRow.createSpan({cls: "media-vault-annotation-target-more", text: `+${blocks.length - 8}`});
		}
	}

	private getAnnotationTargetNoteCandidates(asset: Asset): TFile[] {
		const paths = new Set<string>();
		const activeNote = this.plugin.getActiveMarkdownFile();
		if (activeNote) {
			paths.add(activeNote.path);
		}
		if (asset.notePath) {
			paths.add(asset.notePath);
		}
		for (const reference of this.plugin.services.assetRepository.getReferencesForAsset(asset.id)) {
			paths.add(reference.sourceNotePath);
		}

		const files: TFile[] = [];
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === "md") {
				files.push(file);
			}
		}
		return files;
	}

	private getAnnotationDraftTargetFile(asset: Asset): TFile | null {
		const linkedNotePath = this.annotationDraft.linkedNotePath.trim();
		if (!linkedNotePath) {
			return null;
		}
		const directFile = this.app.vault.getAbstractFileByPath(linkedNotePath);
		if (directFile instanceof TFile && directFile.extension === "md") {
			return directFile;
		}
		const sourcePath = asset.notePath ?? asset.filePath;
		return this.app.metadataCache.getFirstLinkpathDest(linkedNotePath, sourcePath);
	}

	private renderAnnotationStorageOptions(parent: Element): void {
		const wrapper = parent.createDiv({cls: "media-vault-annotation-storage"});
		wrapper.createEl("label", {text: "写入位置"});
		const options = wrapper.createDiv({cls: "media-vault-annotation-storage-options"});
		for (const option of [
			{id: "asset-note" as const, label: "写入 Asset Note", description: "保存到素材笔记 frontmatter，便于长期迁移和双链审计。"},
			{id: "index" as const, label: "仅插件索引", description: "只写入本插件索引，适合临时标注或大量细碎标注。"},
		]) {
			const button = options.createEl("button", {
				cls: this.annotationDraft.storageMode === option.id ? "is-active" : "",
			});
			button.createSpan({cls: "media-vault-annotation-storage-title", text: option.label});
			button.createSpan({cls: "media-vault-annotation-storage-desc", text: option.description});
			button.addEventListener("click", () => {
				this.annotationDraft.storageMode = option.id;
				this.render();
			});
		}
	}

	private renderAnnotationLinkPreview(parent: Element): void {
		const wrapper = parent.createDiv({cls: "media-vault-annotation-link-preview"});
		wrapper.createSpan({cls: "media-vault-annotation-link-preview-label", text: "链接预览"});
		const status = this.getAnnotationDraftLinkStatus();
		wrapper.createSpan({
			cls: "media-vault-annotation-link-preview-value",
			text: status.linkText ? `[[${status.linkText}]]` : "未绑定笔记、标题或块引用",
		});
		wrapper.createSpan({cls: `media-vault-annotation-link-preview-status is-${status.state}`, text: status.label});
	}

	private updateAnnotationLinkPreview(): void {
		const preview = this.contentEl.querySelector<HTMLElement>(".media-vault-annotation-link-preview-value");
		const status = this.contentEl.querySelector<HTMLElement>(".media-vault-annotation-link-preview-status");
		const linkStatus = this.getAnnotationDraftLinkStatus();
		if (preview) {
			preview.setText(linkStatus.linkText ? `[[${linkStatus.linkText}]]` : "未绑定笔记、标题或块引用");
		}
		if (status) {
			status.className = `media-vault-annotation-link-preview-status is-${linkStatus.state}`;
			status.setText(linkStatus.label);
		}
		this.updateAnnotationAssistPreview();
	}

	private getAnnotationDraftLinkStatus(): AnnotationLinkStatus {
		const detailAsset = this.plugin.getDetailAsset();
		const sourcePath = detailAsset?.notePath ?? detailAsset?.filePath ?? "";
		return this.getAnnotationLinkStatus(this.annotationDraft, sourcePath);
	}

	private updateAnnotationAssistPreview(): void {
		const detailAsset = this.plugin.getDetailAsset();
		if (!detailAsset) {
			return;
		}

		const link = this.contentEl.querySelector<HTMLElement>(".media-vault-annotation-assist-link");
		const status = this.contentEl.querySelector<HTMLElement>(".media-vault-annotation-assist-status");
		const summary = this.contentEl.querySelector<HTMLElement>(".media-vault-annotation-assist-summary");
		const code = this.contentEl.querySelector<HTMLElement>(".media-vault-annotation-assist-code");
		const linkStatus = this.getAnnotationDraftLinkStatus();
		if (link) {
			link.setText(linkStatus.linkText ? `[[${linkStatus.linkText}]]` : "未绑定笔记、标题或块引用");
		}
		if (status) {
			status.className = `media-vault-annotation-assist-status is-${linkStatus.state}`;
			status.setText(linkStatus.label);
		}
		if (summary) {
			summary.setText(this.getAnnotationDraftStorageSummary(detailAsset));
		}
		if (code) {
			code.setText(this.buildAnnotationDraftStoragePreview(detailAsset));
		}
	}

	private getAnnotationDraftStorageSummary(asset: Asset): string {
		const label = this.annotationDraft.label.trim() || `A${this.plugin.services.assetRepository.getAnnotationsForAsset(asset.id).length + 1}`;
		const target = this.getAnnotationDraftLinkStatus().linkText;
		const storage = this.annotationDraft.storageMode === "asset-note" ? "写入 Asset Note frontmatter" : "仅写入插件索引";
		return target ? `${label} 将${storage}，并链接到 [[${target}]]。` : `${label} 将${storage}，暂不绑定 Obsidian 目标。`;
	}

	private buildAnnotationDraftStoragePreview(asset: Asset): string {
		const label = this.annotationDraft.label.trim() || `A${this.plugin.services.assetRepository.getAnnotationsForAsset(asset.id).length + 1}`;
		const linkText = this.getAnnotationDraftLinkStatus().linkText;
		const lines = [
			"annotations:",
			`  - id: ${this.selectedAnnotationId ?? "new"}`,
			`    label: ${label}`,
			`    rect: [${formatAnnotationPercent(this.annotationDraft.x)}, ${formatAnnotationPercent(this.annotationDraft.y)}, ${formatAnnotationPercent(this.annotationDraft.width)}, ${formatAnnotationPercent(this.annotationDraft.height)}]`,
			`    color: ${getAnnotationColor(this.annotationDraft.color)}`,
			`    storage: ${this.annotationDraft.storageMode}`,
		];
		const text = this.annotationDraft.text.trim();
		if (text) {
			lines.push(`    text: ${text}`);
		}
		if (linkText) {
			lines.push(`    link: ${linkText}`);
		}
		return lines.join("\n");
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

	private renderAnnotationNumber(parent: Element, label: string, field: "x" | "y" | "width" | "height"): void {
		const wrapper = parent.createDiv({cls: "media-vault-filter-field"});
		wrapper.createEl("label", {text: label});
		const input = wrapper.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "number",
				min: "0",
				max: "1",
				step: "0.01",
				value: String(this.annotationDraft[field]),
			},
		});
		input.addEventListener("input", () => {
			const parsed = Number(input.value);
			if (Number.isFinite(parsed)) {
				this.annotationDraft[field] = clamp(parsed, 0, 1);
				this.render();
			}
		});
	}

	private renderVersionsPanel(parent: Element, asset: Asset): void {
		parent.createDiv({cls: "media-vault-section-title", text: "版本与变体"});
		const summary = parent.createDiv({cls: "media-vault-version-summary"});
		summary.createDiv({cls: "media-vault-version-summary-item", text: "原图"});
		summary.createDiv({text: asset.filePath});
		summary.createDiv({cls: "media-vault-version-summary-item", text: "派生版本"});
		summary.createDiv({text: "压缩/格式转换当前处于 dry run 阶段，生成后会记录在这里。"});

		const list = parent.createDiv({cls: "media-vault-version-list"});
		this.renderVersionRow(list, {
			label: "原图",
			value: asset.filename,
			meta: `${formatDimensions(asset)} · ${formatFileSize(asset.sizeBytes)} · ${asset.ext.toUpperCase()}`,
			status: asset.status,
		});
		this.renderVersionRow(list, {
			label: "缩略图 300",
			value: asset.thumbnail.thumb300 ?? "未生成",
			meta: "用于小卡片和列表快速预览",
			status: asset.thumbnail.thumb300 ? "ready" : "missing",
		});
		this.renderVersionRow(list, {
			label: "缩略图 800",
			value: asset.thumbnail.thumb800 ?? "未生成",
			meta: "用于 Inspector 和详情页预览",
			status: asset.thumbnail.thumb800 ? "ready" : "missing",
		});
		if (typeof asset.thumbnail.updatedAt === "number") {
			this.renderVersionRow(list, {
				label: "缩略图更新时间",
				value: formatDateTime(asset.thumbnail.updatedAt),
				meta: "缓存可删除并重建",
				status: "cache",
			});
		}

		const variants = this.getVersionCandidates(asset);
		parent.createDiv({cls: "media-vault-section-title", text: "潜在重复 / 变体"});
		if (variants.length === 0) {
			parent.createDiv({cls: "media-vault-hint", text: "当前索引未发现相同 hash 或相同感知 hash 的图片。"});
			return;
		}

		const variantList = parent.createDiv({cls: "media-vault-version-list"});
		for (const candidate of variants.slice(0, 12)) {
			this.renderVersionRow(variantList, {
				label: candidate.sha256 && candidate.sha256 === asset.sha256 ? "完全重复" : "视觉相似",
				value: candidate.filename,
				meta: `${candidate.filePath} · ${formatFileSize(candidate.sizeBytes)}`,
				status: candidate.status,
			});
		}
	}

	private renderVersionRow(parent: Element, entry: {label: string; value: string; meta: string; status: string}): void {
		const row = parent.createDiv({cls: "media-vault-version-row"});
		row.createSpan({cls: "media-vault-version-label", text: entry.label});
		const body = row.createDiv({cls: "media-vault-version-body"});
		body.createDiv({cls: "media-vault-version-value", text: entry.value});
		body.createDiv({cls: "media-vault-version-meta", text: entry.meta});
		row.createSpan({cls: "media-vault-version-status", text: entry.status});
	}

	private getVersionCandidates(asset: Asset): Asset[] {
		return getDuplicateCandidates(asset, this.plugin.services.assetRepository.getAssets());
	}

	private getVariantDeleteCandidates(assetIds: string[]): Asset[] {
		const selectedIds = new Set(assetIds);
		const candidates = new Map<string, Asset>();
		for (const assetId of assetIds) {
			const asset = this.plugin.services.assetRepository.getAssetById(assetId);
			if (!asset) {
				continue;
			}
			for (const candidate of this.getVersionCandidates(asset)) {
				if (selectedIds.has(candidate.id) || candidate.status !== "active") {
					continue;
				}
				candidates.set(candidate.id, candidate);
			}
		}
		return Array.from(candidates.values()).sort((left, right) => right.mtime - left.mtime || left.filename.localeCompare(right.filename));
	}

	private getDeleteTargetAssetIds(assetIds: string[]): string[] {
		if (!this.deleteIncludeVariants) {
			return assetIds;
		}
		const targetIds = new Set(assetIds);
		for (const candidate of this.getVariantDeleteCandidates(assetIds)) {
			targetIds.add(candidate.id);
		}
		return Array.from(targetIds);
	}

		private renderMetadataPanel(parent: Element, asset: Asset): void {
			const ocrResult = this.plugin.services.ocrService.getResult(asset.id);
			this.renderMetadataSection(parent, "文件", [
			["ID", asset.id],
			["文件名", asset.filename],
			["路径", asset.filePath],
			["格式", asset.ext.toUpperCase()],
			["MIME", asset.mimeType],
			["大小", formatFileSize(asset.sizeBytes)],
			["尺寸", formatDimensions(asset)],
			["创建时间", formatDateTime(asset.ctime)],
			["修改时间", formatDateTime(asset.mtime)],
			["索引时间", formatDateTime(asset.createdAt)],
			["状态", asset.status],
			["来源", asset.origin],
		]);
		this.renderMetadataSection(parent, "索引", [
			["引用次数", `${asset.referenceCount} 处`],
				["区域标注", `${this.plugin.services.assetRepository.getAnnotationsForAsset(asset.id).length} 个`],
				["文本识别", ocrResult ? `${ocrResult.text.length} 字 · ${ocrResult.blocks.length} 块` : "未保存"],
				["Asset Note", asset.notePath ?? "未创建"],
			["收藏", asset.favorite ? "是" : "否"],
			["评分", typeof asset.rating === "number" ? `${asset.rating} 星` : "未评分"],
			["SHA-256", asset.sha256 ?? "未计算"],
			["感知 hash", asset.perceptualHash ?? "未计算"],
			["缩略图 300", asset.thumbnail.thumb300 ?? "未生成"],
			["缩略图 800", asset.thumbnail.thumb800 ?? "未生成"],
		]);
		this.renderMetadataSection(parent, "组织", [
			["标签", asset.tags.join("、") || "无"],
			["Collections", asset.collections.join("、") || "无"],
			["主色", (asset.dominantColors ?? []).join("、") || "无"],
		]);
		this.renderMetadataColorSwatches(parent, asset);
	}

	private renderMetadataSection(parent: Element, title: string, rows: Array<[string, string]>): void {
		const section = parent.createDiv({cls: "media-vault-metadata-section"});
		section.createDiv({cls: "media-vault-section-title", text: title});
		for (const [label, value] of rows) {
			this.renderMetaRow(section, label, value);
		}
	}

	private renderMetadataColorSwatches(parent: Element, asset: Asset): void {
		const colors = asset.dominantColors ?? [];
		if (colors.length === 0) {
			return;
		}

		const swatches = parent.createDiv({cls: "media-vault-metadata-swatches"});
		for (const color of colors) {
			const swatch = swatches.createSpan({cls: "media-vault-metadata-swatch"});
			swatch.style.backgroundColor = color;
			swatch.setAttr("aria-label", color);
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

	private renderAssetNoteStatus(parent: Element, asset: Asset): void {
		const state = this.getAssetNoteStatus(asset);
		const status = parent.createSpan({cls: `media-vault-asset-note-status is-${state.id}`, text: state.label});
		status.dataset.mediaVaultAssetNoteStatus = "true";
		status.setAttr("aria-label", `Asset Note 状态：${state.label}`);
	}

	private updateAssetNoteStatus(asset: Asset): void {
		const status = this.contentEl.querySelector<HTMLElement>("[data-media-vault-asset-note-status='true']");
		if (!status) {
			return;
		}
		const state = this.getAssetNoteStatus(asset);
		status.className = `media-vault-asset-note-status is-${state.id}`;
		status.setText(state.label);
		status.setAttr("aria-label", `Asset Note 状态：${state.label}`);
	}

	private getAssetNoteStatus(asset: Asset): {id: "loading" | "missing" | "ready" | "dirty"; label: string} {
		if (this.assetNoteAssetId !== asset.id || this.assetNoteContent === "正在加载素材笔记…") {
			return {id: "loading", label: "Asset Note 加载中"};
		}
		if (this.assetNoteContent !== this.assetNoteSavedContent) {
			return {id: "dirty", label: asset.notePath ? "Asset Note 未保存" : "Asset Note 待创建"};
		}
		if (!asset.notePath) {
			return {id: "missing", label: "Asset Note 未创建"};
		}
		return {id: "ready", label: "Asset Note 已连接"};
	}

	private async saveAssetNoteFromDetail(asset: Asset): Promise<void> {
		const content = this.assetNoteContent;
		await this.plugin.saveAssetNote(asset, content);
		if (this.assetNoteAssetId !== asset.id) {
			return;
		}
		this.assetNoteSavedContent = content;
		this.updateAssetNoteStatus(asset);
	}

	private hasUnsavedAssetNote(asset: Asset): boolean {
		return this.assetNoteAssetId === asset.id
			&& this.assetNoteContent !== "正在加载素材笔记…"
			&& this.assetNoteContent !== this.assetNoteSavedContent;
	}

	private confirmAssetNoteLeave(asset: Asset, onContinue: () => void): void {
		if (!this.hasUnsavedAssetNote(asset)) {
			onContinue();
			return;
		}

		new AssetNoteUnsavedConfirmModal(
			this.app,
			asset,
			async () => {
				await this.saveAssetNoteFromDetail(asset);
				onContinue();
			},
			() => {
				this.assetNoteContent = this.assetNoteSavedContent;
				this.updateAssetNoteStatus(asset);
				onContinue();
			},
		).open();
	}

	private selectAnnotation(annotation: Annotation): void {
		if (!this.isAnnotationEditMode()) {
			this.focusAnnotation(annotation);
			return;
		}

		this.selectedAnnotationId = annotation.id;
		this.detailTab = "annotations";
		this.detailMode = "annotation";
		this.annotationDraft = annotationToDraft(annotation);
		this.plugin.openAssetDetail(annotation.assetId, "annotation", annotation.id);
	}

	private focusAnnotation(annotation: Annotation): void {
		this.selectedAnnotationId = annotation.id;
		this.detailTab = "annotations";
		this.detailMode = "detail";
		this.annotationDraft = annotationToDraft(annotation);
		this.plugin.setDetailPanel("annotations");
	}

	private editAnnotation(annotation: Annotation): void {
		this.selectedAnnotationId = annotation.id;
		this.detailTab = "annotations";
		this.detailMode = "annotation";
		this.annotationDraft = annotationToDraft(annotation);
		this.plugin.openAssetDetail(annotation.assetId, "annotation", annotation.id);
	}

	private getSelectedAnnotation(asset: Asset): Annotation | undefined {
		if (!this.selectedAnnotationId) {
			return undefined;
		}
		return this.plugin.services.assetRepository
			.getAnnotationsForAsset(asset.id)
			.find((annotation) => annotation.id === this.selectedAnnotationId);
	}

	private getAnnotationDraftValidationErrors(): string[] {
		const errors: string[] = [];
		const {x, y, width, height} = this.annotationDraft;
		if (![x, y, width, height].every(Number.isFinite)) {
			errors.push("坐标必须是 0 到 1 之间的数字。");
		}
		if (width < ANNOTATION_MIN_SIZE || height < ANNOTATION_MIN_SIZE) {
			errors.push(`区域宽高不能小于 ${Math.round(ANNOTATION_MIN_SIZE * 100)}%。`);
		}
		if (x < 0 || y < 0 || x + width > 1 || y + height > 1) {
			errors.push("区域必须完整落在图片范围内。");
		}
		if (!isAnnotationColor(this.annotationDraft.color)) {
			errors.push("标注颜色必须是 #RRGGBB 格式。");
		}
		const linkStatus = this.getAnnotationDraftLinkStatus();
		if (linkStatus.state !== "none" && linkStatus.state !== "ok") {
			errors.push(linkStatus.label);
		}
		return errors;
	}

	private async saveAnnotation(asset: Asset): Promise<void> {
		const validationErrors = this.getAnnotationDraftValidationErrors();
		if (validationErrors.length > 0) {
			new Notice(`区域标注未保存：${validationErrors[0]}`);
			this.render();
			return;
		}

		const now = Date.now();
		const existingAnnotation = this.getSelectedAnnotation(asset);
		const previousStorageMode = existingAnnotation ? getAnnotationStorageMode(existingAnnotation) : null;
		const annotation: Annotation = {
			id: existingAnnotation?.id ?? `ann-${asset.id}-${now}`,
			assetId: asset.id,
			label: this.annotationDraft.label.trim() || `A${this.plugin.services.assetRepository.getAnnotationsForAsset(asset.id).length + 1}`,
			x: this.annotationDraft.x,
			y: this.annotationDraft.y,
			width: this.annotationDraft.width,
			height: this.annotationDraft.height,
			color: getAnnotationColor(this.annotationDraft.color),
			text: this.annotationDraft.text.trim() || undefined,
			linkedNotePath: this.annotationDraft.linkedNotePath.trim() || undefined,
			linkedHeading: this.annotationDraft.linkedHeading.trim() || undefined,
			linkedBlockId: this.annotationDraft.linkedBlockId.trim() || undefined,
			storageMode: this.annotationDraft.storageMode,
			createdAt: existingAnnotation?.createdAt ?? now,
			updatedAt: now,
		};
		await this.plugin.services.assetRepository.upsertAnnotation(annotation);
		if (annotation.storageMode === "asset-note" || previousStorageMode === "asset-note") {
			await this.plugin.syncAssetNoteAnnotations(asset.id);
		}
		this.selectedAnnotationId = annotation.id;
		this.annotationDraft = this.createAnnotationDraft();
		this.detailMode = "detail";
		new Notice("已保存区域标注。");
		this.render();
	}

	private deleteAnnotation(annotation: Annotation): void {
		new AnnotationDeleteConfirmModal(this.app, annotation, async () => {
			await this.plugin.services.assetRepository.deleteAnnotation(annotation.id);
			if (getAnnotationStorageMode(annotation) === "asset-note") {
				await this.plugin.syncAssetNoteAnnotations(annotation.assetId);
				}
				if (this.selectedAnnotationId === annotation.id) {
					this.selectedAnnotationId = null;
					this.annotationDraft = this.createAnnotationDraft();
				}
			new Notice("已删除区域标注。");
			this.render();
		}).open();
	}

	private renderToolbar(main: Element, resultCount: number): void {
		const toolbar = main.createDiv({cls: "media-vault-toolbar"});
		const scope = toolbar.createDiv({cls: "media-vault-toolbar-scope"});
		const scopeRow = scope.createDiv({cls: "media-vault-toolbar-title-row"});
		scopeRow.createDiv({cls: "media-vault-toolbar-title", text: this.getToolbarTitle()});
		const result = scopeRow.createDiv({cls: "media-vault-result-count", text: `${resultCount.toLocaleString()} 项`});
		result.setAttr("aria-live", "polite");

		const searchWrap = toolbar.createDiv({cls: "media-vault-search-wrap"});
		const search = toolbar.createEl("input", {
			cls: "media-vault-search",
			attr: {
				type: "search",
				placeholder: "搜索",
				value: this.searchText,
			},
		});
		searchWrap.appendChild(search);
		search.addEventListener("change", () => {
			this.searchText = search.value;
			this.gridScrollTop = 0;
			this.render();
		});

		if (this.selectedAssetIds.size > 0) {
			toolbar.createDiv({cls: "media-vault-selection-count", text: `已选择 ${this.selectedAssetIds.size}`});
			const cancelSelection = toolbar.createEl("button", {text: "取消选择"});
			cancelSelection.addEventListener("click", () => this.clearSelection());
			const batchAction = toolbar.createEl("button", {cls: "mod-cta", text: "批量操作"});
			batchAction.addEventListener("click", () => this.openBatchModal());
		}

		const controls = toolbar.createDiv({cls: "media-vault-toolbar-controls"});
		const primaryActions = controls.createDiv({cls: "media-vault-toolbar-primary-actions"});
		const appliedFilterCount = this.getAppliedFilterChips().length;
		const filterButton = this.createToolbarIconButton(
			primaryActions,
			"filter",
			appliedFilterCount > 0 ? `筛选，已启用 ${appliedFilterCount} 个条件` : "筛选",
			this.filterDrawerOpen || this.hasAppliedFilters() ? "is-active" : "",
		);
		if (appliedFilterCount > 0) {
			filterButton.createSpan({cls: "media-vault-toolbar-badge", text: String(appliedFilterCount)});
		}
		filterButton.addEventListener("click", () => {
			this.openFilterDrawer();
		});

		const currentLayout = this.getCurrentLayoutOption();
		const layoutButton = this.createToolbarIconButton(
			primaryActions,
			getToolbarLayoutIcon(this.viewMode),
			`布局：${currentLayout.label}`,
			`media-vault-layout-button ${this.layoutPopoverOpen ? "is-active" : ""}`,
		);
		layoutButton.setAttr("aria-expanded", String(this.layoutPopoverOpen));
		layoutButton.setAttr("aria-haspopup", "true");
		layoutButton.addEventListener("click", () => {
			this.layoutPopoverOpen = !this.layoutPopoverOpen;
			this.render();
		});

		const thumbnailControl = controls.createDiv({cls: "media-vault-thumbnail-control"});
		const thumbnailOut = this.createToolbarIconButton(thumbnailControl, "minus", "缩小缩略图", "media-vault-thumbnail-step");
		thumbnailOut.disabled = this.thumbnailScale <= THUMBNAIL_SCALE_MIN;
		thumbnailOut.addEventListener("click", () => this.updateThumbnailScale(this.thumbnailScale - 0.05));
		const thumbnailInput = thumbnailControl.createEl("input", {
			attr: {
				type: "range",
				min: String(THUMBNAIL_SCALE_MIN * 100),
				max: String(THUMBNAIL_SCALE_MAX * 100),
				step: "5",
				value: String(Math.round(this.thumbnailScale * 100)),
				"aria-label": "缩略图尺寸",
			},
		});
		thumbnailInput.addEventListener("input", () => {
			this.thumbnailScale = clamp(Number(thumbnailInput.value) / 100, THUMBNAIL_SCALE_MIN, THUMBNAIL_SCALE_MAX);
			this.gridScrollTop = 0;
			this.render();
		});
		const thumbnailIn = this.createToolbarIconButton(thumbnailControl, "plus", "放大缩略图", "media-vault-thumbnail-step");
		thumbnailIn.disabled = this.thumbnailScale >= THUMBNAIL_SCALE_MAX;
		thumbnailIn.addEventListener("click", () => this.updateThumbnailScale(this.thumbnailScale + 0.05));

		const moreButton = this.createToolbarIconButton(controls, "more-horizontal", "更多操作");
		moreButton.addEventListener("click", (event) => {
			const menu = new Menu();
			menu.addItem((item) => item
				.setTitle("保存为集合")
				.setIcon("bookmark-plus")
				.onClick(() => {
					this.openSmartCollectionBuilder(this.getEffectiveQuery());
				}));
			menu.addItem((item) => item
				.setTitle("重建索引")
				.setIcon("refresh-cw")
				.onClick(() => {
					void this.plugin.rebuildIndex(true);
				}));
			menu.showAtMouseEvent(event);
		});

		if (this.layoutPopoverOpen) {
			this.renderLayoutPopover(main);
		}
	}

	private createToolbarIconButton(parent: Element, icon: string, label: string, className = ""): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: ["media-vault-toolbar-icon-button", className].filter(Boolean).join(" "),
			attr: {
				type: "button",
				"aria-label": label,
				title: label,
			},
		});
		setIcon(button, icon);
		return button;
	}

	private updateThumbnailScale(nextScale: number): void {
		this.thumbnailScale = clamp(nextScale, THUMBNAIL_SCALE_MIN, THUMBNAIL_SCALE_MAX);
		this.gridScrollTop = 0;
		this.render();
	}

	private renderLayoutPopover(main: Element): void {
		const popover = main.createDiv({cls: "media-vault-layout-popover"});

		const layoutSection = popover.createDiv({cls: "media-vault-layout-popover-section"});
		this.renderPopoverSectionHead(layoutSection, "布局方式", "当前中区视图");
		const options = layoutSection.createDiv({cls: "media-vault-layout-options"});
		for (const option of GALLERY_LAYOUT_OPTIONS) {
			const button = options.createEl("button", {
				cls: `media-vault-layout-option ${this.viewMode === option.id ? "is-active" : ""}`,
				attr: {type: "button", title: option.description},
			});
			button.createSpan({cls: "media-vault-layout-option-icon", text: option.icon});
			button.createSpan({cls: "media-vault-layout-option-label", text: option.label});
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				this.setGalleryViewMode(option.id);
			});
		}

		const sortSection = popover.createDiv({cls: "media-vault-layout-popover-section"});
		this.renderPopoverSectionHead(sortSection, "排列方式", "可保存到集合");
		const sortRow = sortSection.createDiv({cls: "media-vault-layout-sort-row"});
		const sortSelect = sortRow.createEl("select", {cls: "media-vault-layout-sort-select"});
		for (const option of SORT_OPTIONS) {
			const optionEl = sortSelect.createEl("option", {text: option.label, value: option.id});
			optionEl.selected = option.id === this.sortOption;
		}
		sortSelect.addEventListener("change", () => {
			this.sortOption = parseSortOption(sortSelect.value);
			this.gridScrollTop = 0;
			this.render();
		});
		sortRow.createSpan({cls: "media-vault-layout-sort-direction is-active", text: "↓"});
		sortRow.createSpan({cls: "media-vault-layout-sort-direction", text: "↑"});

		const fieldSection = popover.createDiv({cls: "media-vault-layout-popover-section"});
		this.renderPopoverSectionHead(fieldSection, "显示内容", "影响卡片底部、列表列和紧凑浮层");
		const fieldGrid = fieldSection.createDiv({cls: "media-vault-display-field-grid"});
		for (const option of GALLERY_DISPLAY_FIELD_OPTIONS) {
			const label = fieldGrid.createEl("label", {cls: "media-vault-display-field"});
			label.createSpan({text: option.label});
			const switchEl = label.createSpan({cls: "media-vault-display-switch"});
			const checkbox = switchEl.createEl("input", {
				attr: {
					type: "checkbox",
					"aria-label": `显示${option.label}`,
				},
			});
			checkbox.checked = this.isGalleryDisplayFieldEnabled(option.id);
			switchEl.createSpan({cls: "media-vault-display-switch-track"});
			checkbox.addEventListener("change", () => {
				this.setGalleryDisplayField(option.id, checkbox.checked);
			});
		}

		const actions = popover.createDiv({cls: "media-vault-layout-popover-actions"});
		const reset = actions.createEl("button", {text: "恢复默认"});
		reset.addEventListener("click", () => this.resetGalleryDisplayFields());
		const done = actions.createEl("button", {cls: "mod-cta", text: "完成"});
		done.addEventListener("click", () => {
			this.layoutPopoverOpen = false;
			this.render();
		});
	}

	private renderPopoverSectionHead(parent: Element, title: string, caption: string): void {
		const head = parent.createDiv({cls: "media-vault-layout-popover-head"});
		head.createDiv({cls: "media-vault-layout-popover-title", text: title});
		head.createDiv({cls: "media-vault-layout-popover-caption", text: caption});
	}

	private getCurrentLayoutOption(): {id: GalleryViewMode; label: string; icon: string; description: string} {
		const fallback = GALLERY_LAYOUT_OPTIONS[0];
		if (!fallback) {
			throw new Error("Gallery layout options are not configured.");
		}
		return GALLERY_LAYOUT_OPTIONS.find((option) => option.id === this.viewMode) ?? fallback;
	}

	private setGalleryViewMode(viewMode: GalleryViewMode): void {
		if (this.viewMode === viewMode) {
			return;
		}

		this.viewMode = viewMode;
		this.gridScrollTop = 0;
		this.render();
	}

	private isGalleryDisplayFieldEnabled(field: MediaVaultGalleryDisplayField): boolean {
		return this.getGalleryDisplayFields()[field];
	}

	private getGalleryDisplayFields(): Record<MediaVaultGalleryDisplayField, boolean> {
		return {
			...DEFAULT_GALLERY_DISPLAY_FIELDS,
			...this.plugin.settings.galleryDisplayFields,
		};
	}

	private setGalleryDisplayField(field: MediaVaultGalleryDisplayField, enabled: boolean): void {
		this.plugin.settings.galleryDisplayFields = {
			...this.getGalleryDisplayFields(),
			[field]: enabled,
		};
		void this.plugin.saveSettings().catch((error) => {
			new Notice(`视图偏好保存失败：${getErrorMessage(error)}`);
		});
		this.render();
	}

	private resetGalleryDisplayFields(): void {
		this.plugin.settings.galleryDisplayFields = {...DEFAULT_GALLERY_DISPLAY_FIELDS};
		void this.plugin.saveSettings().catch((error) => {
			new Notice(`视图偏好保存失败：${getErrorMessage(error)}`);
		});
		this.render();
	}

	private applyGalleryDisplayFieldClasses(element: HTMLElement): void {
		for (const option of GALLERY_DISPLAY_FIELD_OPTIONS) {
			element.classList.toggle(`is-gallery-field-${option.id}-hidden`, !this.isGalleryDisplayFieldEnabled(option.id));
		}
	}

	private getAssetDescription(asset: Asset): string {
		if (asset.notePath) {
			return `素材笔记：${getPathBasename(asset.notePath)}`;
		}
		const parent = getParentPath(asset.filePath);
		return parent ? `目录：${parent}` : "暂无简介";
	}

	private getAssetRatingLabel(asset: Asset): string {
		if (!asset.rating || asset.rating <= 0) {
			return "未评分";
		}
		return "★★★★★".slice(0, asset.rating);
	}

	private getToolbarTitle(): string {
		const activeSmartCollection = this.getActiveSmartCollection();
		if (activeSmartCollection) {
			return activeSmartCollection.name;
		}

		const navQuery = this.plugin.getNavQuery();
		if (navQuery?.linkedByNote) {
			return `按笔记：${getPathBasename(navQuery.linkedByNote)}`;
		}
		if (navQuery?.linkedByFolder) {
			return `按项目：${getPathBasename(navQuery.linkedByFolder)}`;
		}
		if (navQuery?.tags?.length) {
			return `标签：${navQuery.tags.join("、")}`;
		}
		if (navQuery?.collections?.length) {
			return `Collection：${navQuery.collections.join("、")}`;
		}
		if (navQuery?.formats?.length) {
			return `格式：${navQuery.formats.map((format) => format.toUpperCase()).join("、")}`;
		}
		if (navQuery?.colors?.length) {
			return "主色筛选";
		}

		const labels: Record<QuickFilterId, string> = {
			all: "全部图片",
			unreferenced: "未引用",
			favorites: "收藏",
			recent: "最近使用",
			duplicates: "重复图片",
			trash: "回收站",
		};
		return labels[this.quickFilter] ?? "全部图片";
	}

	private renderFilterChips(main: Element): void {
		const chips = this.getAppliedFilterChips();
		if (chips.length === 0) {
			return;
		}

		const row = main.createDiv({cls: "media-vault-filter-chips"});
		for (const chip of chips) {
			const button = row.createEl("button", {cls: "media-vault-filter-chip", text: chip.label});
			button.createSpan({cls: "media-vault-filter-chip-x", text: "×"});
			button.addEventListener("click", () => {
				chip.remove();
			});
		}

		const save = row.createEl("button", {cls: "media-vault-filter-save", text: "保存为智能集合"});
		save.addEventListener("click", () => {
			this.draftQuery = this.getEffectiveQuery();
			this.openSmartCollectionBuilder(this.draftQuery);
		});

		const clear = row.createEl("button", {cls: "media-vault-filter-clear", text: "清空筛选"});
		clear.addEventListener("click", () => {
			this.searchText = "";
			this.appliedQuery = {};
			this.appliedQuerySource = "manual";
			this.plugin.setActiveCollection(null);
			this.gridScrollTop = 0;
			this.render();
		});
	}

	private renderActiveCollectionHeader(main: Element, collection: Collection, resultCount: number): void {
		const header = main.createDiv({cls: "media-vault-collection-header"});
		const top = header.createDiv({cls: "media-vault-collection-top"});
		const back = top.createEl("button", {cls: "media-vault-collection-back", text: "← 返回"});
		back.addEventListener("click", () => {
			this.plugin.setActiveCollection(null);
		});

		const titleBlock = top.createDiv({cls: "media-vault-collection-title-block"});
		titleBlock.createEl("h3", {text: collection.name});
		titleBlock.createDiv({
			cls: "media-vault-collection-subtitle",
			text: `Smart Collection · ${resultCount} 张图片 · 动态规则`,
		});

		const actions = top.createDiv({cls: "media-vault-collection-actions"});
		const edit = actions.createEl("button", {text: "编辑条件"});
		edit.addEventListener("click", () => {
			this.openSmartCollectionBuilder(this.getEffectiveQuery(), collection);
		});
		const save = actions.createEl("button", {cls: "mod-cta", text: "保存当前视图"});
		save.addEventListener("click", () => {
			void this.saveCurrentViewToSmartCollection(collection);
		});

		const query = this.getEffectiveQuery();
		const savedQuery = normalizeQuery(collection.query as AssetQuery);
		const dirty = getQueryKey(query) !== getQueryKey(savedQuery);
		if (dirty) {
			header.addClass("is-dirty");
			titleBlock.createDiv({cls: "media-vault-collection-dirty", text: "当前视图与已保存规则不同。"});
		}

		const chips = this.getAppliedFilterChips();
		const chipRow = header.createDiv({cls: "media-vault-collection-rule-chips"});
		if (chips.length === 0) {
			chipRow.createSpan({cls: "media-vault-collection-empty-rule", text: "当前集合没有筛选条件。"});
		} else {
			for (const chip of chips) {
				const button = chipRow.createEl("button", {cls: "media-vault-filter-chip", text: chip.label});
				button.createSpan({cls: "media-vault-filter-chip-x", text: "×"});
				button.addEventListener("click", () => {
					chip.remove();
				});
			}
		}
		const addFilter = chipRow.createEl("button", {cls: "media-vault-filter-clear", text: "＋ 添加筛选"});
		addFilter.addEventListener("click", () => {
			this.openFilterDrawerWithQuery(this.getEffectiveQuery());
		});
	}

	private renderAdvancedFilterDrawer(main: Element): void {
		const validationErrors = this.getDraftValidationErrors();
		const draftResultCount = validationErrors.length > 0 ? 0 : this.getDraftResultCount();
		const overlay = main.createDiv({cls: "media-vault-filter-overlay"});
		overlay.addEventListener("click", () => {
			this.filterDrawerOpen = false;
			this.render();
		});

		const drawer = main.createDiv({cls: "media-vault-filter-drawer"});
		const head = drawer.createDiv({cls: "media-vault-filter-drawer-head"});
		head.createEl("h3", {text: "高级筛选"});
		const hitCount = head.createSpan({
			cls: `media-vault-filter-hit ${validationErrors.length > 0 ? "is-error" : ""}`,
			text: validationErrors.length > 0 ? "条件有误" : `命中 ${draftResultCount} 张`,
		});
		const close = head.createEl("button", {cls: "media-vault-icon-button", text: "×"});
		close.addEventListener("click", () => {
			this.filterDrawerOpen = false;
			this.render();
		});

		const body = drawer.createDiv({cls: "media-vault-filter-drawer-body"});
		this.renderKeywordField(body, hitCount);
		this.renderFormatField(body, hitCount);
		this.renderReferenceField(body, hitCount);
		this.renderContentStateField(body, hitCount);
		this.renderLinkedScopeField(body, "关联笔记", "linkedByNote", "例如 Notes/Projects/项目复盘 2025.md", hitCount);
		this.renderLinkedScopeField(body, "关联目录", "linkedByFolder", "例如 Notes/Projects", hitCount);
		this.renderRatingField(body, hitCount);
		this.renderNumberRangeField(body, "大小", "minSizeKb", "maxSizeKb", "最小 KB", "最大 KB", hitCount);
		this.renderNumberRangeField(body, "尺寸宽度", "minWidth", "maxWidth", "最小 px", "最大 px", hitCount);
		this.renderNumberRangeField(body, "尺寸高度", "minHeight", "maxHeight", "最小 px", "最大 px", hitCount);
		this.renderRatioField(body, hitCount);
		this.renderNumberInputField(body, "引用次数", "minReferenceCount", "至少引用次数", hitCount);
		this.renderDateRangeField(body, "创建时间", "createdAfter", "createdBefore", hitCount);
		this.renderDateRangeField(body, "修改时间", "modifiedAfter", "modifiedBefore", hitCount);
		this.renderTextListField(body, "标签", "tags", "用逗号分隔标签", hitCount);
		this.renderTextListField(body, "Collections", "collections", "用逗号分隔集合名", hitCount);
		this.renderTextListField(body, "颜色", "colors", "例如 #635bff, #1f8f67", hitCount);

		const validation = body.createDiv({cls: "media-vault-filter-validation"});
		validation.dataset.mediaVaultFilterValidation = "true";
		this.renderDraftValidation(validation, validationErrors);

		const preview = body.createDiv({cls: "media-vault-filter-mini-result"});
		const previewCount = preview.createEl("b", {text: validationErrors.length > 0 ? "—" : String(draftResultCount)});
		previewCount.dataset.mediaVaultFilterMiniCount = "true";
		const previewText = preview.createSpan({
			text: validationErrors.length > 0
				? " 条件需要修正后才能应用筛选。"
				: " 张图片匹配当前条件；应用后会在 toolbar 下显示可删除的筛选 chips。",
		});
		previewText.dataset.mediaVaultFilterMiniText = "true";

		const foot = drawer.createDiv({cls: "media-vault-filter-drawer-foot"});
		const reset = foot.createEl("button", {text: "重置"});
		reset.addEventListener("click", () => {
			this.draftQuery = {};
			this.render();
		});
		const save = foot.createEl("button", {text: "保存为智能集合"});
		save.dataset.mediaVaultFilterSave = "true";
		save.disabled = validationErrors.length > 0 || isQueryEmpty(this.draftQuery);
		save.addEventListener("click", () => {
			this.openSmartCollectionBuilder(this.draftQuery);
		});
		const apply = foot.createEl("button", {cls: "mod-cta", text: "应用筛选"});
		apply.dataset.mediaVaultFilterApply = "true";
		apply.disabled = validationErrors.length > 0;
		apply.addEventListener("click", () => {
			this.applyDraftQuery();
		});
	}

	private renderKeywordField(parent: Element, hitCount: HTMLElement): void {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: "关键词 / 文件名 / 路径"});
		const row = field.createDiv({cls: "media-vault-filter-row"});
		const mode = row.createEl("select", {cls: "media-vault-filter-select"});
		for (const option of [
			{value: "contains", label: "包含"},
			{value: "exact", label: "精确"},
			{value: "regex", label: "正则"},
		]) {
			mode.createEl("option", {value: option.value, text: option.label});
		}
		mode.value = this.draftQuery.keywordMode ?? "contains";
		mode.addEventListener("change", () => {
			this.draftQuery.keywordMode = mode.value as AssetQuery["keywordMode"];
			this.updateDraftHitCount(hitCount);
		});

		const keyword = row.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "text",
				placeholder: "例如 login / 架构 / dashboard",
				value: this.draftQuery.keyword ?? "",
			},
		});
		keyword.addEventListener("input", () => {
			this.draftQuery.keyword = keyword.value;
			this.updateDraftHitCount(hitCount);
		});
	}

	private renderFormatField(parent: Element, hitCount: HTMLElement): void {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: "格式"});
		const grid = field.createDiv({cls: "media-vault-filter-option-grid"});
		const selectedFormats = new Set(this.draftQuery.formats ?? []);
		for (const format of FILTER_FORMATS) {
			const button = grid.createEl("button", {
				cls: selectedFormats.has(format) ? "is-active" : "",
				text: format.toUpperCase(),
			});
			button.addEventListener("click", () => {
				if (selectedFormats.has(format)) {
					selectedFormats.delete(format);
				} else {
					selectedFormats.add(format);
				}
				this.draftQuery.formats = Array.from(selectedFormats);
				this.draftQuery = normalizeQuery(this.draftQuery);
				this.render();
			});
		}
		this.updateDraftHitCount(hitCount);
	}

	private renderReferenceField(parent: Element, hitCount: HTMLElement): void {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: "引用状态"});
		const row = field.createDiv({cls: "media-vault-filter-segment"});
		for (const option of [
			{label: "全部", value: undefined},
			{label: "已引用", value: true},
			{label: "未引用", value: false},
		]) {
			const active = this.draftQuery.referenced === option.value || (typeof this.draftQuery.referenced !== "boolean" && option.value === undefined);
			const button = row.createEl("button", {cls: active ? "is-active" : "", text: option.label});
			button.addEventListener("click", () => {
				this.draftQuery.referenced = option.value;
				this.draftQuery = normalizeQuery(this.draftQuery);
				this.render();
			});
		}
		this.updateDraftHitCount(hitCount);
	}

	private renderContentStateField(parent: Element, hitCount: HTMLElement): void {
		this.renderBooleanFilterSegment(parent, "文本识别", "hasOcr", [
			{label: "全部", value: undefined},
			{label: "有 OCR", value: true},
			{label: "无 OCR", value: false},
		], hitCount);
		this.renderBooleanFilterSegment(parent, "区域标注", "hasAnnotation", [
			{label: "全部", value: undefined},
			{label: "有标注", value: true},
			{label: "无标注", value: false},
		], hitCount);
	}

	private renderBooleanFilterSegment(parent: Element, label: string, queryField: "hasOcr" | "hasAnnotation", options: Array<{label: string; value: boolean | undefined}>, hitCount: HTMLElement): void {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: label});
		const row = field.createDiv({cls: "media-vault-filter-segment"});
		for (const option of options) {
			const active = this.draftQuery[queryField] === option.value || (typeof this.draftQuery[queryField] !== "boolean" && option.value === undefined);
			const button = row.createEl("button", {cls: active ? "is-active" : "", text: option.label});
			button.addEventListener("click", () => {
				this.draftQuery[queryField] = option.value;
				this.draftQuery = normalizeQuery(this.draftQuery);
				this.render();
			});
		}
		this.updateDraftHitCount(hitCount);
	}

	private renderLinkedScopeField(parent: Element, label: string, queryField: "linkedByNote" | "linkedByFolder", placeholder: string, hitCount: HTMLElement): void {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: label});
		const input = field.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "text",
				placeholder,
				value: this.draftQuery[queryField] ?? "",
			},
		});
		input.addEventListener("input", () => {
			this.draftQuery[queryField] = input.value;
			this.draftQuery = normalizeQuery(this.draftQuery);
			this.updateDraftHitCount(hitCount);
		});
	}

	private renderNumberRangeField(parent: Element, label: string, minField: NumericQueryField, maxField: NumericQueryField, minPlaceholder: string, maxPlaceholder: string, hitCount: HTMLElement): void {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: label});
		const row = field.createDiv({cls: "media-vault-filter-row"});
		this.renderNumberInput(row, minField, minPlaceholder, hitCount);
		this.renderNumberInput(row, maxField, maxPlaceholder, hitCount);
	}

	private renderNumberInputField(parent: Element, label: string, queryField: NumericQueryField, placeholder: string, hitCount: HTMLElement): void {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: label});
		this.renderNumberInput(field, queryField, placeholder, hitCount);
	}

	private renderRatioField(parent: Element, hitCount: HTMLElement): void {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: "图片方向"});
		const row = field.createDiv({cls: "media-vault-filter-segment"});
		for (const option of [
			{label: "全部", value: undefined},
			{label: "横图", value: "landscape" as const},
			{label: "竖图", value: "portrait" as const},
			{label: "方图", value: "square" as const},
		]) {
			const active = this.draftQuery.ratio === option.value || (!this.draftQuery.ratio && option.value === undefined);
			const button = row.createEl("button", {cls: active ? "is-active" : "", text: option.label});
			button.addEventListener("click", () => {
				this.draftQuery.ratio = option.value;
				this.draftQuery = normalizeQuery(this.draftQuery);
				this.render();
			});
		}
		this.updateDraftHitCount(hitCount);
	}

	private renderRatingField(parent: Element, hitCount: HTMLElement): void {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: "评分"});
		const row = field.createDiv({cls: "media-vault-filter-segment"});
		for (const option of [
			{label: "全部", value: undefined},
			{label: "≥ 1 星", value: 1},
			{label: "≥ 2 星", value: 2},
			{label: "≥ 3 星", value: 3},
			{label: "≥ 4 星", value: 4},
			{label: "≥ 5 星", value: 5},
		]) {
			const active = this.draftQuery.ratingGte === option.value || (typeof this.draftQuery.ratingGte !== "number" && option.value === undefined);
			const button = row.createEl("button", {cls: active ? "is-active" : "", text: option.label});
			button.addEventListener("click", () => {
				this.draftQuery.ratingGte = option.value;
				this.draftQuery = normalizeQuery(this.draftQuery);
				this.render();
			});
		}
		this.updateDraftHitCount(hitCount);
	}

	private renderNumberInput(parent: Element, queryField: NumericQueryField, placeholder: string, hitCount: HTMLElement): void {
		const value = this.draftQuery[queryField];
		const input = parent.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "number",
				min: "0",
				placeholder,
				value: typeof value === "number" ? String(value) : "",
			},
		});
		input.addEventListener("input", () => {
			this.setDraftNumberField(queryField, input.value);
			this.updateDraftHitCount(hitCount);
		});
	}

	private renderDateRangeField(parent: Element, label: string, startField: DateQueryField, endField: DateQueryField, hitCount: HTMLElement): void {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: label});
		const row = field.createDiv({cls: "media-vault-filter-row"});
		this.renderDateInput(row, startField, "开始日期", hitCount);
		this.renderDateInput(row, endField, "结束日期", hitCount);
	}

	private renderDateInput(parent: Element, queryField: DateQueryField, placeholder: string, hitCount: HTMLElement): void {
		const value = this.draftQuery[queryField];
		const input = parent.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "date",
				placeholder,
				value: typeof value === "number" ? toDateInputValue(value) : "",
			},
		});
		input.addEventListener("change", () => {
			this.setDraftDateField(queryField, input.value);
			this.updateDraftHitCount(hitCount);
		});
	}

	private renderTextListField(parent: Element, label: string, queryField: "tags" | "collections" | "colors", placeholder: string, hitCount: HTMLElement): void {
		const field = parent.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: label});
		const input = field.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "text",
				placeholder,
				value: (this.draftQuery[queryField] ?? []).join(", "),
			},
		});
		input.addEventListener("input", () => {
			this.draftQuery[queryField] = splitTextList(input.value);
			this.draftQuery = normalizeQuery(this.draftQuery);
			this.updateDraftHitCount(hitCount);
		});
	}

	private renderBatchBar(main: Element): void {
		if (this.selectedAssetIds.size === 0) {
			return;
		}

		const bar = main.createDiv({cls: "media-vault-batch-bar"});
		const count = bar.createDiv({cls: "media-vault-batch-count"});
		count.createSpan({cls: "media-vault-batch-count-badge", text: String(this.selectedAssetIds.size)});
		const text = count.createDiv();
		text.createDiv({text: `已选择 ${this.selectedAssetIds.size} 张图片`});
		text.createDiv({cls: "media-vault-batch-help", text: "Cmd/Ctrl 多选 · Shift 范围选择 · Esc 取消"});

		if (this.quickFilter === "trash") {
			const restore = bar.createEl("button", {cls: "mod-cta", text: "恢复"});
			restore.addEventListener("click", () => {
				void this.restoreSelectedAssets();
			});
			const cancel = bar.createEl("button", {text: "取消选择"});
			cancel.addEventListener("click", () => this.clearSelection());
			return;
		}

		const tag = bar.createEl("button", {text: "添加标签"});
		tag.addEventListener("click", () => this.openBatchModal("addTags"));
		const collection = bar.createEl("button", {text: "加入集合"});
		collection.addEventListener("click", () => this.openBatchModal("addCollections"));
		const move = bar.createEl("button", {text: "移动"});
		move.addEventListener("click", () => this.openBatchModal("moveToFolder"));
		const convert = bar.createEl("button", {text: "转换/压缩"});
		convert.addEventListener("click", () => this.openBatchModal("convert"));
		const deleteButton = bar.createEl("button", {cls: "mod-warning", text: "删除"});
		deleteButton.addEventListener("click", () => this.openDeleteRiskModal());
		const batch = bar.createEl("button", {cls: "mod-cta", text: "批量操作"});
		batch.addEventListener("click", () => this.openBatchModal());
	}

	private renderBatchOperationModal(main: Element): void {
		const preflight = this.buildBatchPreflight();
		const overlay = main.createDiv({cls: "media-vault-modal-overlay"});
		const modal = overlay.createDiv({cls: "media-vault-batch-modal"});
		const head = modal.createDiv({cls: "media-vault-modal-head"});
		head.createEl("h3", {text: "批量操作"});
		head.createSpan({cls: "media-vault-filter-hit", text: `${preflight.totalAssets} 张图片`});
		head.createSpan({cls: preflight.referencedAssets > 0 ? "media-vault-risk-chip" : "media-vault-filter-hit", text: `${preflight.referencedAssets} 张有引用`});
		const close = head.createEl("button", {cls: "media-vault-icon-button", text: "×"});
		close.addEventListener("click", () => {
			this.batchModalOpen = false;
			this.render();
		});

		const body = modal.createDiv({cls: "media-vault-modal-body"});
		this.renderChosenAssets(body, preflight);
		this.renderBatchDraftFields(body);
		this.renderBatchOperationSummary(body, preflight);
		this.renderBatchPreflight(body, preflight);

		const foot = modal.createDiv({cls: "media-vault-modal-foot"});
		const cancel = foot.createEl("button", {text: "取消"});
		cancel.addEventListener("click", () => {
			this.batchModalOpen = false;
			this.render();
		});
			const draft = foot.createEl("button", {text: "只保存为操作草稿"});
			draft.addEventListener("click", () => {
				void this.saveCurrentBatchDraft();
			});
			const apply = foot.createEl("button", {cls: "mod-cta", text: `应用 ${this.getBatchOperationCount()} 项操作`});
			apply.disabled = preflight.errors.length > 0 || this.getBatchOperationCount() === 0;
			apply.addEventListener("click", () => {
				void this.applyBatchOperations();
			});
	}

	private renderChosenAssets(parent: Element, preflight: BatchPreflightResult): void {
		const section = parent.createDiv({cls: "media-vault-chosen-section"});
		const head = section.createDiv({cls: "media-vault-chosen-summary"});
		head.createEl("b", {text: `已选择 ${preflight.totalAssets} 张图片`});
		head.createSpan({
			text: preflight.affectedNotes > 0
				? `${preflight.referencedAssets} 张有引用，影响 ${preflight.affectedNotes} 篇笔记`
				: "未发现引用影响",
		});

		const grid = section.createDiv({cls: "media-vault-chosen-grid"});
		const selectedAssets = this.getSelectedAssets();
		const preflightByAssetId = new Map(preflight.items.map((item) => [item.asset.id, item]));
		for (const asset of selectedAssets.slice(0, 12)) {
			const item = grid.createDiv({cls: "media-vault-chosen-asset"});
			const itemPreflight = preflightByAssetId.get(asset.id);
			const resourcePath = this.plugin.services.thumbnailService.getResourcePath(asset);
			const preview = item.createDiv({cls: "media-vault-chosen-preview"});
			if (resourcePath) {
				preview.createEl("img", {attr: {src: resourcePath, alt: asset.filename}});
			} else {
				preview.createDiv({cls: "media-vault-missing-preview", text: asset.ext.toUpperCase()});
			}
			if (asset.referenceCount > 0) {
				preview.createSpan({cls: "media-vault-chosen-badge", text: `↗ ${asset.referenceCount}`});
			}
			if (itemPreflight && itemPreflight.warnings.length > 0) {
				preview.createSpan({cls: "media-vault-chosen-warning", text: "!"});
			}
			item.createSpan({text: asset.filename});
			item.createSpan({cls: "media-vault-chosen-meta", text: `${asset.ext.toUpperCase()} · ${formatFileSize(asset.sizeBytes)}`});
			const remove = item.createEl("button", {text: "×"});
			remove.addEventListener("click", () => {
				this.selectedAssetIds.delete(asset.id);
				this.render();
			});
		}
		if (selectedAssets.length > 12) {
			const overflow = grid.createDiv({cls: "media-vault-chosen-asset media-vault-chosen-more"});
			overflow.createDiv({text: `+${selectedAssets.length - 12}`});
			overflow.createSpan({text: "更多已选图片"});
		}
	}

	private renderBatchOperationSummary(parent: Element, preflight: BatchPreflightResult): void {
		const addTags = splitTextList(this.batchDraft.addTags);
		const removeTags = splitTextList(this.batchDraft.removeTags);
		const addCollections = splitTextList(this.batchDraft.addCollections);
		const moveToFolder = this.batchDraft.moveToFolder.trim();
		const operations: Array<{icon: string; label: string; detail: string; enabled: boolean; warning?: string}> = [
			{
				icon: "#",
				label: "添加标签",
				detail: addTags.length > 0 ? addTags.map((tag) => `#${tag}`).join("、") : "未设置标签",
				enabled: addTags.length > 0,
			},
			{
				icon: "−",
				label: "移除标签",
				detail: removeTags.length > 0 ? removeTags.map((tag) => `#${tag}`).join("、") : "未设置要移除的标签",
				enabled: removeTags.length > 0,
			},
			{
				icon: "□",
				label: "加入 Collection",
				detail: addCollections.length > 0 ? addCollections.join("、") : "未设置集合",
				enabled: addCollections.length > 0,
			},
			{
				icon: "↪",
				label: "移动到文件夹",
				detail: moveToFolder ? joinVaultPath(moveToFolder) : "不移动文件",
				enabled: Boolean(moveToFolder),
				warning: moveToFolder && !this.batchDraft.rewriteMarkdownLinks ? "未开启 Markdown 链接改写，可能产生断链。" : undefined,
			},
			{
				icon: "★",
				label: "设置评分",
				detail: this.batchDraft.setRating !== "" ? `${this.batchDraft.setRating} 星` : "不修改评分",
				enabled: this.batchDraft.setRating !== "",
			},
			{
				icon: "◱",
				label: "压缩/转换",
				detail: this.batchDraft.convertEnabled
					? `dry run：转 ${this.batchDraft.convertFormat.toUpperCase()}${this.batchDraft.convertMaxEdge ? ` · 最长边 ${this.batchDraft.convertMaxEdge}px` : ""}${this.batchDraft.convertQuality ? ` · 质量 ${this.batchDraft.convertQuality}` : ""}`
					: "未启用转换",
				enabled: this.batchDraft.convertEnabled,
				warning: this.batchDraft.convertEnabled ? "MVP 当前只预检，不改写原图。" : undefined,
			},
			{
				icon: "↗",
				label: "更新 Markdown 链接",
				detail: this.batchDraft.rewriteMarkdownLinks ? `计划改写 ${preflight.plannedMarkdownLinkRewrites} 处引用` : "关闭，移动/删除后保留原链接",
				enabled: this.batchDraft.rewriteMarkdownLinks,
				warning: preflight.brokenLinksIfNotRewrite > 0 ? `${preflight.brokenLinksIfNotRewrite} 处潜在断链。` : undefined,
			},
			{
				icon: "⧉",
				label: "复制 Wiki 链接",
				detail: this.batchDraft.copyWikiLinks ? `复制 ${preflight.totalAssets} 条链接到剪贴板` : "不复制链接",
				enabled: this.batchDraft.copyWikiLinks,
			},
		];

		const enabledCount = operations.filter((operation) => operation.enabled).length;
		const section = parent.createDiv({cls: "media-vault-batch-operation-summary"});
		const head = section.createDiv({cls: "media-vault-batch-operation-summary-head"});
		head.createDiv({cls: "media-vault-section-title", text: "操作组合"});
		head.createSpan({text: enabledCount > 0 ? `已启用 ${enabledCount} 项` : "仅预检"});
		const grid = section.createDiv({cls: "media-vault-batch-operation-grid"});
		for (const operation of operations) {
			const item = grid.createDiv({cls: `media-vault-batch-operation ${operation.enabled ? "is-active" : "is-muted"} ${operation.warning ? "is-warning" : ""}`});
			item.createSpan({cls: "media-vault-batch-operation-icon", text: operation.icon});
			const body = item.createDiv({cls: "media-vault-batch-operation-body"});
			body.createDiv({cls: "media-vault-batch-operation-label", text: operation.label});
			body.createDiv({cls: "media-vault-batch-operation-detail", text: operation.detail});
			item.createSpan({cls: "media-vault-batch-operation-state", text: operation.enabled ? "启用" : "跳过"});
			if (operation.warning) {
				item.createDiv({cls: "media-vault-batch-operation-warning", text: operation.warning});
			}
		}
	}

	private renderBatchDraftFields(parent: Element): void {
		const form = parent.createDiv({cls: "media-vault-batch-form"});
		this.renderBatchTextInput(form, "添加标签", "addTags", "逗号分隔，例如 diagram, reference");
		this.renderBatchTextInput(form, "移除标签", "removeTags", "逗号分隔，仅从已选图片移除");
		this.renderBatchTextInput(form, "加入 Collection", "addCollections", "逗号分隔集合名");
		this.renderBatchTextInput(form, "移动到文件夹", "moveToFolder", "例如 Assets/Images/2026/05");

		const ratingField = form.createDiv({cls: "media-vault-filter-field"});
		ratingField.createEl("label", {text: "设置评分"});
		const rating = ratingField.createEl("select", {cls: "media-vault-filter-input"});
		rating.createEl("option", {value: "", text: "不修改"});
		for (const value of ["0", "1", "2", "3", "4", "5"]) {
			rating.createEl("option", {value, text: `${value} 星`});
		}
		rating.value = this.batchDraft.setRating;
			rating.addEventListener("change", () => {
				this.batchDraft.setRating = rating.value;
				this.render();
			});

			const copy = form.createDiv({cls: "media-vault-filter-field media-vault-batch-toggle"});
			const copyLabel = copy.createEl("label");
			const copyInput = copyLabel.createEl("input", {attr: {type: "checkbox"}});
			copyInput.checked = this.batchDraft.copyWikiLinks;
			copyLabel.appendText(" 复制 Wiki 链接到剪贴板");
			copyInput.addEventListener("change", () => {
				this.batchDraft.copyWikiLinks = copyInput.checked;
				this.render();
			});

			const convertField = form.createDiv({cls: `media-vault-filter-field media-vault-batch-convert ${this.batchFocusField === "convert" ? "is-targeted" : ""}`});
			const convertLabel = convertField.createEl("label");
			const convertToggle = convertLabel.createEl("input", {attr: {type: "checkbox"}});
		convertToggle.checked = this.batchDraft.convertEnabled;
		convertLabel.appendText(" 压缩/转换");
		convertToggle.addEventListener("change", () => {
			this.batchDraft.convertEnabled = convertToggle.checked;
			this.render();
		});
		const convertRow = convertField.createDiv({cls: "media-vault-filter-row"});
		const format = convertRow.createEl("select", {cls: "media-vault-filter-input"});
		for (const value of ["webp", "jpg", "png"]) {
			format.createEl("option", {value, text: value.toUpperCase()});
		}
		format.value = this.batchDraft.convertFormat;
		if (this.batchFocusField === "convert") {
			this.focusBatchControl(format);
		}
		format.addEventListener("change", () => {
			this.batchDraft.convertFormat = format.value as BatchOperationDraft["convertFormat"];
			this.render();
		});
		const maxEdge = convertRow.createEl("input", {cls: "media-vault-filter-input", attr: {type: "number", placeholder: "最长边 px", value: this.batchDraft.convertMaxEdge}});
		maxEdge.addEventListener("input", () => {
			this.batchDraft.convertMaxEdge = maxEdge.value;
			this.render();
		});
		const quality = convertRow.createEl("input", {cls: "media-vault-filter-input", attr: {type: "number", min: "1", max: "100", placeholder: "质量 1-100", value: this.batchDraft.convertQuality}});
		quality.addEventListener("input", () => {
			this.batchDraft.convertQuality = quality.value;
			this.render();
		});

		const rewrite = form.createDiv({cls: "media-vault-filter-field media-vault-batch-toggle"});
		const rewriteLabel = rewrite.createEl("label");
		const rewriteInput = rewriteLabel.createEl("input", {attr: {type: "checkbox"}});
		rewriteInput.checked = this.batchDraft.rewriteMarkdownLinks;
		rewriteLabel.appendText(" 更新 Markdown 链接");
		rewriteInput.addEventListener("change", () => {
			this.batchDraft.rewriteMarkdownLinks = rewriteInput.checked;
			this.render();
		});
	}

	private renderBatchTextInput(parent: Element, label: string, field: "addTags" | "removeTags" | "addCollections" | "moveToFolder", placeholder: string): void {
		const wrapper = parent.createDiv({cls: `media-vault-filter-field ${this.batchFocusField === field ? "is-targeted" : ""}`});
		wrapper.createEl("label", {text: label});
		const input = wrapper.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "text",
				placeholder,
				value: this.batchDraft[field],
			},
		});
		if (this.batchFocusField === field) {
			this.focusBatchControl(input);
		}
		input.addEventListener("input", () => {
			this.batchDraft[field] = input.value;
			this.render();
		});
	}

	private focusBatchControl(element: HTMLElement): void {
		this.batchFocusField = null;
		window.requestAnimationFrame(() => {
			element.scrollIntoView({block: "center"});
			element.focus();
		});
	}

	private renderBatchPreflight(parent: Element, preflight: BatchPreflightResult): void {
		const section = parent.createDiv({cls: "media-vault-preflight"});
		section.createDiv({cls: "media-vault-section-title", text: "dry run 预检"});
		const metrics = section.createDiv({cls: "media-vault-preflight-metrics"});
		this.renderMetric(metrics, "图片", String(preflight.totalAssets));
		this.renderMetric(metrics, "有引用", String(preflight.referencedAssets));
		this.renderMetric(metrics, "影响笔记", String(preflight.affectedNotes));
		this.renderMetric(metrics, "有标注", String(preflight.annotatedAssets));
		this.renderMetric(metrics, "潜在断链", String(preflight.brokenLinksIfNotRewrite));
		this.renderMetric(metrics, "计划移动", String(preflight.plannedMoves));
		this.renderMetric(metrics, "改写链接", String(preflight.plannedMarkdownLinkRewrites));
		this.renderMetric(metrics, "回滚步骤", String(preflight.plannedRollbackSteps));
		this.renderMetric(metrics, "新集合", String(preflight.newCollections));

		const status = section.createDiv({cls: `media-vault-preflight-summary ${preflight.errors.length > 0 ? "is-error" : preflight.warnings.length > 0 || preflight.brokenLinksIfNotRewrite > 0 ? "is-warning" : "is-ok"}`});
		status.createEl("b", {text: preflight.errors.length > 0 ? "dry run 失败，实际操作已阻断" : "dry run 已完成"});
		status.createDiv({text: getBatchPreflightSummary(preflight)});
		const steps = section.createDiv({cls: "media-vault-preflight-list"});
		for (const step of preflight.steps) {
			steps.createDiv({text: step});
		}
		for (const warning of preflight.warnings) {
			steps.createDiv({cls: "is-warning", text: warning});
		}
		for (const error of preflight.errors) {
			steps.createDiv({cls: "is-error", text: error});
		}
		for (const error of this.batchOperationErrors) {
			steps.createDiv({cls: "is-error", text: error});
		}
		const copyableErrors = [...preflight.errors, ...this.batchOperationErrors];
		if (copyableErrors.length > 0) {
			const copyErrors = section.createEl("button", {cls: "media-vault-copy-error-log", text: "复制失败日志"});
			copyErrors.addEventListener("click", () => {
				void navigator.clipboard.writeText(copyableErrors.join("\n"));
				new Notice("已复制失败日志。");
			});
		}

		this.renderBatchMoveRewritePreview(section, preflight);
		this.renderBatchPreflightPlan(section, preflight);
		this.renderBatchRewritePlan(section, preflight);

		const impacts = section.createDiv({cls: "media-vault-preflight-impact"});
		const impactItems = preflight.items.filter((entry) => entry.referenceNotes.length > 0 || entry.warnings.length > 0);
		if (impactItems.length === 0) {
			impacts.createDiv({cls: "media-vault-risk-row", text: "没有发现引用、标注或断链风险。"});
			return;
		}
		for (const item of impactItems.slice(0, 8)) {
			const row = impacts.createDiv({cls: "media-vault-risk-row"});
			row.createDiv({cls: "media-vault-risk-title", text: item.asset.filename});
			if (item.referenceNotes.length > 0) {
				row.createDiv({cls: "media-vault-risk-note-list", text: `引用笔记：${item.referenceNotes.slice(0, 4).join("、")}${item.referenceNotes.length > 4 ? ` 等 ${item.referenceNotes.length} 篇` : ""}`});
			}
			if (item.warnings.length > 0) {
				row.createDiv({text: item.warnings.join("、")});
			}
		}
		if (impactItems.length > 8) {
			impacts.createDiv({cls: "media-vault-risk-row", text: `还有 ${impactItems.length - 8} 张图片存在影响，执行前请确认操作范围。`});
		}
	}

	private renderBatchMoveRewritePreview(parent: Element, preflight: BatchPreflightResult): void {
		const movedItems = preflight.items.filter((item) => item.targetPath && item.targetPath !== item.asset.filePath);
		const hasRewriteImpact = preflight.noteRewritePlans.length > 0 || preflight.brokenLinksIfNotRewrite > 0;
		if (movedItems.length === 0 && !hasRewriteImpact) {
			return;
		}

		const section = parent.createDiv({cls: "media-vault-preflight-move-preview"});
		const head = section.createDiv({cls: "media-vault-preflight-move-head"});
		head.createDiv({cls: "media-vault-section-title", text: "移动与链接预览"});
		const copy = head.createEl("button", {text: "复制 dry run 报告"});
		copy.addEventListener("click", () => {
			void navigator.clipboard.writeText(buildBatchDryRunReport(preflight));
			new Notice("已复制 dry run 报告。");
		});

		const summary = section.createDiv({cls: "media-vault-preflight-move-summary"});
		this.renderMovePreviewMetric(summary, "移动文件", `${preflight.plannedMoves} 张`);
		this.renderMovePreviewMetric(summary, "Markdown 改写", this.batchDraft.rewriteMarkdownLinks ? `${preflight.plannedMarkdownLinkRewrites} 处` : "关闭", preflight.brokenLinksIfNotRewrite > 0);
		this.renderMovePreviewMetric(summary, "影响笔记", `${preflight.affectedNotes} 篇`);
		this.renderMovePreviewMetric(summary, "回滚记录", `${preflight.plannedRollbackSteps} 步`);

		if (preflight.brokenLinksIfNotRewrite > 0) {
			section.createDiv({
				cls: "media-vault-preflight-move-warning",
				text: `当前会留下 ${preflight.brokenLinksIfNotRewrite} 处潜在断链。开启“更新 Markdown 链接”后再执行移动。`,
			});
		}

		if (movedItems.length > 0) {
			const table = section.createDiv({cls: "media-vault-preflight-move-table"});
			const header = table.createDiv({cls: "media-vault-preflight-move-row is-header"});
			header.createDiv({text: "源路径"});
			header.createDiv({text: ""});
			header.createDiv({text: "目标路径"});
			header.createDiv({text: "引用处理"});

			for (const item of movedItems.slice(0, 8)) {
				const row = table.createDiv({cls: "media-vault-preflight-move-row"});
				row.createDiv({cls: "media-vault-preflight-move-path", text: item.asset.filePath});
				row.createDiv({cls: "media-vault-preflight-move-arrow", text: "→"});
				row.createDiv({cls: "media-vault-preflight-move-path", text: item.targetPath ?? ""});
				const rewrite = item.markdownRewriteCount > 0
					? `改写 ${item.markdownRewriteCount} 处`
					: item.referenceCount > 0
						? `${item.referenceCount} 处引用待处理`
						: "无引用";
				row.createDiv({cls: item.markdownRewriteCount === 0 && item.referenceCount > 0 ? "is-warning" : "", text: rewrite});
			}

			if (movedItems.length > 8) {
				table.createDiv({cls: "media-vault-preflight-move-row", text: `还有 ${movedItems.length - 8} 张图片的目标路径未展开显示。`});
			}
		}
	}

	private renderMovePreviewMetric(parent: Element, label: string, value: string, warning = false): void {
		const item = parent.createDiv({cls: `media-vault-preflight-move-metric ${warning ? "is-warning" : ""}`});
		item.createEl("b", {text: value});
		item.createSpan({text: label});
	}

	private renderBatchPreflightPlan(parent: Element, preflight: BatchPreflightResult): void {
		const table = parent.createDiv({cls: "media-vault-preflight-plan"});
		const header = table.createDiv({cls: "media-vault-preflight-plan-row is-header"});
		header.createDiv({text: "文件"});
		header.createDiv({text: "计划动作"});
		header.createDiv({text: "目标 / 引用影响"});
		header.createDiv({text: "风险"});

		for (const item of preflight.items.slice(0, 10)) {
			const row = table.createDiv({cls: "media-vault-preflight-plan-row"});
			row.createDiv({cls: "media-vault-preflight-file", text: item.asset.filename});
			row.createDiv({text: item.proposedAction});
			const impact = row.createDiv();
			if (item.targetPath) {
				impact.createDiv({cls: "media-vault-preflight-path", text: item.targetPath});
			}
			impact.createDiv({text: item.markdownRewriteCount > 0 ? `将改写 ${item.markdownRewriteCount} 处 Markdown 图片链接` : item.referenceCount > 0 ? `${item.referenceCount} 处引用待确认` : "无引用改写"});
			const risk = row.createDiv({cls: "media-vault-preflight-risk"});
			risk.createSpan({cls: `media-vault-preflight-risk-pill is-${item.riskLevel}`, text: getRiskLevelLabel(item.riskLevel)});
			if (item.annotationCount > 0) {
				risk.createSpan({text: `${item.annotationCount} 标注`});
			}
			if (item.variantCount > 0) {
				risk.createSpan({text: `${item.variantCount} 变体`});
			}
		}

		if (preflight.items.length > 10) {
			const more = table.createDiv({cls: "media-vault-preflight-plan-row"});
			more.createDiv({text: `还有 ${preflight.items.length - 10} 张图片未展开显示`});
		}
	}

	private renderBatchRewritePlan(parent: Element, preflight: BatchPreflightResult): void {
		if (preflight.noteRewritePlans.length === 0) {
			return;
		}
		const list = parent.createDiv({cls: "media-vault-preflight-rewrite-list"});
		list.createDiv({cls: "media-vault-section-title", text: "Markdown 链接改写计划"});
		for (const plan of preflight.noteRewritePlans.slice(0, 8)) {
			const row = list.createDiv({cls: "media-vault-preflight-rewrite-row"});
			row.createDiv({text: plan.notePath});
			row.createSpan({text: `${plan.rewriteCount} 处`});
		}
		if (preflight.noteRewritePlans.length > 8) {
			list.createDiv({cls: "media-vault-preflight-rewrite-row", text: `还有 ${preflight.noteRewritePlans.length - 8} 篇笔记未展开显示`});
		}
	}

	private renderMetric(parent: Element, label: string, value: string): void {
		const metric = parent.createDiv({cls: "media-vault-preflight-metric"});
		metric.createEl("b", {text: value});
		metric.createSpan({text: label});
	}

	private renderDeleteRiskModal(main: Element): void {
		const preflight = this.buildBatchPreflight(this.deleteMode);
		const currentNoteImpact = this.getCurrentNoteReferenceImpact();
		const overlay = main.createDiv({cls: "media-vault-modal-overlay"});
		const modal = overlay.createDiv({cls: "media-vault-batch-modal media-vault-delete-modal"});
		const head = modal.createDiv({cls: "media-vault-modal-head"});
		head.createEl("h3", {text: "确认删除图片"});
		head.createSpan({cls: "media-vault-danger-chip", text: "危险操作"});
		const close = head.createEl("button", {cls: "media-vault-icon-button", text: "×"});
		close.addEventListener("click", () => {
			this.deleteRiskModalOpen = false;
			this.deleteIncludeVariants = false;
			this.render();
		});

		const body = modal.createDiv({cls: "media-vault-modal-body"});
		const riskBox = body.createDiv({cls: "media-vault-delete-risk-box"});
		riskBox.createEl("b", {text: "删除会影响现有笔记引用"});
		riskBox.createDiv({text: "默认建议移入回收站，不执行永久删除。有引用图片不会被静默移除。"});

		const metrics = body.createDiv({cls: "media-vault-preflight-metrics"});
		const unreferencedCount = preflight.totalAssets - preflight.referencedAssets;
		this.renderMetric(metrics, "未引用", String(unreferencedCount));
		this.renderMetric(metrics, "已引用", String(preflight.referencedAssets));
		this.renderMetric(metrics, "影响笔记", String(preflight.affectedNotes));
		this.renderMetric(metrics, "Asset Note", String(this.getSelectedAssets().filter((asset) => asset.notePath).length));
		this.renderMetric(metrics, "区域标注", String(preflight.annotationCount));
		this.renderMetric(metrics, "变体", String(preflight.variantCount));
		const variantTargets = this.getVariantDeleteCandidates(Array.from(this.selectedAssetIds));
		if (variantTargets.length > 0) {
			const variantPolicy = body.createEl("label", {cls: "media-vault-delete-variant-policy"});
			const checkbox = variantPolicy.createEl("input", {attr: {type: "checkbox"}});
			checkbox.checked = this.deleteIncludeVariants;
			const text = variantPolicy.createDiv();
			text.createEl("b", {text: "同时处理潜在变体 / 压缩版本"});
			text.createDiv({
				text: this.deleteIncludeVariants
					? `将额外处理 ${variantTargets.length} 张变体，共 ${this.getDeleteTargetAssetIds(Array.from(this.selectedAssetIds)).length} 张。`
					: `发现 ${variantTargets.length} 张未选中的潜在变体，默认不处理。`,
			});
			checkbox.addEventListener("change", () => {
				this.deleteIncludeVariants = checkbox.checked;
				this.render();
			});
		}

		const modeField = body.createDiv({cls: "media-vault-filter-field"});
		modeField.createEl("label", {text: "安全动作"});
		const segment = modeField.createDiv({cls: "media-vault-filter-segment"});
		for (const option of [
			{mode: "trash" as DeleteMode, label: "移入回收站"},
			{mode: "archive" as DeleteMode, label: "归档"},
			{mode: "permanent" as DeleteMode, label: "永久删除"},
		]) {
			const button = segment.createEl("button", {cls: this.deleteMode === option.mode ? "is-active" : "", text: option.label});
			button.addEventListener("click", () => {
				this.deleteMode = option.mode;
				this.render();
			});
		}

		if (this.deleteMode === "permanent") {
			const confirm = body.createDiv({cls: "media-vault-filter-field"});
			confirm.createEl("label", {text: `请输入 ${getPermanentConfirmToken()} 确认永久删除`});
			const input = confirm.createEl("input", {cls: "media-vault-filter-input", attr: {type: "text", value: this.permanentDeleteConfirmText}});
			input.addEventListener("input", () => {
				this.permanentDeleteConfirmText = input.value;
				this.render();
			});
		}

		const impacts = body.createDiv({cls: "media-vault-preflight-impact"});
		for (const item of preflight.items.filter((entry) => entry.referenceNotes.length > 0 || entry.warnings.length > 0).slice(0, 10)) {
			const row = impacts.createDiv({cls: "media-vault-risk-row"});
			row.createDiv({cls: "media-vault-risk-title", text: item.asset.filename});
			row.createDiv({text: [...item.referenceNotes, ...item.warnings].join("、")});
		}
		if (preflight.items.every((entry) => entry.referenceNotes.length === 0 && entry.warnings.length === 0)) {
			impacts.createDiv({cls: "media-vault-risk-row", text: "没有发现引用、Asset Note 或区域标注风险。"});
		}

		this.renderDeleteImpactTable(body, preflight);

		const assetNotePolicy = body.createDiv({cls: "media-vault-delete-policy-row"});
		assetNotePolicy.createSpan({text: "Asset Note"});
		assetNotePolicy.createDiv({text: "保留 Asset Note；删除或归档图片只更新资产状态，不静默删除笔记内容。"});
		assetNotePolicy.createSpan({cls: "media-vault-delete-policy-pill", text: "保留"});

		const currentNotePolicy = body.createDiv({cls: "media-vault-delete-policy-row"});
		currentNotePolicy.createSpan({text: "当前笔记"});
		currentNotePolicy.createDiv({
			text: currentNoteImpact.notePath
				? currentNoteImpact.referenceCount > 0
					? `${currentNoteImpact.notePath} 中有 ${currentNoteImpact.referenceCount} 处所选图片引用，可只移除引用而不删除图片。`
					: `${currentNoteImpact.notePath} 中没有所选图片引用。`
				: "当前没有可用 Markdown 笔记。打开过的笔记会作为当前笔记来源。",
		});
		currentNotePolicy.createSpan({
			cls: `media-vault-delete-policy-pill ${currentNoteImpact.referenceCount > 0 ? "is-warning" : ""}`,
			text: currentNoteImpact.referenceCount > 0 ? `${currentNoteImpact.referenceCount} 处` : "无引用",
		});

		const foot = modal.createDiv({cls: "media-vault-modal-foot"});
		const cancel = foot.createEl("button", {text: "取消"});
		cancel.addEventListener("click", () => {
			this.deleteRiskModalOpen = false;
			this.deleteIncludeVariants = false;
			this.render();
		});
		const removeCurrentNoteReferences = foot.createEl("button", {text: "从当前笔记移除引用"});
		removeCurrentNoteReferences.disabled = currentNoteImpact.referenceCount === 0;
		removeCurrentNoteReferences.addEventListener("click", () => {
			void this.removeSelectedReferencesFromCurrentNote();
		});
		const skipReferenced = foot.createEl("button", {text: "跳过已引用图片"});
		const unreferencedAssetIds = this.getUnreferencedSelectedAssetIds();
		skipReferenced.disabled = unreferencedAssetIds.length === 0 || preflight.errors.length > 0;
		skipReferenced.addEventListener("click", () => {
			void this.confirmDeleteRisk(this.deleteMode === "permanent" ? "trash" : this.deleteMode, unreferencedAssetIds);
		});
		const archive = foot.createEl("button", {text: "归档"});
		archive.disabled = preflight.errors.length > 0;
		archive.addEventListener("click", () => {
			void this.confirmDeleteRisk("archive");
		});
		const trash = foot.createEl("button", {cls: "mod-cta", text: "移入回收站"});
		trash.disabled = preflight.errors.length > 0;
		trash.addEventListener("click", () => {
			void this.confirmDeleteRisk("trash");
		});
		const permanent = foot.createEl("button", {cls: "mod-warning", text: "永久删除"});
		permanent.disabled = preflight.errors.length > 0 || this.deleteMode !== "permanent" || this.permanentDeleteConfirmText !== getPermanentConfirmToken();
		permanent.addEventListener("click", () => {
			void this.confirmDeleteRisk("permanent");
		});
	}

	private renderDeleteImpactTable(parent: Element, preflight: BatchPreflightResult): void {
		const table = parent.createDiv({cls: "media-vault-delete-table"});
		const header = table.createDiv({cls: "media-vault-delete-table-row is-header"});
		header.createDiv({text: "文件"});
		header.createDiv({text: "引用状态"});
		header.createDiv({text: "建议动作"});
		header.createDiv({text: "风险"});

		for (const item of preflight.items.slice(0, 12)) {
			const row = table.createDiv({cls: "media-vault-delete-table-row"});
			row.createDiv({cls: "media-vault-delete-file", text: item.asset.filename});
			const referenceCell = row.createDiv();
			if (item.referenceNotes.length > 0) {
				referenceCell.createSpan({cls: "media-vault-delete-status is-danger", text: `${item.referenceNotes.length} 篇笔记`});
			} else {
				referenceCell.createSpan({cls: "media-vault-delete-status is-ok", text: "未引用"});
			}
			row.createDiv({text: getDeleteSuggestion(item)});
			const risk = row.createDiv({cls: "media-vault-delete-risk-tags"});
			if (item.asset.notePath) {
				risk.createSpan({cls: "media-vault-risk-chip", text: "Asset Note"});
			}
			if (item.variantCount > 0) {
				risk.createSpan({cls: "media-vault-risk-chip", text: `${item.variantCount} 个变体`});
			}
			for (const warning of item.warnings) {
				risk.createSpan({cls: "media-vault-risk-chip", text: warning});
			}
			if (!item.asset.notePath && item.variantCount === 0 && item.warnings.length === 0) {
				risk.createSpan({cls: "media-vault-delete-status is-ok", text: "低风险"});
			}
		}

		if (preflight.items.length > 12) {
			const more = table.createDiv({cls: "media-vault-delete-table-row"});
			more.createDiv({text: `还有 ${preflight.items.length - 12} 张图片未展开显示`});
		}
	}

	private renderDuplicateChecker(main: Element, assets: Asset[]): void {
		const visibleAssetIds = new Set(assets.map((asset) => asset.id));
		const groups = getDuplicateGroups(this.plugin.services.assetRepository.getActiveAssets())
			.filter((group) => !this.skippedDuplicateGroupIds.has(group.id))
			.filter((group) => group.assets.some((asset) => visibleAssetIds.has(asset.id)));
		const removableAssetIds = this.getDuplicateRemovalCandidates(groups);

		const panel = main.createDiv({cls: "media-vault-duplicate-panel"});
		const head = panel.createDiv({cls: "media-vault-duplicate-head"});
		const title = head.createDiv();
		title.createDiv({cls: "media-vault-duplicate-title", text: "重复图片检查"});
		title.createDiv({
			cls: "media-vault-duplicate-subtitle",
			text: `${groups.length} 组 · ${assets.length} 张候选。优先保留引用次数更多、修改时间更新的图片。`,
		});
		const actions = head.createDiv({cls: "media-vault-duplicate-actions"});
		const resetSkipped = actions.createEl("button", {text: "显示已跳过"});
		resetSkipped.disabled = this.skippedDuplicateGroupIds.size === 0;
		resetSkipped.addEventListener("click", () => {
			this.skippedDuplicateGroupIds.clear();
			this.render();
		});
		const keepReferenced = actions.createEl("button", {cls: "mod-cta", text: "合并并批量保留引用最多"});
		keepReferenced.disabled = removableAssetIds.length === 0;
		keepReferenced.addEventListener("click", () => {
			void this.keepDuplicateGroups(groups);
		});

		if (groups.length === 0) {
			panel.createDiv({cls: "media-vault-hint", text: "没有可展示的重复分组。重建索引后会补全 SHA-256，再按完全重复分组。"});
			return;
		}

		for (const group of groups.slice(0, 16)) {
			this.renderDuplicateGroup(panel, group);
		}
		if (groups.length > 16) {
			panel.createDiv({cls: "media-vault-hint", text: `还有 ${groups.length - 16} 组未展开，可继续用搜索或筛选缩小范围。`});
		}
	}

	private renderDuplicateGroup(parent: Element, group: DuplicateGroup): void {
		const groupEl = parent.createDiv({cls: "media-vault-duplicate-group"});
		const header = groupEl.createDiv({cls: "media-vault-duplicate-group-header"});
		const left = header.createDiv();
		left.createDiv({cls: "media-vault-duplicate-group-title", text: group.type === "exact" ? "完全重复" : "视觉相似"});
		left.createDiv({cls: "media-vault-duplicate-group-meta", text: `相似度 ${group.similarity}% · ${group.assets.length} 张 · ${this.getDuplicateGroupSizeText(group)}`});
		const actions = header.createDiv({cls: "media-vault-duplicate-actions"});
		const deleteCandidates = group.assets
			.filter((asset) => asset.id !== group.recommendedAssetId)
			.map((asset) => asset.id);
		const similar = actions.createEl("button", {text: "相似页"});
		similar.addEventListener("click", () => {
			const source = this.plugin.services.assetRepository.getAssetById(group.recommendedAssetId) ?? group.assets[0];
			if (source) {
				this.openSimilarAssets(source.id);
			}
		});
		const merge = actions.createEl("button", {text: "合并元数据"});
		merge.addEventListener("click", () => {
			void this.mergeDuplicateMetadata(group, group.recommendedAssetId).then(() => this.render());
		});
		const keepRecommended = actions.createEl("button", {text: "合并并保留推荐项"});
		keepRecommended.disabled = deleteCandidates.length === 0;
		keepRecommended.addEventListener("click", () => {
			void this.keepDuplicateAsset(group, group.recommendedAssetId);
		});
		const skip = actions.createEl("button", {text: "跳过"});
		skip.addEventListener("click", () => {
			this.skippedDuplicateGroupIds.add(group.id);
			this.render();
		});

		const assets = groupEl.createDiv({cls: "media-vault-duplicate-assets"});
		for (const asset of group.assets.slice(0, 6)) {
			this.renderDuplicateAsset(assets, group, asset, asset.id === group.recommendedAssetId);
		}
		if (group.assets.length > 6) {
			assets.createDiv({cls: "media-vault-hint", text: `还有 ${group.assets.length - 6} 张同组图片未展开。`});
		}
	}

	private renderDuplicateAsset(parent: Element, group: DuplicateGroup, asset: Asset, isRecommended: boolean): void {
		const item = parent.createDiv({cls: `media-vault-duplicate-asset ${isRecommended ? "is-recommended" : ""}`});
		const resourcePath = this.plugin.services.thumbnailService.getResourcePath(asset);
		const preview = item.createDiv({cls: "media-vault-duplicate-preview"});
		if (resourcePath) {
			preview.createEl("img", {attr: {src: resourcePath, alt: asset.filename, loading: "lazy", decoding: "async"}});
		} else {
			preview.createDiv({cls: "media-vault-missing-preview", text: "Missing"});
		}
		const body = item.createDiv({cls: "media-vault-duplicate-body"});
		body.createDiv({cls: "media-vault-duplicate-name", text: asset.filename});
		body.createDiv({cls: "media-vault-duplicate-meta", text: `${formatFileSize(asset.sizeBytes)} · ${asset.referenceCount} 引用`});
		body.createDiv({cls: "media-vault-duplicate-path", text: asset.filePath});
		const actions = item.createDiv({cls: "media-vault-duplicate-item-actions"});
		const focus = actions.createEl("button", {text: "查看"});
		focus.addEventListener("click", () => this.focusAsset(asset.id));
		if (isRecommended) {
			actions.createSpan({cls: "media-vault-duplicate-recommend", text: "推荐保留"});
		} else {
			const keep = actions.createEl("button", {text: "保留此图"});
			keep.addEventListener("click", () => {
				void this.keepDuplicateAsset(group, asset.id);
			});
			const remove = actions.createEl("button", {text: "删除候选"});
			remove.addEventListener("click", () => this.openDeleteRiskForAssets([asset.id]));
		}
	}

	private async keepDuplicateGroups(groups: DuplicateGroup[]): Promise<void> {
		const removableAssetIds = this.getDuplicateRemovalCandidates(groups);
		if (removableAssetIds.length === 0) {
			new Notice("没有可删除的重复候选。");
			return;
		}

		for (const group of groups) {
			await this.mergeDuplicateMetadata(group, group.recommendedAssetId, false);
		}
		new Notice(`已合并 ${groups.length} 组重复图片元数据，请在风险确认中处理删除候选。`);
		this.openDeleteRiskForAssets(removableAssetIds);
	}

	private async keepDuplicateAsset(group: DuplicateGroup, keepAssetId: string): Promise<void> {
		const deleteCandidates = group.assets
			.filter((asset) => asset.id !== keepAssetId)
			.map((asset) => asset.id);
		if (deleteCandidates.length === 0) {
			await this.mergeDuplicateMetadata(group, keepAssetId);
			this.render();
			return;
		}

		await this.mergeDuplicateMetadata(group, keepAssetId, false);
		new Notice("已合并元数据，请在风险确认中处理删除候选。");
		this.openDeleteRiskForAssets(deleteCandidates);
	}

	private async mergeDuplicateMetadata(group: DuplicateGroup, keepAssetId: string, showNotice = true): Promise<void> {
		const repository = this.plugin.services.assetRepository;
		const keepAsset = repository.getAssetById(keepAssetId);
		if (!keepAsset) {
			new Notice("保留图片不存在，建议重建索引。");
			return;
		}

		const sourceAssets = group.assets
			.filter((asset) => asset.id !== keepAssetId)
			.map((asset) => repository.getAssetById(asset.id) ?? asset);
		const assetsToMerge = [keepAsset, ...sourceAssets];
		const mergedTags = mergeTextList([], assetsToMerge.flatMap((asset) => asset.tags));
		const mergedCollections = mergeTextList([], assetsToMerge.flatMap((asset) => asset.collections));
		const mergedColors = mergeTextList([], assetsToMerge.flatMap((asset) => asset.dominantColors ?? []));
		const ratings = assetsToMerge
			.map((asset) => asset.rating)
			.filter((rating): rating is NonNullable<Asset["rating"]> => typeof rating === "number");
		const mergedRating = ratings.length > 0 ? Math.max(...ratings) as Asset["rating"] : undefined;
		const mergedNotePath = keepAsset.notePath ?? sourceAssets.find((asset) => asset.notePath)?.notePath;
		const now = Date.now();

		await repository.updateAssets([keepAssetId], (asset) => ({
			...asset,
			tags: mergedTags,
			collections: mergedCollections,
			dominantColors: mergedColors.length > 0 ? mergedColors : asset.dominantColors,
			rating: typeof mergedRating === "number" ? mergedRating : asset.rating,
			favorite: assetsToMerge.some((item) => item.favorite),
			notePath: mergedNotePath,
			updatedAt: now,
		}));

		const sourceIds = sourceAssets.map((asset) => asset.id);
		let movedAnnotationCount = 0;
		for (const source of sourceAssets) {
			const annotations = repository.getAnnotationsForAsset(source.id);
			for (const annotation of annotations) {
				await repository.upsertAnnotation({
					...annotation,
					assetId: keepAssetId,
					updatedAt: now,
				});
				movedAnnotationCount += 1;
			}
			if (source.notePath) {
				await this.plugin.syncAssetNoteAnnotations(source.id);
			}
		}

		await this.plugin.syncAssetNoteAnnotations(keepAssetId);
		this.focusedAssetId = keepAssetId;
		this.virtualFocusedAssetId = keepAssetId;
		this.plugin.setFocusedAsset(keepAssetId);
		if (showNotice) {
			new Notice(`已合并 ${sourceIds.length} 张候选的元数据，迁移 ${movedAnnotationCount} 个区域标注。`);
		}
	}

	private getDuplicateRemovalCandidates(groups: DuplicateGroup[]): string[] {
		return Array.from(new Set(groups.flatMap((group) => group.assets
			.filter((asset) => asset.id !== group.recommendedAssetId)
			.map((asset) => asset.id))));
	}

	private getDuplicateGroupSizeText(group: DuplicateGroup): string {
		const totalBytes = group.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
		return formatFileSize(totalBytes);
	}

	private renderGallery(main: Element, assets: Asset[], focusedAsset: Asset | undefined): void {
		this.virtualAssets = assets;
		this.virtualFocusedAssetId = focusedAsset?.id ?? null;
		const gallery = main.createDiv({
			cls: this.viewMode === "list" ? "media-vault-gallery-list" : `media-vault-gallery-${this.viewMode} media-vault-virtual-gallery`,
		});
		this.bindVirtualGallery(gallery);
		this.enableGalleryBoxSelection(gallery);

		if (assets.length === 0) {
			const empty = gallery.createDiv({cls: "media-vault-empty"});
			empty.createDiv({cls: "media-vault-empty-title", text: "未找到图片"});
			empty.createDiv({text: "将图片加入 vault 后点击重建索引。"});
			return;
		}

		if (this.viewMode === "masonry") {
			this.renderVirtualMasonry(gallery, assets, focusedAsset);
			return;
		}

		if (this.viewMode === "grid" || this.viewMode === "compact") {
			this.renderVirtualGrid(gallery, assets, focusedAsset);
			return;
		}

		for (const asset of assets) {
			this.renderAssetRow(gallery, asset, focusedAsset?.id === asset.id);
		}
	}

	private bindVirtualGallery(gallery: HTMLDivElement): void {
		if (this.virtualGalleryEl === gallery) {
			return;
		}

		this.galleryResizeObserver?.disconnect();
		this.virtualGalleryEl = gallery;
		this.lastKnownGalleryWidth = gallery.clientWidth || this.lastKnownGalleryWidth;
		this.galleryResizeObserver = new ResizeObserver(() => this.scheduleGalleryResizeRefresh(gallery));
		this.galleryResizeObserver.observe(gallery);
	}

	private scheduleGalleryResizeRefresh(gallery: HTMLDivElement): void {
		if (this.pendingGalleryResizeFrame !== null) {
			return;
		}

		this.pendingGalleryResizeFrame = window.requestAnimationFrame(() => {
			this.pendingGalleryResizeFrame = null;
			if (this.virtualGalleryEl !== gallery || !this.virtualSpacerEl) {
				return;
			}
			const nextWidth = gallery.clientWidth || this.lastKnownGalleryWidth;
			if (Math.abs(nextWidth - this.lastKnownGalleryWidth) < 2) {
				return;
			}

			const scrollTop = this.readStableGalleryScrollTop(gallery);
			if (this.viewMode === "masonry") {
				const scrollAnchor = this.captureRenderedGalleryScrollAnchor(gallery) ?? this.captureGalleryScrollAnchor(gallery);
				this.lastKnownGalleryWidth = nextWidth;
				this.invalidateMasonryCache();
				this.protectedScrollAnchor = scrollAnchor;
				this.renderVisibleMasonryCards(gallery, this.virtualSpacerEl, scrollTop);
				this.protectGalleryScroll(this.gridScrollTop, scrollAnchor);
				return;
			}

			this.lastKnownGalleryWidth = nextWidth;
			this.renderVisibleGridCards(gallery, this.virtualSpacerEl, scrollTop);
		});
	}

	private renderVirtualGrid(gallery: HTMLDivElement, assets: Asset[], focusedAsset: Asset | undefined): void {
		this.bindVirtualGallery(gallery);
		this.virtualAssets = assets;
		this.virtualFocusedAssetId = focusedAsset?.id ?? null;

		const layout = this.getVirtualGridLayout(gallery);
		const rowCount = Math.ceil(assets.length / layout.columns);
		const viewportHeight = gallery.clientHeight || 720;
		const maxScrollTop = Math.max(0, rowCount * layout.rowStride - viewportHeight);
		this.gridScrollTop = Math.min(this.gridScrollTop, maxScrollTop);

		const spacer = gallery.createDiv({cls: "media-vault-virtual-spacer"});
		this.virtualSpacerEl = spacer;
		this.resetVirtualRenderedCards();
		spacer.style.height = `${Math.max(rowCount * layout.rowStride, viewportHeight)}px`;
		gallery.scrollTop = this.gridScrollTop;
		this.renderVisibleGridCards(gallery, spacer, this.gridScrollTop);
		gallery.addEventListener("scroll", () => this.handleGalleryScroll(gallery), {passive: true});
	}

	private renderVirtualMasonry(gallery: HTMLDivElement, assets: Asset[], focusedAsset: Asset | undefined): void {
		this.bindVirtualGallery(gallery);
		this.virtualAssets = assets;
		this.virtualFocusedAssetId = focusedAsset?.id ?? null;

		const spacer = gallery.createDiv({cls: "media-vault-virtual-spacer"});
		this.virtualSpacerEl = spacer;
		this.resetVirtualRenderedCards();
		this.invalidateMasonryCache();
		const layout = this.getMasonryLayout(gallery);
		const {height} = this.getCachedMasonryItems(assets, layout);
		const viewportHeight = gallery.clientHeight || 720;
		this.gridScrollTop = Math.min(this.gridScrollTop, Math.max(0, height - viewportHeight));
		spacer.style.height = `${Math.max(height, viewportHeight)}px`;
		gallery.scrollTop = this.gridScrollTop;
		this.renderVisibleMasonryCards(gallery, spacer, this.gridScrollTop);
		gallery.addEventListener("scroll", () => this.handleGalleryScroll(gallery), {passive: true});
		gallery.addEventListener("wheel", () => this.clearMasonryScrollGuards(), {passive: true});
		gallery.addEventListener("touchmove", () => this.clearMasonryScrollGuards(), {passive: true});
	}

	private enableGalleryBoxSelection(gallery: HTMLDivElement): void {
		gallery.addEventListener("pointerdown", (event: PointerEvent) => {
			if (event.button !== 0 || !this.canStartGalleryBoxSelection(event)) {
				return;
			}

			const startClientX = event.clientX;
			const startClientY = event.clientY;
			const startScrollTop = this.readStableGalleryScrollTop(gallery);
			const initialSelection = new Set(this.selectedAssetIds);
			const additive = event.metaKey || event.ctrlKey || event.shiftKey;
			let didDrag = false;
			const marquee = gallery.createDiv({cls: "media-vault-selection-marquee"});
			gallery.addClass("is-box-selecting");
			gallery.setPointerCapture(event.pointerId);
			event.preventDefault();

			const updateMarquee = (clientX: number, clientY: number) => {
				const galleryRect = gallery.getBoundingClientRect();
				const left = Math.min(startClientX, clientX) - galleryRect.left + gallery.scrollLeft;
				const top = Math.min(startClientY, clientY) - galleryRect.top + gallery.scrollTop;
				const width = Math.abs(clientX - startClientX);
				const height = Math.abs(clientY - startClientY);
				marquee.style.left = `${left}px`;
				marquee.style.top = `${top}px`;
				marquee.style.width = `${width}px`;
				marquee.style.height = `${height}px`;
			};

			const updateSelection = (clientX: number, clientY: number) => {
				const selectionRect = getClientSelectionRect(startClientX, startClientY, clientX, clientY);
				const nextSelection = additive ? new Set(initialSelection) : new Set<string>();
				let lastSelected: string | null = null;
				for (const item of this.getVisibleSelectableItems()) {
					const assetId = item.dataset.mediaVaultAssetId;
					if (!assetId || !rectsIntersect(selectionRect, item.getBoundingClientRect())) {
						continue;
					}
					nextSelection.add(assetId);
					lastSelected = assetId;
				}
				this.selectedAssetIds.clear();
				for (const assetId of nextSelection) {
					this.selectedAssetIds.add(assetId);
				}
				this.lastSelectedAssetId = lastSelected ?? this.lastSelectedAssetId;
				this.updateSelectionHighlight();
			};

			const handleMove = (moveEvent: PointerEvent) => {
				const distance = Math.hypot(moveEvent.clientX - startClientX, moveEvent.clientY - startClientY);
				if (distance < 4 && !didDrag) {
					return;
				}

				didDrag = true;
				updateMarquee(moveEvent.clientX, moveEvent.clientY);
				updateSelection(moveEvent.clientX, moveEvent.clientY);
				moveEvent.preventDefault();
			};

			const cleanup = (endEvent: PointerEvent) => {
				gallery.removeEventListener("pointermove", handleMove);
				gallery.removeEventListener("pointerup", cleanup);
				gallery.removeEventListener("pointercancel", cancel);
				if (gallery.hasPointerCapture(endEvent.pointerId)) {
					gallery.releasePointerCapture(endEvent.pointerId);
				}
				marquee.remove();
				gallery.removeClass("is-box-selecting");
				if (!didDrag) {
					this.selectedAssetIds.clear();
					for (const assetId of initialSelection) {
						this.selectedAssetIds.add(assetId);
					}
					this.updateSelectionHighlight();
					return;
				}

				this.gridScrollTop = this.readStableGalleryScrollTop(gallery) || startScrollTop;
				this.protectGalleryScroll(this.gridScrollTop, this.captureGalleryScrollAnchor(gallery));
				this.render();
			};

			const cancel = (cancelEvent: PointerEvent) => {
				gallery.removeEventListener("pointermove", handleMove);
				gallery.removeEventListener("pointerup", cleanup);
				gallery.removeEventListener("pointercancel", cancel);
				if (gallery.hasPointerCapture(cancelEvent.pointerId)) {
					gallery.releasePointerCapture(cancelEvent.pointerId);
				}
				marquee.remove();
				gallery.removeClass("is-box-selecting");
				this.selectedAssetIds.clear();
				for (const assetId of initialSelection) {
					this.selectedAssetIds.add(assetId);
				}
				this.updateSelectionHighlight();
			};

			gallery.addEventListener("pointermove", handleMove);
			gallery.addEventListener("pointerup", cleanup);
			gallery.addEventListener("pointercancel", cancel);
		});
	}

	private renderVisibleGridCards(gallery: HTMLDivElement, spacer: HTMLDivElement, preferredScrollTop?: number): void {
		const layout = this.getVirtualGridLayout(gallery);
		const rowCount = Math.ceil(this.virtualAssets.length / layout.columns);
		const viewportHeight = gallery.clientHeight || 720;
		const maxScrollTop = Math.max(0, rowCount * layout.rowStride - viewportHeight);
		const sourceScrollTop = preferredScrollTop ?? this.readStableGalleryScrollTop(gallery);
		this.gridScrollTop = Math.min(sourceScrollTop, maxScrollTop);
		spacer.style.height = `${Math.max(rowCount * layout.rowStride, viewportHeight)}px`;
		const visibleAssetIds = new Set<string>();

		const startRow = Math.max(0, Math.floor(this.gridScrollTop / layout.rowStride) - GRID_OVERSCAN_ROWS);
		const endRow = Math.min(
			rowCount,
			Math.ceil((this.gridScrollTop + viewportHeight) / layout.rowStride) + GRID_OVERSCAN_ROWS,
		);
		const startIndex = startRow * layout.columns;
		const endIndex = Math.min(this.virtualAssets.length, endRow * layout.columns);

		for (let index = startIndex; index < endIndex; index += 1) {
			const asset = this.virtualAssets[index];
			if (!asset) {
				continue;
			}

			const row = Math.floor(index / layout.columns);
			const column = index % layout.columns;
			visibleAssetIds.add(asset.id);
			const card = this.getOrCreateVirtualCard(spacer, asset, false, this.virtualFocusedAssetId === asset.id, layout.previewHeight);
			card.style.width = `${layout.cardWidth}px`;
			card.style.height = `${layout.cardHeight}px`;
			card.style.left = `${layout.leftInset + column * (layout.cardWidth + layout.gap)}px`;
			card.style.top = `${row * layout.rowStride}px`;
		}
		this.removeHiddenVirtualCards(visibleAssetIds);
	}

	private renderVisibleMasonryCards(gallery: HTMLDivElement, spacer: HTMLDivElement, preferredScrollTop?: number): void {
		const layout = this.getMasonryLayout(gallery);
		const {items, height} = this.getCachedMasonryItems(this.virtualAssets, layout);
		const viewportHeight = gallery.clientHeight || 720;
		const maxScrollTop = Math.max(0, height - viewportHeight);
		const sourceScrollTop = preferredScrollTop ?? this.readStableGalleryScrollTop(gallery);
		this.gridScrollTop = this.resolveProtectedMasonryScrollTop(items, sourceScrollTop, maxScrollTop);
		spacer.style.height = `${Math.max(height, viewportHeight)}px`;
		const visibleAssetIds = new Set<string>();

		const overscanHeight = (this.getMasonryMaxPreviewHeight() + this.getCardBodyHeight() + MASONRY_GAP) * 2;
		const startY = Math.max(0, this.gridScrollTop - overscanHeight);
		const endY = this.gridScrollTop + viewportHeight + overscanHeight;

		for (const item of items) {
			if (item.y + item.cardHeight < startY || item.y > endY) {
				continue;
			}

			visibleAssetIds.add(item.asset.id);
			const card = this.getOrCreateVirtualCard(spacer, item.asset, true, this.virtualFocusedAssetId === item.asset.id, item.previewHeight);
			card.style.width = `${layout.cardWidth}px`;
			card.style.height = `${item.cardHeight}px`;
			card.style.left = `${item.x}px`;
			card.style.top = `${item.y}px`;
		}
		this.removeHiddenVirtualCards(visibleAssetIds);
	}

	private resetVirtualRenderedCards(): void {
		this.virtualRenderedCards.clear();
	}

	private getOrCreateVirtualCard(spacer: HTMLDivElement, asset: Asset, isMasonry: boolean, isFocused: boolean, previewHeight?: number): HTMLDivElement {
		let card = this.virtualRenderedCards.get(asset.id);
		if (!card || card.parentElement !== spacer) {
			card = this.renderAssetCard(spacer, asset, isFocused, previewHeight);
			this.virtualRenderedCards.set(asset.id, card);
		}

		card.classList.toggle("is-masonry", isMasonry);
		card.classList.toggle("is-compact", this.viewMode === "compact");
		card.classList.toggle("is-card-body-empty", !this.hasVisibleCardBody());
		card.classList.toggle("is-focused", isFocused);
		card.style.setProperty("--media-vault-card-body-height", `${this.getCardBodyHeight()}px`);
		const isSelected = this.selectedAssetIds.has(asset.id);
		card.classList.toggle("is-selected", isSelected);
		card.setAttr("aria-label", `${asset.filename}，${isSelected ? "已选择" : "未选择"}`);
		card.setAttr("aria-selected", String(isSelected));
		const checkbox = card.querySelector<HTMLElement>(".media-vault-card-check");
		if (checkbox) {
			checkbox.setText(isSelected ? "✓" : "");
			checkbox.setAttr("aria-label", isSelected ? "取消选择图片" : "选择图片");
		}
		const preview = card.querySelector<HTMLElement>(".media-vault-card-preview");
		if (preview && previewHeight) {
			preview.style.height = `${previewHeight}px`;
		}
		return card;
	}

	private removeHiddenVirtualCards(visibleAssetIds: Set<string>): void {
		for (const [assetId, card] of this.virtualRenderedCards) {
			if (!visibleAssetIds.has(assetId)) {
				card.remove();
				this.virtualRenderedCards.delete(assetId);
			}
		}
	}

	private getVirtualGridLayout(gallery: HTMLElement): VirtualGridLayout {
		const width = gallery.clientWidth || this.lastKnownGalleryWidth || 1000;
		this.lastKnownGalleryWidth = width;
		const targetCardWidth = this.getGridCardWidth();
		const targetPreviewHeight = this.getGridPreviewHeight();
		const gap = this.viewMode === "compact" ? COMPACT_GAP : GRID_GAP;
		const {columns, cardWidth, leftInset} = getTightGalleryColumns(width, targetCardWidth, gap);
		const previewScale = cardWidth / Math.max(1, targetCardWidth);
		const previewHeight = Math.max(72, Math.round(targetPreviewHeight * previewScale));
		const cardHeight = this.viewMode === "compact" ? previewHeight : previewHeight + this.getCardBodyHeight();
		return {
			columns,
			cardWidth,
			cardHeight,
			previewHeight,
			gap,
			leftInset,
			rowStride: cardHeight + gap,
		};
	}

	private getMasonryLayout(gallery: HTMLElement): MasonryLayout {
		const width = gallery.clientWidth || this.lastKnownGalleryWidth || 1000;
		this.lastKnownGalleryWidth = width;
		const targetCardWidth = this.getMasonryCardWidth();
		const {columns, cardWidth, leftInset} = getTightGalleryColumns(width, targetCardWidth, MASONRY_GAP);
		return {
			columns,
			cardWidth,
			gap: MASONRY_GAP,
			leftInset,
		};
	}

	// 构建 Masonry 布局缓存 key，涵盖所有影响布局的参数
	private buildMasonryKey(assets: Asset[], layout: MasonryLayout): string {
		const ratioFingerprint = assets.length <= 500
			? assets.map((a) => this.imageAspectRatios.get(a.id) ?? getPersistedAspectRatio(a) ?? 0).join(",")
			: `${this.imageAspectRatios.size}`;
		return `${assets.length}:${layout.columns}:${layout.cardWidth}:${layout.gap}:${layout.leftInset}:${this.getCardBodyHeight()}:${ratioFingerprint}`;
	}

	// 带缓存的 getMasonryItems，避免每帧 O(N) 重算
	private getCachedMasonryItems(assets: Asset[], layout: MasonryLayout): {items: MasonryItem[]; height: number} {
		const key = this.buildMasonryKey(assets, layout);
		if (this.cachedMasonryResult && this.cachedMasonryKey === key) {
			return this.cachedMasonryResult;
		}
		const result = this.getMasonryItems(assets, layout);
		this.cachedMasonryKey = key;
		this.cachedMasonryResult = result;
		return result;
	}

	private invalidateMasonryCache(): void {
		this.cachedMasonryResult = null;
		this.cachedMasonryKey = "";
	}

	private getMasonryItems(assets: Asset[], layout: MasonryLayout): {items: MasonryItem[]; height: number} {
		const columnHeights = Array.from({length: layout.columns}, () => 0);
		const items: MasonryItem[] = [];

		for (const asset of assets) {
			const previewHeight = this.getMasonryPreviewHeight(asset, layout.cardWidth);
			const cardHeight = previewHeight + this.getCardBodyHeight();
			const column = getShortestColumnIndex(columnHeights);
			const x = layout.leftInset + column * (layout.cardWidth + layout.gap);
			const y = columnHeights[column] ?? 0;

			items.push({
				asset,
				x,
				y,
				cardHeight,
				previewHeight,
			});

			columnHeights[column] = y + cardHeight + layout.gap;
		}

		return {
			items,
			height: Math.max(...columnHeights, 0),
		};
	}

	private getMasonryPreviewHeight(asset: Asset, cardWidth: number): number {
		const ratio = this.imageAspectRatios.get(asset.id) ?? getPersistedAspectRatio(asset) ?? DEFAULT_ASPECT_RATIO;
		return clamp(Math.round(cardWidth / ratio), this.getMasonryMinPreviewHeight(), this.getMasonryMaxPreviewHeight());
	}

	private getGridCardWidth(): number {
		const baseWidth = this.viewMode === "compact" ? COMPACT_BASE_CARD_WIDTH : GRID_BASE_CARD_WIDTH;
		return Math.round(baseWidth * this.thumbnailScale);
	}

	private getGridPreviewHeight(): number {
		const baseHeight = this.viewMode === "compact" ? COMPACT_BASE_PREVIEW_HEIGHT : GRID_BASE_PREVIEW_HEIGHT;
		return Math.round(baseHeight * this.thumbnailScale);
	}

	private getCardBodyHeight(): number {
		if (!this.hasVisibleCardBody()) {
			return 0;
		}

		const fields = this.getGalleryDisplayFields();
		const hasTitle = fields.filename;
		const hasDescription = fields.description;
		const hasChips = this.hasVisibleCardChips();
		let height = 20;
		if (hasTitle) {
			height += 18;
		}
		if (hasDescription) {
			height += 17;
		}
		if (hasChips) {
			height += 27;
		}
		return Math.max(38, height);
	}

	private hasVisibleCardBody(): boolean {
		const fields = this.getGalleryDisplayFields();
		return fields.filename || fields.description || this.hasVisibleCardChips();
	}

	private hasVisibleCardChips(): boolean {
		const fields = this.getGalleryDisplayFields();
		return fields.dimensions
			|| fields.size
			|| fields.extension
			|| fields.references
			|| fields.tags
			|| fields.rating
			|| fields.mtime
			|| fields.path;
	}

	private getMasonryCardWidth(): number {
		return Math.round(MASONRY_BASE_CARD_WIDTH * this.thumbnailScale);
	}

	private getMasonryMinPreviewHeight(): number {
		return Math.round(MASONRY_MIN_PREVIEW_HEIGHT * this.thumbnailScale);
	}

	private getMasonryMaxPreviewHeight(): number {
		return Math.round(MASONRY_MAX_PREVIEW_HEIGHT * this.thumbnailScale);
	}

	private handleGalleryScroll(gallery: HTMLDivElement): void {
		this.lastGalleryScrollAt = Date.now();
		const isUnexpectedTopJump = this.viewMode === "masonry" && gallery.scrollTop <= 1 && (this.protectedScrollTop ?? 0) > 1;
		if (this.viewMode === "masonry" && this.protectedScrollTop !== null && !isUnexpectedTopJump && Math.abs(gallery.scrollTop - this.protectedScrollTop) > 4) {
			this.clearProtectedGalleryScroll();
		}
		this.gridScrollTop = this.readStableGalleryScrollTop(gallery);
		if (this.pendingScrollFrame !== null) {
			return;
		}

		this.pendingScrollFrame = window.requestAnimationFrame(() => {
			this.pendingScrollFrame = null;
			if (this.virtualGalleryEl !== gallery || !this.virtualSpacerEl) {
				return;
			}
			if (this.viewMode === "masonry") {
				this.renderVisibleMasonryCards(gallery, this.virtualSpacerEl);
			} else {
				this.renderVisibleGridCards(gallery, this.virtualSpacerEl);
			}
		});
	}

	private scheduleVirtualRefresh(anchor: GalleryScrollAnchor | null = null): void {
		if (this.pendingScrollFrame !== null) {
			if (anchor && !this.protectedScrollAnchor) {
				this.protectedScrollAnchor = anchor;
			}
			return;
		}

		this.pendingScrollFrame = window.requestAnimationFrame(() => {
			this.pendingScrollFrame = null;
			if (!this.virtualGalleryEl || !this.virtualSpacerEl) {
				return;
			}

			const preservedScrollTop = this.readStableGalleryScrollTop(this.virtualGalleryEl);
			const refreshAnchor = anchor ?? this.protectedScrollAnchor;
			if (refreshAnchor) {
				this.protectedScrollAnchor = refreshAnchor;
			}
			if (this.viewMode === "masonry") {
				this.renderVisibleMasonryCards(this.virtualGalleryEl, this.virtualSpacerEl);
			} else {
				this.renderVisibleGridCards(this.virtualGalleryEl, this.virtualSpacerEl);
			}
			this.protectGalleryScroll(preservedScrollTop, refreshAnchor);
		});
	}

	private scheduleDebouncedRatioRefresh(delayMs = MASONRY_RATIO_REFRESH_DEBOUNCE_MS): void {
		if (this.ratioRefreshTimeout !== null) {
			window.clearTimeout(this.ratioRefreshTimeout);
		}

		this.ratioRefreshTimeout = window.setTimeout(() => {
			this.ratioRefreshTimeout = null;
			if (this.pendingRatioUpdates.size === 0) {
				return;
			}

			const gallery = this.virtualGalleryEl;
			if (!gallery || this.viewMode !== "masonry") {
				this.pendingRatioUpdates.clear();
				return;
			}
			const msSinceScroll = Date.now() - this.lastGalleryScrollAt;
			if (msSinceScroll < MASONRY_RATIO_REFRESH_SCROLL_IDLE_MS) {
				this.scheduleDebouncedRatioRefresh(MASONRY_RATIO_REFRESH_SCROLL_IDLE_MS - msSinceScroll);
				return;
			}

			const scrollAnchor = this.captureGalleryScrollAnchor(gallery);
			this.invalidateMasonryCache();
			this.scheduleVirtualRefresh(scrollAnchor);
			this.pendingRatioUpdates.clear();
		}, delayMs);
	}

	private readStableGalleryScrollTop(gallery: HTMLDivElement): number {
		const lockedScroll = this.getActiveMasonryInteractionScrollLock();
		if (this.viewMode === "masonry" && gallery.scrollTop <= 1 && lockedScroll && lockedScroll.scrollTop > 1) {
			gallery.scrollTop = lockedScroll.scrollTop;
			this.protectedScrollTop = lockedScroll.scrollTop;
			this.protectedScrollAnchor = lockedScroll.anchor;
			return lockedScroll.scrollTop;
		}

		if (this.protectedScrollTop !== null && gallery.scrollTop <= 1 && this.protectedScrollTop > 1) {
			gallery.scrollTop = this.protectedScrollTop;
			return this.protectedScrollTop;
		}

		return gallery.scrollTop;
	}

	private readGalleryScrollTopForFocus(gallery: HTMLDivElement): number {
		if (this.viewMode === "masonry" && gallery.scrollTop <= 1) {
			const lockedScroll = this.getActiveMasonryInteractionScrollLock();
			const recoveredScrollTop = Math.max(lockedScroll?.scrollTop ?? 0, this.protectedScrollTop ?? 0, this.gridScrollTop);
			if (recoveredScrollTop > 1) {
				gallery.scrollTop = recoveredScrollTop;
				return recoveredScrollTop;
			}
		}

		return this.readStableGalleryScrollTop(gallery);
	}

	private getActiveMasonryInteractionScrollLock(): MasonryInteractionScrollLock | null {
		const lock = this.masonryInteractionScrollLock;
		if (!lock) {
			return null;
		}
		if (Date.now() > lock.expiresAt) {
			this.masonryInteractionScrollLock = null;
			return null;
		}
		return lock;
	}

	private clearMasonryInteractionScrollLock(): void {
		this.masonryInteractionScrollLock = null;
	}

	private clearMasonryScrollGuards(): void {
		this.clearMasonryInteractionScrollLock();
		this.clearProtectedGalleryScroll();
	}

	private clearProtectedGalleryScroll(): void {
		if (this.pendingScrollRestoreFrame !== null) {
			window.cancelAnimationFrame(this.pendingScrollRestoreFrame);
			this.pendingScrollRestoreFrame = null;
		}
		this.protectedScrollTop = null;
		this.protectedScrollAnchor = null;
	}

	private captureGalleryScrollAnchor(gallery: HTMLDivElement, preferredAssetId?: string): GalleryScrollAnchor | null {
		if (this.viewMode !== "masonry") {
			return null;
		}

		const scrollTop = this.readStableGalleryScrollTop(gallery);
		const layout = this.getMasonryLayout(gallery);
		const {items} = this.getCachedMasonryItems(this.virtualAssets, layout);
		const preferredItem = preferredAssetId ? items.find((item) => item.asset.id === preferredAssetId) : null;
		const anchorItem = preferredItem
			?? items.find((item) => item.y + item.cardHeight >= scrollTop)
			?? items[0];
		if (!anchorItem) {
			return null;
		}

		return {
			assetId: anchorItem.asset.id,
			viewportOffset: anchorItem.y - scrollTop,
		};
	}

	private captureRenderedGalleryScrollAnchor(gallery: HTMLDivElement): GalleryScrollAnchor | null {
		if (this.viewMode !== "masonry") {
			return null;
		}

		const scrollTop = this.readStableGalleryScrollTop(gallery);
		let closest: GalleryScrollAnchor | null = null;
		let closestDistance = Number.POSITIVE_INFINITY;
		for (const card of this.virtualRenderedCards.values()) {
			const assetId = card.dataset.mediaVaultAssetId;
			if (!assetId) {
				continue;
			}
			const top = Number.parseFloat(card.style.top || "0");
			const height = card.offsetHeight || Number.parseFloat(card.style.height || "0");
			if (!Number.isFinite(top) || !Number.isFinite(height) || top + height < scrollTop) {
				continue;
			}
			const distance = Math.abs(top - scrollTop);
			if (distance < closestDistance) {
				closestDistance = distance;
				closest = {
					assetId,
					viewportOffset: top - scrollTop,
				};
			}
		}
		return closest;
	}

	private resolveProtectedMasonryScrollTop(items: MasonryItem[], fallbackScrollTop: number, maxScrollTop: number): number {
		const fallback = clamp(fallbackScrollTop, 0, maxScrollTop);
		const anchor = this.protectedScrollAnchor;
		if (anchor) {
			const anchorItem = items.find((item) => item.asset.id === anchor.assetId);
			if (anchorItem) {
				const anchoredScrollTop = clamp(anchorItem.y - anchor.viewportOffset, 0, maxScrollTop);
				if (fallback > 1 && anchoredScrollTop <= 1 && anchor.viewportOffset > 1) {
					return fallback;
				}
				return anchoredScrollTop;
			}
		}

		return fallback;
	}

	private resolveProtectedGalleryScrollTop(gallery: HTMLDivElement, fallbackScrollTop: number, maxScrollTop: number): number {
		if (this.viewMode !== "masonry" || !this.protectedScrollAnchor) {
			return clamp(fallbackScrollTop, 0, maxScrollTop);
		}

		const layout = this.getMasonryLayout(gallery);
		const {items} = this.getCachedMasonryItems(this.virtualAssets, layout);
		return this.resolveProtectedMasonryScrollTop(items, fallbackScrollTop, maxScrollTop);
	}

	private protectGalleryScroll(scrollTop: number, anchor: GalleryScrollAnchor | null = null): void {
		if (!Number.isFinite(scrollTop) || scrollTop <= 0) {
			return;
		}

		this.protectedScrollTop = scrollTop;
		this.protectedScrollAnchor = anchor;
		this.gridScrollTop = scrollTop;
		if (this.pendingScrollRestoreFrame !== null) {
			window.cancelAnimationFrame(this.pendingScrollRestoreFrame);
			this.pendingScrollRestoreFrame = null;
		}

		let framesLeft = 3;
		const restore = () => {
			const targetScrollTop = this.protectedScrollTop;
			const gallery = this.virtualGalleryEl;
			if (!gallery || targetScrollTop === null) {
				framesLeft -= 1;
				if (framesLeft > 0 && targetScrollTop !== null) {
					this.pendingScrollRestoreFrame = window.requestAnimationFrame(restore);
					return;
				}

				this.pendingScrollRestoreFrame = null;
				this.protectedScrollTop = null;
				return;
			}

			const maxScrollTop = Math.max(0, gallery.scrollHeight - (gallery.clientHeight || 0));
			if (maxScrollTop <= 1 && targetScrollTop > 1) {
				framesLeft -= 1;
				if (framesLeft > 0) {
					this.pendingScrollRestoreFrame = window.requestAnimationFrame(restore);
					return;
				}
			}
			const nextScrollTop = this.resolveProtectedGalleryScrollTop(gallery, targetScrollTop, maxScrollTop);
			if (Math.abs(gallery.scrollTop - nextScrollTop) > 1) {
				gallery.scrollTop = nextScrollTop;
			}
			this.gridScrollTop = nextScrollTop;

			framesLeft -= 1;
			if (framesLeft > 0) {
				this.pendingScrollRestoreFrame = window.requestAnimationFrame(restore);
				return;
			}

			this.pendingScrollRestoreFrame = null;
			this.protectedScrollTop = null;
			this.protectedScrollAnchor = null;
		};

		this.pendingScrollRestoreFrame = window.requestAnimationFrame(restore);
	}

	private renderAssetCard(gallery: Element, asset: Asset, isFocused: boolean, previewHeight?: number): HTMLDivElement {
		const isSelected = this.selectedAssetIds.has(asset.id);
		const card = gallery.createDiv({cls: `media-vault-card ${isFocused ? "is-focused" : ""} ${isSelected ? "is-selected" : ""}`});
		card.dataset.mediaVaultAssetId = asset.id;
		card.addEventListener("pointerdown", (event: PointerEvent) => {
			if (event.button !== 0) {
				return;
			}
			this.preserveMasonryScrollBeforeAssetInteraction(asset.id);
		});
		this.enableAssetKeyboard(card, asset, isSelected);
		this.enableAssetDrag(card, asset);
		const checkbox = card.createEl("button", {cls: "media-vault-card-check", text: isSelected ? "✓" : ""});
		checkbox.setAttr("aria-label", isSelected ? "取消选择图片" : "选择图片");
		checkbox.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggleAssetSelection(asset.id, event.shiftKey);
		});
		if (asset.status !== "trash") {
			const favorite = card.createEl("button", {
				cls: `media-vault-card-favorite ${asset.favorite ? "is-active" : ""}`,
				text: asset.favorite ? "★" : "☆",
			});
			favorite.setAttr("aria-label", asset.favorite ? "取消收藏" : "收藏图片");
			favorite.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.plugin.toggleAssetFavorite(asset.id);
			});
		} else {
			const restore = card.createEl("button", {cls: "media-vault-card-restore", text: "恢复"});
			restore.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.restoreAssets([asset.id]);
			});
		}
		const preview = card.createDiv({cls: "media-vault-card-preview"});
		if (previewHeight) {
			preview.style.height = `${previewHeight}px`;
		}
		const resourcePath = this.plugin.services.thumbnailService.getResourcePath(asset);
		if (resourcePath) {
			const img = preview.createEl("img", {attr: {loading: "lazy", decoding: "async", src: resourcePath, alt: asset.filename}});
			img.addEventListener("load", () => {
				if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
					return;
				}

				const ratio = img.naturalWidth / img.naturalHeight;
				const previousRatio = this.imageAspectRatios.get(asset.id) ?? getPersistedAspectRatio(asset);
				if (!previousRatio || Math.abs(previousRatio - ratio) > 0.02) {
					this.imageAspectRatios.set(asset.id, ratio);
					if (this.viewMode === "masonry") {
						this.pendingRatioUpdates.add(asset.id);
						this.scheduleDebouncedRatioRefresh();
					}
				}
			});
			img.addEventListener("error", () => preview.addClass("has-error"));
		} else {
			preview.createDiv({cls: "media-vault-missing-preview", text: "Missing"});
		}

		const body = card.createDiv({cls: "media-vault-card-body"});
		body.createDiv({cls: "media-vault-card-title media-vault-field-filename", text: asset.filename});
		body.createDiv({cls: "media-vault-card-description media-vault-field-description", text: this.getAssetDescription(asset)});
		const meta = body.createDiv({cls: "media-vault-card-meta"});
		const chips = meta.createDiv({cls: "media-vault-card-chips"});
		chips.createSpan({cls: "media-vault-card-chip media-vault-field-dimensions", text: asset.width && asset.height ? `${asset.width}x${asset.height}` : "未知尺寸"});
		chips.createSpan({cls: "media-vault-card-chip media-vault-field-size", text: formatFileSize(asset.sizeBytes)});
		chips.createSpan({cls: "media-vault-card-chip media-vault-field-extension", text: asset.ext.toUpperCase()});
		if (asset.referenceCount > 0) {
			chips.createSpan({cls: "media-vault-card-chip media-vault-field-references is-accent", text: `${asset.referenceCount} 引用`});
		}
		if (asset.tags.length > 0) {
			chips.createSpan({cls: "media-vault-card-chip media-vault-field-tags", text: `${asset.tags.length} 标签`});
		}
		if (asset.rating && asset.rating > 0) {
			chips.createSpan({cls: "media-vault-card-chip media-vault-field-rating is-rating", text: this.getAssetRatingLabel(asset)});
		}
		chips.createSpan({cls: "media-vault-card-chip media-vault-field-mtime", text: formatDate(asset.mtime)});
		chips.createSpan({cls: "media-vault-card-chip media-vault-field-path", text: getParentPath(asset.filePath) || "根目录"});

		card.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.metaKey || event.ctrlKey || event.shiftKey) {
				this.toggleAssetSelection(asset.id, event.shiftKey);
				return;
			}
			this.focusAsset(asset.id);
		});
		card.addEventListener("dblclick", () => this.plugin.openAssetDetail(asset.id));
		card.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.openAssetContextMenu(event, asset);
		});
		return card;
	}

	private preserveMasonryScrollBeforeAssetInteraction(assetId: string): void {
		const gallery = this.virtualGalleryEl;
		if (this.viewMode !== "masonry" || !gallery) {
			return;
		}

		const scrollTop = Math.max(
			gallery.scrollTop,
			this.gridScrollTop,
			this.protectedScrollTop ?? 0,
			this.masonryInteractionScrollLock?.scrollTop ?? 0,
		);
		if (scrollTop <= 1) {
			return;
		}

		const anchor = this.captureGalleryScrollAnchor(gallery, assetId);
		this.masonryInteractionScrollLock = {
			scrollTop,
			anchor,
			expiresAt: Date.now() + MASONRY_INTERACTION_SCROLL_LOCK_MS,
		};
		this.protectGalleryScroll(scrollTop, anchor);
	}

	private renderAssetRow(gallery: Element, asset: Asset, isFocused: boolean): void {
		const isSelected = this.selectedAssetIds.has(asset.id);
		const row = gallery.createDiv({cls: `media-vault-row ${isFocused ? "is-focused" : ""} ${isSelected ? "is-selected" : ""}`});
		row.dataset.mediaVaultAssetId = asset.id;
		this.enableAssetKeyboard(row, asset, isSelected);
		this.enableAssetDrag(row, asset);
		const checkbox = row.createEl("button", {cls: "media-vault-row-check", text: isSelected ? "✓" : ""});
		checkbox.setAttr("aria-label", isSelected ? "取消选择图片" : "选择图片");
		checkbox.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggleAssetSelection(asset.id, event.shiftKey);
		});
		if (asset.status === "trash") {
			const restore = row.createEl("button", {cls: "media-vault-row-action", text: "恢复"});
			restore.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.restoreAssets([asset.id]);
			});
		} else {
			const favorite = row.createEl("button", {
				cls: `media-vault-row-favorite ${asset.favorite ? "is-active" : ""}`,
				text: asset.favorite ? "★" : "☆",
			});
			favorite.setAttr("aria-label", asset.favorite ? "取消收藏" : "收藏图片");
			favorite.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.plugin.toggleAssetFavorite(asset.id);
			});
		}
		const thumbnail = row.createDiv({cls: "media-vault-row-thumb"});
		const resourcePath = this.plugin.services.thumbnailService.getResourcePath(asset);
		if (resourcePath) {
			thumbnail.createEl("img", {attr: {loading: "lazy", decoding: "async", src: resourcePath, alt: asset.filename}});
		}
		row.createDiv({cls: "media-vault-row-name media-vault-field-filename", text: asset.filename});
		row.createDiv({cls: "media-vault-row-description media-vault-field-description", text: this.getAssetDescription(asset)});
		row.createDiv({cls: "media-vault-field-extension", text: asset.ext.toUpperCase()});
		row.createDiv({cls: "media-vault-field-dimensions", text: formatDimensions(asset)});
		row.createDiv({cls: "media-vault-field-size", text: formatFileSize(asset.sizeBytes)});
		row.createDiv({cls: "media-vault-row-tags media-vault-field-tags", text: asset.tags.length > 0 ? asset.tags.slice(0, 2).join("、") : "无"});
		row.createDiv({cls: "media-vault-row-rating media-vault-field-rating", text: this.getAssetRatingLabel(asset)});
		row.createDiv({cls: "media-vault-field-references", text: `${asset.referenceCount} 引用`});
		row.createDiv({cls: "media-vault-field-mtime", text: formatDate(asset.mtime)});
		row.createDiv({cls: "media-vault-row-path media-vault-field-path", text: asset.filePath});
		row.addEventListener("click", (event) => {
			if (event.metaKey || event.ctrlKey || event.shiftKey) {
				this.toggleAssetSelection(asset.id, event.shiftKey);
				return;
			}
			this.focusAsset(asset.id);
		});
		row.addEventListener("dblclick", () => this.plugin.openAssetDetail(asset.id));
		row.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.openAssetContextMenu(event, asset);
		});
	}

	private enableAssetKeyboard(element: HTMLElement, asset: Asset, isSelected: boolean): void {
		element.tabIndex = 0;
		element.setAttr("role", "button");
		element.setAttr("aria-label", `${asset.filename}，${isSelected ? "已选择" : "未选择"}`);
		element.setAttr("aria-selected", String(isSelected));
		element.addEventListener("focus", () => {
			this.preserveMasonryScrollBeforeAssetInteraction(asset.id);
			this.focusAsset(asset.id);
		});
		element.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === " " || event.key === "Spacebar") {
				event.preventDefault();
				event.stopPropagation();
				if (event.shiftKey || event.metaKey || event.ctrlKey) {
					this.toggleAssetSelection(asset.id, event.shiftKey);
				} else {
					this.openAssetPreview(asset.id);
				}
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				this.plugin.openAssetDetail(asset.id);
			}
		});
	}

	private enableAssetDrag(element: HTMLElement, asset: Asset): void {
		if (asset.status !== "active") {
			return;
		}
		element.draggable = true;
		element.addEventListener("dragstart", (event: DragEvent) => {
			const markdown = `![[${asset.filePath}]]`;
			element.addClass("is-dragging");
			event.dataTransfer?.setData("text/plain", markdown);
			event.dataTransfer?.setData("text/markdown", markdown);
			event.dataTransfer?.setData("application/x-media-vault-asset-id", asset.id);
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = "copy";
			}
		});
		element.addEventListener("dragend", () => {
			element.removeClass("is-dragging");
		});
	}

	private openAssetContextMenu(event: MouseEvent, asset: Asset): void {
		this.focusAsset(asset.id);
		const menu = new Menu();
		if (asset.status === "trash") {
			menu.addItem((item) => item
				.setTitle("恢复图片")
				.setIcon("rotate-ccw")
				.onClick(() => void this.restoreAssets([asset.id])));
			menu.addItem((item) => item
				.setTitle("打开图片详情")
				.setIcon("image")
				.onClick(() => this.plugin.openAssetDetail(asset.id)));
			menu.showAtMouseEvent(event);
			return;
		}

		menu.addItem((item) => item
			.setTitle("打开图片详情")
			.setIcon("image")
			.onClick(() => this.plugin.openAssetDetail(asset.id)));
			menu.addItem((item) => item
				.setTitle("创建区域标注")
				.setIcon("scan-line")
				.onClick(() => this.plugin.openAssetDetail(asset.id, "annotation")));
			menu.addItem((item) => item
				.setTitle("录入识别文本")
				.setIcon("text-search")
				.onClick(() => this.plugin.openAssetDetail(asset.id, "ocr")));
			menu.addItem((item) => item
				.setTitle("生成 AI 标签建议")
				.setIcon("sparkles")
				.onClick(() => void this.plugin.openAiSuggestionsForAsset(asset)));
			menu.addItem((item) => item
				.setTitle("在笔记中查看引用")
				.setIcon("links-coming-in")
			.onClick(() => this.openAssetReferences(asset)));
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle("插入当前笔记")
			.setIcon("plus-circle")
			.onClick(() => void this.plugin.insertAsset(asset)));
			menu.addItem((item) => item
				.setTitle("复制 wiki 链接")
				.setIcon("copy")
				.onClick(() => void this.plugin.copyAssetWikiLink(asset)));
			menu.addItem((item) => item
				.setTitle("复制文件路径")
				.setIcon("clipboard")
				.onClick(() => void this.plugin.copyAssetPath(asset)));
			menu.addItem((item) => item
				.setTitle("在文件管理器中显示")
				.setIcon("folder-search")
				.onClick(() => void this.plugin.showAssetInFileManager(asset)));
			menu.addItem((item) => item
				.setTitle("外部打开")
				.setIcon("external-link")
				.onClick(() => void this.plugin.openAssetWithDefaultApp(asset)));
			menu.addItem((item) => item
				.setTitle("降级为当前笔记附件")
				.setIcon("folder-input")
				.setDisabled(!this.plugin.getActiveMarkdownFile())
				.onClick(() => void this.plugin.demoteAssetToCurrentNoteAttachment(asset)));
			menu.addItem((item) => item
				.setTitle(asset.favorite ? "取消收藏" : "收藏")
				.setIcon("star")
				.setChecked(asset.favorite)
			.onClick(() => void this.plugin.toggleAssetFavorite(asset.id)));
		menu.addSeparator();
		const duplicateCandidates = getDuplicateCandidates(asset, this.plugin.services.assetRepository.getAssets());
		menu.addItem((item) => item
			.setTitle(duplicateCandidates.length > 0 ? `查找相似图片（${duplicateCandidates.length}）` : "查找相似图片")
			.setIcon("search")
			.onClick(() => this.openSimilarAssets(asset.id)));
			menu.addItem((item) => item
				.setTitle("移动")
				.setIcon("folder-input")
				.onClick(() => this.openSingleAssetBatchMove(asset.id)));
			menu.addItem((item) => item
				.setTitle("重命名")
				.setIcon("pencil")
				.onClick(() => this.openAssetRenameModal(asset)));
			menu.addItem((item) => item
				.setTitle("删除 / 归档")
				.setIcon("trash")
			.setWarning(true)
			.onClick(() => this.openSingleAssetDelete(asset.id)));
		menu.showAtMouseEvent(event);
	}

	private openAssetReferences(asset: Asset): void {
		this.plugin.openAssetDetail(asset.id, "references");
	}

		private openAssetRenameModal(asset: Asset): void {
			new AssetRenameModal(this.app, this.plugin, asset, () => {
				this.render();
			}).open();
		}

	private openSingleAssetBatchMove(assetId: string): void {
		this.selectedAssetIds.clear();
		this.selectedAssetIds.add(assetId);
		this.lastSelectedAssetId = assetId;
		this.openBatchModal();
	}

	private openSingleAssetDelete(assetId: string): void {
		this.openDeleteRiskForAssets([assetId]);
	}

	private openDeleteRiskForAssets(assetIds: string[]): void {
		this.selectedAssetIds.clear();
		for (const assetId of assetIds) {
			this.selectedAssetIds.add(assetId);
		}
		this.lastSelectedAssetId = assetIds[0] ?? null;
		this.openDeleteRiskModal();
	}

	private canStartGalleryBoxSelection(event: PointerEvent): boolean {
		const target = event.target;
		if (!(target instanceof HTMLElement)) {
			return false;
		}
		if (!target.closest(".media-vault-gallery-masonry, .media-vault-gallery-grid, .media-vault-gallery-list, .media-vault-gallery-compact")) {
			return false;
		}
		return !target.closest(".media-vault-card, .media-vault-row, button, input, select, textarea, a");
	}

	private getVisibleSelectableItems(): HTMLElement[] {
		return Array.from(this.contentEl.querySelectorAll<HTMLElement>(".media-vault-card, .media-vault-row"));
	}

	private updateFocusedAssetHighlight(): void {
		const focusedAssetId = this.focusedAssetId;
		const selectableItems = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".media-vault-card, .media-vault-row"));
		for (const item of selectableItems) {
			item.classList.toggle("is-focused", Boolean(focusedAssetId && item.dataset.mediaVaultAssetId === focusedAssetId));
		}
	}

	private updateSelectionHighlight(): void {
		for (const item of this.getVisibleSelectableItems()) {
			const assetId = item.dataset.mediaVaultAssetId;
			const isSelected = Boolean(assetId && this.selectedAssetIds.has(assetId));
			item.classList.toggle("is-selected", isSelected);
			item.setAttr("aria-selected", String(isSelected));
			const asset = assetId ? this.plugin.services.assetRepository.getAssetById(assetId) : undefined;
			if (asset) {
				item.setAttr("aria-label", `${asset.filename}，${isSelected ? "已选择" : "未选择"}`);
			}
			const check = item.querySelector<HTMLElement>(".media-vault-card-check, .media-vault-row-check");
			if (check) {
				check.setText(isSelected ? "✓" : "");
				check.setAttr("aria-label", isSelected ? "取消选择图片" : "选择图片");
			}
		}
	}

	private toggleAssetSelection(assetId: string, rangeSelect: boolean): void {
		if (rangeSelect && this.lastSelectedAssetId) {
			this.selectAssetRange(this.lastSelectedAssetId, assetId);
		} else if (this.selectedAssetIds.has(assetId)) {
			this.selectedAssetIds.delete(assetId);
			this.lastSelectedAssetId = assetId;
		} else {
			this.selectedAssetIds.add(assetId);
			this.lastSelectedAssetId = assetId;
		}
		this.render();
	}

	private selectAssetRange(fromAssetId: string, toAssetId: string): void {
		const assets = this.virtualAssets.length > 0 ? this.virtualAssets : this.getFilteredAssets();
		const fromIndex = assets.findIndex((asset) => asset.id === fromAssetId);
		const toIndex = assets.findIndex((asset) => asset.id === toAssetId);
		if (fromIndex === -1 || toIndex === -1) {
			this.selectedAssetIds.add(toAssetId);
			this.lastSelectedAssetId = toAssetId;
			return;
		}

		const start = Math.min(fromIndex, toIndex);
		const end = Math.max(fromIndex, toIndex);
		for (const asset of assets.slice(start, end + 1)) {
			this.selectedAssetIds.add(asset.id);
		}
		this.lastSelectedAssetId = toAssetId;
	}

	private clearSelection(render = true): void {
		this.selectedAssetIds.clear();
		this.lastSelectedAssetId = null;
		this.batchModalOpen = false;
		this.deleteRiskModalOpen = false;
		this.permanentDeleteConfirmText = "";
		this.deleteIncludeVariants = false;
		if (render) {
			this.render();
		}
	}

	private pruneSelection(assets: Asset[]): void {
		if (this.selectedAssetIds.size === 0) {
			return;
		}
		const visibleAssetIds = new Set(assets.map((asset) => asset.id));
		for (const assetId of Array.from(this.selectedAssetIds)) {
			if (!visibleAssetIds.has(assetId)) {
				this.selectedAssetIds.delete(assetId);
			}
		}
		if (this.lastSelectedAssetId && !this.selectedAssetIds.has(this.lastSelectedAssetId)) {
			this.lastSelectedAssetId = null;
		}
	}

	private getSelectedAssets(): Asset[] {
		const assets = this.plugin.services.assetRepository.getAssets()
			.filter((asset) => this.selectedAssetIds.has(asset.id));
		return assets.sort((a, b) => a.filename.localeCompare(b.filename));
	}

	private getUnreferencedSelectedAssetIds(): string[] {
		return this.getSelectedAssets()
			.filter((asset) => this.plugin.services.assetRepository.getReferencesForAsset(asset.id).length === 0)
			.map((asset) => asset.id);
	}

	openConvertDryRun(assetId?: string): boolean {
		if (assetId) {
			const asset = this.plugin.services.assetRepository.getAssetById(assetId);
			if (!asset || asset.status !== "active") {
				return false;
			}
			this.selectedAssetIds.clear();
			this.selectedAssetIds.add(asset.id);
			this.lastSelectedAssetId = asset.id;
		} else if (this.selectedAssetIds.size === 0) {
			const focused = this.plugin.getFocusedAsset();
			if (!focused || focused.status !== "active") {
				return false;
			}
			this.selectedAssetIds.add(focused.id);
			this.lastSelectedAssetId = focused.id;
		}

		this.openBatchModal("convert");
		return true;
	}

	private openBatchModal(focusField: BatchFocusField = null): void {
		if (this.selectedAssetIds.size === 0) {
			return;
		}
		this.batchFocusField = focusField;
		if (focusField === "convert") {
			this.batchDraft.convertEnabled = true;
		}
		this.batchModalOpen = true;
		this.deleteRiskModalOpen = false;
		this.permanentDeleteConfirmText = "";
		this.deleteIncludeVariants = false;
		this.filterDrawerOpen = false;
		this.render();
	}

	private async restoreSavedBatchDraft(): Promise<void> {
		const savedDraft = await loadBatchOperationDraft(this.plugin);
		if (!savedDraft) {
			return;
		}

		const draft = normalizeBatchOperationDraft(savedDraft);
		this.batchDraft = draft;
		const knownAssetIds = new Set(this.plugin.services.assetRepository.getAssets().map((asset) => asset.id));
		const restoredAssetIds = draft.assetIds.filter((assetId) => knownAssetIds.has(assetId));
		this.selectedAssetIds.clear();
		for (const assetId of restoredAssetIds) {
			this.selectedAssetIds.add(assetId);
		}
		this.lastSelectedAssetId = restoredAssetIds.at(-1) ?? null;
	}

	private async saveCurrentBatchDraft(): Promise<void> {
		this.batchDraft = normalizeBatchOperationDraft({
			...this.batchDraft,
			assetIds: Array.from(this.selectedAssetIds),
		});
		await saveBatchOperationDraft(this.plugin, this.batchDraft);
		this.batchModalOpen = false;
		this.batchFocusField = null;
		new Notice(`已保存批量操作草稿：${this.batchDraft.assetIds.length} 张图片，${this.getBatchOperationCount()} 项操作。`);
		this.render();
	}

	private openDeleteRiskModal(): void {
		if (this.selectedAssetIds.size === 0) {
			return;
		}
		this.deleteMode = "trash";
		this.permanentDeleteConfirmText = "";
		this.deleteIncludeVariants = false;
		this.deleteRiskModalOpen = true;
		this.batchModalOpen = false;
		this.filterDrawerOpen = false;
		this.render();
	}

	private buildBatchPreflight(deleteMode?: DeleteMode): BatchPreflightResult {
		const assets = this.getSelectedAssets();
		const warnings: string[] = [];
		const errors: string[] = [];
		const steps: string[] = [];
		const itemResults: BatchPreflightItem[] = [];
		const affectedNotes = new Set<string>();
		const selectedAssetIdSet = new Set(this.selectedAssetIds);
		let referencedAssets = 0;
			let brokenLinksIfNotRewrite = 0;
			let annotatedAssets = 0;
			let annotationCount = 0;
			let variantAssets = 0;
			let variantCount = 0;
				let plannedMoves = 0;
				let plannedMarkdownLinkRewrites = 0;
				let plannedRollbackSteps = 0;
				let newCollections = 0;
				const noteRewritePlanCounts = new Map<string, number>();
				const reservedMoveTargets = new Set<string>();

				const addTags = splitTextList(this.batchDraft.addTags);
				const removeTags = splitTextList(this.batchDraft.removeTags);
				const addCollections = splitTextList(this.batchDraft.addCollections);
			const moveToFolder = this.batchDraft.moveToFolder.trim();
			const normalizedMoveFolder = moveToFolder ? joinVaultPath(moveToFolder) : "";
			const missingSelectedCount = this.selectedAssetIds.size - assets.length;
			if (missingSelectedCount > 0) {
				errors.push(`${missingSelectedCount} 张所选图片不在当前索引中，请重建索引后再执行。`);
		}
			if (addTags.length > 0) {
				steps.push(`添加标签：${addTags.join("、")}`);
			}
			if (removeTags.length > 0) {
				steps.push(`移除标签：${removeTags.join("、")}`);
			}
				if (addCollections.length > 0) {
					steps.push(`加入集合：${addCollections.join("、")}`);
				const existingCollectionNames = new Set(this.plugin.services.assetRepository.getCollections().map((collection) => collection.name.toLowerCase()));
				const collectionsToCreate = addCollections.filter((collection) => !existingCollectionNames.has(collection.toLowerCase()));
				newCollections = collectionsToCreate.length;
				if (collectionsToCreate.length > 0) {
					steps.push(`创建手动 Collection：${collectionsToCreate.join("、")}`);
				}
			}
			if (this.batchDraft.setRating !== "") {
				steps.push(`设置评分：${this.batchDraft.setRating} 星`);
				}
			if (this.batchDraft.copyWikiLinks) {
				steps.push(`复制 ${assets.length} 条 Wiki 链接到剪贴板`);
			}
				if (moveToFolder) {
					steps.push(`移动到文件夹：${normalizedMoveFolder}`);
					if (!this.batchDraft.rewriteMarkdownLinks) {
					warnings.push("移动图片但未开启 Markdown 链接改写，会产生潜在断链。");
				}
		}
		if (this.batchDraft.convertEnabled) {
			steps.push(`转换为 ${this.batchDraft.convertFormat.toUpperCase()}`);
			warnings.push("压缩/转换当前只生成 dry run，MVP 不直接改写原图。");
			const maxEdge = this.batchDraft.convertMaxEdge.trim();
			const quality = this.batchDraft.convertQuality.trim();
			if (maxEdge && (!Number.isFinite(Number(maxEdge)) || Number(maxEdge) <= 0)) {
				errors.push("转换最长边必须是大于 0 的数字。");
			}
			if (quality && (!Number.isFinite(Number(quality)) || Number(quality) < 1 || Number(quality) > 100)) {
				errors.push("转换质量必须在 1 到 100 之间。");
			}
		}
		if (deleteMode) {
			steps.push(deleteMode === "archive" ? "归档所选图片" : deleteMode === "permanent" ? "永久删除所选图片" : "移入回收站");
		}
		if (steps.length === 0) {
			steps.push("尚未选择任何批量操作。");
		}

			for (const asset of assets) {
				const references = this.plugin.services.assetRepository.getReferencesForAsset(asset.id);
				const annotations = this.plugin.services.assetRepository.getAnnotationsForAsset(asset.id);
				const variants = deleteMode
					? this.getVersionCandidates(asset).filter((candidate) => !selectedAssetIdSet.has(candidate.id) && candidate.status === "active")
					: [];
				const referenceNotes = Array.from(new Set(references.map((reference) => reference.sourceNotePath))).sort();
				const referenceCount = references.length;
				const annotationItemCount = annotations.length;
				const variantItemCount = variants.length;
					let targetPath: string | undefined;
					let markdownRewriteCount = 0;
						let proposedAction = getMetadataOperationLabel(addTags, removeTags, addCollections, this.batchDraft.setRating);
					if (this.batchDraft.copyWikiLinks) {
						proposedAction = proposedAction === "仅预检" ? "复制 Wiki 链接" : `${proposedAction} + 复制链接`;
					}
					let riskLevel: BatchRiskLevel = "low";
					for (const notePath of referenceNotes) {
						affectedNotes.add(notePath);
				}
				if (referenceNotes.length > 0) {
					referencedAssets += 1;
				}
				if (annotations.length > 0) {
					annotatedAssets += 1;
					annotationCount += annotations.length;
				}
				if (variantItemCount > 0) {
					variantAssets += 1;
					variantCount += variantItemCount;
				}
				const itemWarnings: string[] = [];
				const file = this.app.vault.getAbstractFileByPath(asset.filePath);
				if ((normalizedMoveFolder || deleteMode) && !(file instanceof TFile)) {
					errors.push(`${asset.filename} 文件不存在，无法执行文件操作。`);
					itemWarnings.push("源文件不存在");
					riskLevel = "high";
				}
				if (normalizedMoveFolder) {
					targetPath = getAvailablePreflightMovePath(this.app, joinVaultPath(normalizedMoveFolder, asset.filename), asset.filePath, reservedMoveTargets);
					reservedMoveTargets.add(targetPath);
					if (targetPath !== asset.filePath) {
						plannedMoves += 1;
						plannedRollbackSteps += 1;
						proposedAction = this.batchDraft.rewriteMarkdownLinks ? "移动并改写引用" : "移动，不改写引用";
						if (this.batchDraft.rewriteMarkdownLinks) {
							markdownRewriteCount = referenceCount;
							plannedMarkdownLinkRewrites += referenceCount;
							if (referenceCount > 0) {
								plannedRollbackSteps += referenceNotes.length;
							}
							for (const reference of references) {
								noteRewritePlanCounts.set(reference.sourceNotePath, (noteRewritePlanCounts.get(reference.sourceNotePath) ?? 0) + 1);
							}
						}
					} else {
						itemWarnings.push("已在目标文件夹，将跳过移动");
					}
				}
				if ((moveToFolder || deleteMode) && references.length > 0) {
					itemWarnings.push(`${references.length} 处引用需要处理`);
					if (!this.batchDraft.rewriteMarkdownLinks || deleteMode) {
						brokenLinksIfNotRewrite += references.length;
					}
				}
				if (asset.notePath && deleteMode) {
					itemWarnings.push("绑定 Asset Note，删除前建议改为归档");
				}
				if (annotations.length > 0 && deleteMode) {
					itemWarnings.push(`${annotations.length} 个区域标注会失效`);
				}
				if (variantItemCount > 0 && deleteMode) {
					itemWarnings.push(`发现 ${variantItemCount} 个潜在变体/压缩版本未选中`);
				}
				if (deleteMode) {
					proposedAction = deleteMode === "archive" ? "归档资产记录" : deleteMode === "permanent" ? "永久删除文件" : "移入回收站";
					plannedRollbackSteps += 1;
				}
				riskLevel = getBatchRiskLevel(riskLevel, {
					deleteMode,
					hasReferences: referenceCount > 0,
					hasAssetNote: Boolean(asset.notePath),
					hasAnnotations: annotationItemCount > 0,
					hasVariants: variantItemCount > 0,
					willBreakLinks: (!this.batchDraft.rewriteMarkdownLinks || Boolean(deleteMode)) && referenceCount > 0,
				});
				itemResults.push({
					asset,
					referenceNotes,
					referenceCount,
					annotationCount: annotationItemCount,
					variantCount: variantItemCount,
					targetPath,
					markdownRewriteCount,
					proposedAction,
					riskLevel,
					warnings: itemWarnings,
				});
			}

			return {
				totalAssets: assets.length,
				referencedAssets,
				affectedNotes: affectedNotes.size,
				annotatedAssets,
				annotationCount,
				variantAssets,
				variantCount,
				brokenLinksIfNotRewrite,
					plannedMoves,
					plannedMarkdownLinkRewrites,
					plannedRollbackSteps,
					newCollections,
					noteRewritePlans: Array.from(noteRewritePlanCounts.entries())
					.map(([notePath, rewriteCount]) => ({notePath, rewriteCount}))
					.sort((left, right) => right.rewriteCount - left.rewriteCount || left.notePath.localeCompare(right.notePath)),
				warnings,
				errors,
				steps,
			items: itemResults,
		};
	}

	private getBatchOperationCount(): number {
		let count = 0;
			if (splitTextList(this.batchDraft.addTags).length > 0) {
				count += 1;
			}
			if (splitTextList(this.batchDraft.removeTags).length > 0) {
				count += 1;
			}
		if (splitTextList(this.batchDraft.addCollections).length > 0) {
			count += 1;
		}
		if (this.batchDraft.moveToFolder.trim()) {
			count += 1;
		}
		if (this.batchDraft.setRating !== "") {
			count += 1;
		}
			if (this.batchDraft.convertEnabled) {
				count += 1;
			}
			if (this.batchDraft.copyWikiLinks) {
				count += 1;
			}
			return count;
		}

	private async applyBatchOperations(): Promise<void> {
		const operationCount = this.getBatchOperationCount();
		const preflight = this.buildBatchPreflight();
		this.batchOperationErrors = [];
		if (preflight.errors.length > 0) {
			this.batchOperationErrors = preflight.errors;
			new Notice("预检失败，未执行批量操作。");
			this.render();
			return;
		}
		if (operationCount === 0) {
			new Notice("请先选择至少一个批量操作。");
			return;
		}

		const addTags = splitTextList(this.batchDraft.addTags);
			const removeTags = splitTextList(this.batchDraft.removeTags);
			const addCollections = splitTextList(this.batchDraft.addCollections);
			const rating = parseRating(this.batchDraft.setRating);
			const moveToFolder = this.batchDraft.moveToFolder.trim();
			const copyWikiLinks = this.batchDraft.copyWikiLinks;
			if (this.batchDraft.convertEnabled) {
				new Notice("转换当前只完成 dry run，未执行文件改写。");
			}

				if (addTags.length === 0 && removeTags.length === 0 && addCollections.length === 0 && typeof rating !== "number" && !moveToFolder && !copyWikiLinks) {
					return;
				}

			const selectedAssetIds = Array.from(this.selectedAssetIds);
			let moveSummary = "";
			if (copyWikiLinks) {
				await navigator.clipboard.writeText(this.getSelectedAssets().map((asset) => `![[${asset.filePath}]]`).join("\n"));
				moveSummary = `已复制 ${selectedAssetIds.length} 条 Wiki 链接`;
			}
				if (addTags.length > 0 || removeTags.length > 0 || addCollections.length > 0 || typeof rating === "number") {
					try {
						const metadataLog = await this.applyBatchMetadataOperations(selectedAssetIds, addTags, removeTags, addCollections, rating, preflight);
					const metadataSummary = metadataLog ? `元数据已更新，事务日志 ${metadataLog}` : "元数据已更新";
					moveSummary = moveSummary ? `${moveSummary}；${metadataSummary}` : metadataSummary;
				} catch (error) {
					this.batchOperationErrors = [`批量元数据更新失败：${getErrorMessage(error)}`];
					new Notice("批量元数据更新失败，已保留事务日志。");
				this.render();
				return;
			}
		}

		if (moveToFolder) {
			const moveResult = await this.plugin.moveAssetsToFolder(selectedAssetIds, moveToFolder, this.batchDraft.rewriteMarkdownLinks);
			const nextMoveSummary = `移动 ${moveResult.moved} 张，改写 ${moveResult.updatedNotes} 篇笔记`;
			moveSummary = moveSummary ? `${moveSummary}；${nextMoveSummary}` : nextMoveSummary;
			if (moveResult.operationLogPath) {
				moveSummary = `${moveSummary}，事务日志 ${moveResult.operationLogPath}`;
			}
			if (moveResult.errors.length > 0) {
				this.batchOperationErrors = moveResult.errors;
				new Notice(`批量移动存在 ${moveResult.errors.length} 个错误。`);
				this.render();
				return;
			}
		}

		new Notice(moveSummary ? `已应用 ${operationCount} 项批量操作：${moveSummary}。` : `已应用 ${operationCount} 项批量操作。`);
			this.batchDraft = createEmptyBatchDraft();
			await saveBatchOperationDraft(this.plugin, this.batchDraft);
			this.batchModalOpen = false;
			this.clearSelection(false);
			this.render();
		}

		private async applyBatchMetadataOperations(
			selectedAssetIds: string[],
			addTags: string[],
			removeTags: string[],
			addCollections: string[],
			rating: ReturnType<typeof parseRating>,
			preflight: BatchPreflightResult,
	): Promise<string | null> {
		const selectedAssets = this.getSelectedAssets();
		const operationLog = await this.plugin.services.transactionLogService.create("batch-update", {
				totalAssets: selectedAssetIds.length,
				addTags,
				removeTags,
				addCollections,
				rating,
			dryRunSummary: getBatchPreflightSummary(preflight),
			items: preflight.items.map((item) => ({
				assetId: item.asset.id,
				filename: item.asset.filename,
				proposedAction: item.proposedAction,
				riskLevel: item.riskLevel,
				referenceCount: item.referenceCount,
				annotationCount: item.annotationCount,
			})),
		});

		try {
			for (const asset of selectedAssets) {
				await this.plugin.services.transactionLogService.appendRollbackStep(operationLog, {
					action: "restore-asset-metadata",
					details: {
						assetId: asset.id,
						filePath: asset.filePath,
						tags: asset.tags,
						collections: asset.collections,
						rating: asset.rating ?? null,
					},
				});
			}

			const createdCollections = await this.ensureManualCollections(addCollections, selectedAssetIds, operationLog);
				await this.plugin.services.assetRepository.updateAssets(selectedAssetIds, (asset) => ({
					...asset,
					tags: removeTextList(mergeTextList(asset.tags, addTags), removeTags),
					collections: mergeTextList(asset.collections, addCollections),
					rating: typeof rating === "number" ? rating : asset.rating,
				updatedAt: Date.now(),
			}));
			await this.plugin.services.transactionLogService.appendStep(operationLog, {
				action: "batch-update-metadata",
				details: {
						assetIds: selectedAssetIds,
						addTags,
						removeTags,
						addCollections,
						rating,
					createdCollections,
				},
			});
			await this.plugin.services.transactionLogService.commit(operationLog);
			return this.plugin.services.transactionLogService.getPath(operationLog);
		} catch (error) {
			await this.plugin.services.transactionLogService.fail(operationLog, "批量元数据更新失败。", {message: getErrorMessage(error)});
			throw error;
		}
	}

	private async ensureManualCollections(collectionNames: string[], selectedAssetIds: string[], operationLog: OperationLog): Promise<number> {
		if (collectionNames.length === 0) {
			return 0;
		}

		let created = 0;
		const existingNames = new Set(this.plugin.services.assetRepository.getCollections().map((collection) => collection.name.toLowerCase()));
		const now = Date.now();
		for (const name of collectionNames) {
			if (existingNames.has(name.toLowerCase())) {
				continue;
			}
			const collection: Collection = {
				id: createManualCollectionId(name, now + created),
				name,
				type: "manual",
				assetIds: selectedAssetIds,
				createdAt: now,
				updatedAt: now,
			};
			await this.plugin.services.assetRepository.upsertCollection(collection);
			await this.plugin.services.transactionLogService.appendStep(operationLog, {
				action: "create-manual-collection",
				details: {
					collectionId: collection.id,
					name: collection.name,
					assetCount: selectedAssetIds.length,
				},
			});
			await this.plugin.services.transactionLogService.appendRollbackStep(operationLog, {
				action: "delete-manual-collection",
				details: {
					collectionId: collection.id,
					name: collection.name,
				},
			});
			existingNames.add(name.toLowerCase());
			created += 1;
		}
		return created;
	}

	private async confirmDeleteRisk(mode: DeleteMode, assetIds?: string[]): Promise<void> {
		if (mode === "permanent" && this.permanentDeleteConfirmText !== getPermanentConfirmToken()) {
			new Notice(`请输入 ${getPermanentConfirmToken()} 后再永久删除。`);
			return;
		}

		const baseAssetIds = assetIds ?? Array.from(this.selectedAssetIds);
		const selectedAssetIds = assetIds ? baseAssetIds : this.getDeleteTargetAssetIds(baseAssetIds);
		if (selectedAssetIds.length === 0) {
			new Notice("没有可处理的图片。");
			return;
		}
		const deleteMode: BatchDeleteMode = mode;
		const result = await this.plugin.markAssetsDeleteStatus(selectedAssetIds, deleteMode);
		if (result.errors.length > 0) {
			new Notice(`删除状态变更存在 ${result.errors.length} 个错误。`);
			return;
		}
		const logSuffix = result.operationLogPath ? `，事务日志 ${result.operationLogPath}` : "";
		const includedVariantCount = Math.max(0, selectedAssetIds.length - baseAssetIds.length);
		const variantSuffix = includedVariantCount > 0 ? `，包含 ${includedVariantCount} 张变体` : "";
		const message = mode === "archive"
			? `已归档 ${result.updated} 张图片${variantSuffix}${logSuffix}。`
			: mode === "permanent"
				? `已永久删除 ${result.updated} 张图片${variantSuffix}${logSuffix}。`
				: `已移入回收站：${result.updated} 张图片${variantSuffix}${logSuffix}。`;
		new Notice(message);
		this.deleteRiskModalOpen = false;
		this.permanentDeleteConfirmText = "";
		this.deleteIncludeVariants = false;
		this.clearSelection(false);
		this.render();
	}

	private getCurrentNoteReferenceImpact(): CurrentNoteReferenceImpact {
		const note = this.plugin.getActiveMarkdownFile();
		if (!note) {
			return {
				notePath: null,
				referenceCount: 0,
				assetCount: 0,
			};
		}

		const selectedAssetIds = new Set(this.selectedAssetIds);
		const references = this.plugin.services.assetRepository.getReferencesForNote(note.path)
			.filter((reference) => selectedAssetIds.has(reference.assetId));
		return {
			notePath: note.path,
			referenceCount: references.length,
			assetCount: new Set(references.map((reference) => reference.assetId)).size,
		};
	}

	private async removeSelectedReferencesFromCurrentNote(): Promise<void> {
		const selectedAssetIds = Array.from(this.selectedAssetIds);
		if (selectedAssetIds.length === 0) {
			new Notice("没有可处理的图片。");
			return;
		}

		const result = await this.plugin.removeAssetReferencesFromCurrentNote(selectedAssetIds);
		if (result.errors.length > 0) {
			new Notice(`当前笔记引用移除失败：${result.errors.join("；")}`);
			return;
		}

		const logSuffix = result.operationLogPath ? `，事务日志 ${result.operationLogPath}` : "";
		if (result.removed === 0) {
			new Notice(`当前笔记没有所选图片引用${logSuffix}。`);
		} else {
			new Notice(`已从当前笔记移除 ${result.removed} 处图片引用${logSuffix}。`);
		}
		this.deleteRiskModalOpen = false;
		this.permanentDeleteConfirmText = "";
		this.deleteIncludeVariants = false;
		this.clearSelection(false);
		this.render();
	}

	private async restoreSelectedAssets(): Promise<void> {
		await this.restoreAssets(Array.from(this.selectedAssetIds));
	}

	private async restoreAssets(assetIds: string[]): Promise<void> {
		const result = await this.plugin.restoreTrashedAssets(assetIds);
		if (result.errors.length > 0) {
			new Notice(`恢复完成 ${result.restored} 张，失败 ${result.errors.length} 张。`);
		} else {
			new Notice(`已恢复 ${result.restored} 张图片。`);
		}
		this.clearSelection(false);
		this.render();
	}

	openAdvancedFilter(): void {
		this.openFilterDrawer();
	}

	openSmartCollectionBuilder(query: AssetQuery = this.getEffectiveQuery(), collection?: Collection): void {
		this.smartBuilderDraft = this.plugin.services.collectionService.createDraft(query, {
			id: collection?.id,
			name: collection?.name ?? buildSmartCollectionName(normalizeQuery(query)),
			description: collection?.description ?? "",
			icon: collection?.icon ?? "▧",
			color: collection?.color ?? "#6655e8",
			mode: "visual",
		});
		this.smartBuilderOpen = true;
		this.filterDrawerOpen = false;
		this.batchModalOpen = false;
		this.deleteRiskModalOpen = false;
		this.similaritySourceAssetId = null;
		this.render();
	}

	private openFilterDrawer(): void {
		this.openFilterDrawerWithQuery(this.getEffectiveQuery());
	}

	private openFilterDrawerWithQuery(query: AssetQuery): void {
		this.draftQuery = cloneQuery(query);
		this.filterDrawerOpen = true;
		this.render();
	}

	private applyDraftQuery(): void {
		const normalized = normalizeQuery(this.draftQuery);
		const validationErrors = this.getDraftValidationErrors();
		if (validationErrors.length > 0) {
			new Notice(`筛选条件有误：${validationErrors[0]}`);
			return;
		}

		this.searchText = normalized.keyword ?? "";
		this.appliedQuery = removeKeywordFromQuery(normalized);
		if (this.activeCollectionId) {
			this.appliedQuerySource = "collection";
		} else {
			this.plugin.setActiveCollection(null);
			this.appliedQuerySource = "manual";
		}
		this.filterDrawerOpen = false;
		this.gridScrollTop = 0;
		this.render();
	}

	private async saveDraftAsSmartCollection(): Promise<void> {
		const normalized = normalizeQuery(this.draftQuery);
		const validationErrors = this.getDraftValidationErrors();
		if (validationErrors.length > 0) {
			new Notice(`筛选条件有误：${validationErrors[0]}`);
			return;
		}

		if (isQueryEmpty(normalized)) {
			new Notice("请先设置筛选条件。");
			return;
		}

		new SaveSmartCollectionModal(this.app, buildSmartCollectionName(normalized), this.getDraftResultCount(), async (name) => {
			const now = Date.now();
			const collection: Collection = {
				id: `smart-${now}`,
				name,
				type: "smart",
				query: normalized as Record<string, unknown>,
				createdAt: now,
				updatedAt: now,
			};

			await this.plugin.services.assetRepository.upsertCollection(collection);
			this.searchText = normalized.keyword ?? "";
			this.appliedQuery = removeKeywordFromQuery(normalized);
			this.appliedQuerySource = "collection";
			this.filterDrawerOpen = false;
			this.gridScrollTop = 0;
			this.plugin.setActiveCollection(collection.id);
			new Notice("已保存智能集合。");
		}).open();
	}

	private async saveCurrentViewToSmartCollection(collection: Collection): Promise<void> {
		const normalized = normalizeQuery(this.getEffectiveQuery());
		const validationErrors = validateFilterQuery(normalized);
		if (validationErrors.length > 0) {
			new Notice(`当前视图条件有误：${validationErrors[0]}`);
			return;
		}

		if (isQueryEmpty(normalized)) {
			new Notice("当前视图没有筛选条件，未更新智能集合。");
			return;
		}

		const savedQuery = normalizeQuery(collection.query as AssetQuery);
		if (getQueryKey(savedQuery) === getQueryKey(normalized)) {
			new Notice("智能集合规则已是当前视图。");
			return;
		}

		await this.plugin.services.assetRepository.upsertCollection({
			...collection,
			query: normalized as Record<string, unknown>,
			updatedAt: Date.now(),
		});
		this.searchText = normalized.keyword ?? "";
		this.appliedQuery = removeKeywordFromQuery(normalized);
		this.appliedQuerySource = "collection";
		this.gridScrollTop = 0;
		new Notice("已更新智能集合规则。");
		this.render();
	}

	private applyPluginFilterSource(): void {
		if (this.navQuery && !isQueryEmpty(this.navQuery)) {
			const normalized = normalizeQuery(this.navQuery);
			this.searchText = normalized.keyword ?? "";
			this.appliedQuery = removeKeywordFromQuery(normalized);
			this.filterDrawerOpen = false;
			this.appliedQuerySource = "nav";
			return;
		}

		if (this.activeCollectionId) {
			this.applyActiveCollectionQuery();
			return;
		}

		if (this.appliedQuerySource === "nav" || this.appliedQuerySource === "collection") {
			this.searchText = "";
			this.appliedQuery = {};
			this.filterDrawerOpen = false;
			this.appliedQuerySource = "manual";
		}
	}

	private applyActiveCollectionQuery(): void {
		const collection = this.plugin.services.assetRepository.getCollectionById(this.activeCollectionId);
		if (!collection || collection.type !== "smart") {
			return;
		}

		const normalized = normalizeQuery(collection.query as AssetQuery);
		this.searchText = normalized.keyword ?? "";
		this.appliedQuery = removeKeywordFromQuery(normalized);
		this.filterDrawerOpen = false;
		this.appliedQuerySource = "collection";
	}

	private getActiveSmartCollection(): Collection | null {
		if (!this.activeCollectionId) {
			return null;
		}

		const collection = this.plugin.services.assetRepository.getCollectionById(this.activeCollectionId);
		return collection?.type === "smart" ? collection : null;
	}

	private setDraftNumberField(queryField: NumericQueryField, value: string): void {
		const nextValue = value === "" ? undefined : Number(value);
		this.draftQuery[queryField] = typeof nextValue === "number" && Number.isFinite(nextValue) ? nextValue : undefined;
		this.draftQuery = normalizeQuery(this.draftQuery);
	}

	private setDraftDateField(queryField: DateQueryField, value: string): void {
		if (!value) {
			this.draftQuery[queryField] = undefined;
			this.draftQuery = normalizeQuery(this.draftQuery);
			return;
		}

		const parsed = Date.parse(`${value}T00:00:00`);
		this.draftQuery[queryField] = Number.isNaN(parsed) ? undefined : parsed;
		this.draftQuery = normalizeQuery(this.draftQuery);
	}

	private updateDraftHitCount(hitCount: HTMLElement): void {
		const validationErrors = this.getDraftValidationErrors();
		if (validationErrors.length > 0) {
			hitCount.setText("条件有误");
			hitCount.classList.add("is-error");
		} else {
			hitCount.setText(`命中 ${this.getDraftResultCount()} 张`);
			hitCount.classList.remove("is-error");
		}
		this.updateDraftValidationState(validationErrors);
	}

	private getDraftResultCount(): number {
		return this.plugin.services.searchService.filterAssets(
			this.plugin.services.assetRepository.getAssets(),
			this.quickFilter,
			normalizeQuery(this.draftQuery),
		).length;
	}

	private getDraftValidationErrors(): string[] {
		return validateFilterQuery(this.draftQuery);
	}

	private updateDraftValidationState(validationErrors: string[]): void {
		const validationEl = this.contentEl.querySelector<HTMLElement>("[data-media-vault-filter-validation='true']");
		if (validationEl) {
			this.renderDraftValidation(validationEl, validationErrors);
		}

		const apply = this.contentEl.querySelector<HTMLButtonElement>("[data-media-vault-filter-apply='true']");
		if (apply) {
			apply.disabled = validationErrors.length > 0;
		}

		const save = this.contentEl.querySelector<HTMLButtonElement>("[data-media-vault-filter-save='true']");
		if (save) {
			save.disabled = validationErrors.length > 0 || isQueryEmpty(this.draftQuery);
		}

		const miniCount = this.contentEl.querySelector<HTMLElement>("[data-media-vault-filter-mini-count='true']");
		const miniText = this.contentEl.querySelector<HTMLElement>("[data-media-vault-filter-mini-text='true']");
		if (!miniCount || !miniText) {
			return;
		}
		if (validationErrors.length > 0) {
			miniCount.setText("—");
			miniText.setText(" 条件需要修正后才能应用筛选。");
			return;
		}

		miniCount.setText(String(this.getDraftResultCount()));
		miniText.setText(" 张图片匹配当前条件；应用后会在 toolbar 下显示可删除的筛选 chips。");
	}

	private renderDraftValidation(parent: HTMLElement, validationErrors: string[]): void {
		parent.empty();
		parent.classList.toggle("is-empty", validationErrors.length === 0);
		for (const error of validationErrors) {
			parent.createDiv({text: error});
		}
	}

	private getAppliedFilterChips(): FilterChip[] {
		const query = this.getEffectiveQuery();
		const chips: FilterChip[] = [];
		if (query.keyword) {
			chips.push({label: `关键词：${query.keyword}`, remove: () => this.removeFilterField("keyword")});
		}
		if (query.linkedByNote) {
			chips.push({label: `按笔记：${getPathBasename(query.linkedByNote)}`, remove: () => this.removeFilterField("linkedByNote")});
		}
		if (query.linkedByFolder) {
			chips.push({label: `按项目：${getPathBasename(query.linkedByFolder)}`, remove: () => this.removeFilterField("linkedByFolder")});
		}
		if (query.formats) {
			for (const format of query.formats) {
				chips.push({label: `格式：${format.toUpperCase()}`, remove: () => this.removeFormatFilter(format)});
			}
		}
		if (typeof query.referenced === "boolean") {
			chips.push({label: query.referenced ? "已引用" : "未引用", remove: () => this.removeFilterField("referenced")});
		}
		if (typeof query.hasOcr === "boolean") {
			chips.push({label: query.hasOcr ? "有 OCR" : "无 OCR", remove: () => this.removeFilterField("hasOcr")});
		}
		if (typeof query.hasAnnotation === "boolean") {
			chips.push({label: query.hasAnnotation ? "有标注" : "无标注", remove: () => this.removeFilterField("hasAnnotation")});
		}
		if (typeof query.minReferenceCount === "number") {
			chips.push({label: `引用 ≥ ${query.minReferenceCount}`, remove: () => this.removeFilterField("minReferenceCount")});
		}
		this.pushRangeChip(chips, "大小", query.minSizeKb, query.maxSizeKb, "KB", "minSizeKb", "maxSizeKb");
		this.pushRangeChip(chips, "宽度", query.minWidth, query.maxWidth, "px", "minWidth", "maxWidth");
		this.pushRangeChip(chips, "高度", query.minHeight, query.maxHeight, "px", "minHeight", "maxHeight");
		if (query.ratio) {
			chips.push({label: `方向：${getRatioLabel(query.ratio)}`, remove: () => this.removeFilterField("ratio")});
		}
		if (typeof query.ratingGte === "number") {
			chips.push({label: `评分 ≥ ${query.ratingGte} 星`, remove: () => this.removeFilterField("ratingGte")});
		}
		this.pushDateChip(chips, "创建", query.createdAfter, query.createdBefore, "createdAfter", "createdBefore");
		this.pushDateChip(chips, "修改", query.modifiedAfter, query.modifiedBefore, "modifiedAfter", "modifiedBefore");
		this.pushListChips(chips, "标签", query.tags, "tags");
		this.pushListChips(chips, "集合", query.collections, "collections");
		this.pushListChips(chips, "颜色", query.colors, "colors");
		return chips;
	}

	private pushRangeChip(chips: FilterChip[], label: string, min: number | undefined, max: number | undefined, unit: string, minField: NumericQueryField, maxField: NumericQueryField): void {
		if (typeof min !== "number" && typeof max !== "number") {
			return;
		}
		const lower = typeof min === "number" ? `${min}${unit}` : "不限";
		const upper = typeof max === "number" ? `${max}${unit}` : "不限";
		chips.push({label: `${label}：${lower} - ${upper}`, remove: () => {
			this.removeFilterField(minField);
			this.removeFilterField(maxField);
		}});
	}

	private pushDateChip(chips: FilterChip[], label: string, after: number | undefined, before: number | undefined, afterField: DateQueryField, beforeField: DateQueryField): void {
		if (typeof after !== "number" && typeof before !== "number") {
			return;
		}
		const lower = typeof after === "number" ? toDateInputValue(after) : "不限";
		const upper = typeof before === "number" ? toDateInputValue(before) : "不限";
		chips.push({label: `${label}：${lower} - ${upper}`, remove: () => {
			this.removeFilterField(afterField);
			this.removeFilterField(beforeField);
		}});
	}

	private pushListChips(chips: Array<{label: string; remove: () => void}>, label: string, values: string[] | undefined, queryField: "tags" | "collections" | "colors"): void {
		if (!values) {
			return;
		}
		for (const value of values) {
			chips.push({label: `${label}：${value}`, remove: () => this.removeListFilter(queryField, value)});
		}
	}

	private removeFilterField(queryField: keyof AssetQuery): void {
		if (queryField === "keyword") {
			this.searchText = "";
		} else {
			delete this.appliedQuery[queryField];
		}
		this.afterFilterChanged();
	}

	private removeFormatFilter(format: string): void {
		this.appliedQuery.formats = (this.appliedQuery.formats ?? []).filter((item) => item !== format);
		this.appliedQuery = normalizeQuery(this.appliedQuery);
		this.afterFilterChanged();
	}

	private removeListFilter(queryField: "tags" | "collections" | "colors", value: string): void {
		this.appliedQuery[queryField] = (this.appliedQuery[queryField] ?? []).filter((item) => item !== value);
		this.appliedQuery = normalizeQuery(this.appliedQuery);
		this.afterFilterChanged();
	}

	private afterFilterChanged(): void {
		if (this.activeCollectionId) {
			this.appliedQuerySource = "collection";
		} else {
			this.appliedQuerySource = "manual";
			this.plugin.setActiveCollection(null);
		}
		this.gridScrollTop = 0;
		this.render();
	}

	private hasAppliedFilters(): boolean {
		return !isQueryEmpty(this.getEffectiveQuery());
	}

	private renderInspector(root: Element, asset: Asset | undefined): void {
		const inspector = root.createDiv({cls: "media-vault-inspector"});
		inspector.createDiv({cls: "media-vault-section-title", text: "Inspector"});

		if (!asset) {
			inspector.createDiv({cls: "media-vault-hint", text: "选择一张图片查看元数据和引用。"});
			return;
		}

		const resourcePath = this.plugin.services.thumbnailService.getResourcePath(asset);
		if (resourcePath) {
			inspector.createEl("img", {cls: "media-vault-inspector-preview", attr: {src: resourcePath, alt: asset.filename}});
		}

		inspector.createEl("h3", {text: asset.filename});
		this.renderMetaRow(inspector, "路径", asset.filePath);
		this.renderMetaRow(inspector, "格式", asset.ext.toUpperCase());
		this.renderMetaRow(inspector, "大小", formatFileSize(asset.sizeBytes));
		this.renderMetaRow(inspector, "修改时间", formatDateTime(asset.mtime));
		this.renderMetaRow(inspector, "引用", `${asset.referenceCount} 处`);

		const actions = inspector.createDiv({cls: "media-vault-inspector-actions"});
		const insert = actions.createEl("button", {cls: "mod-cta", text: "插入当前笔记"});
		insert.addEventListener("click", () => void this.plugin.insertAsset(asset));

		const copy = actions.createEl("button", {text: "复制 wiki 链接"});
		copy.addEventListener("click", () => void this.plugin.copyAssetWikiLink(asset));

		const references = this.plugin.services.assetRepository.getReferencesForAsset(asset.id);
		inspector.createDiv({cls: "media-vault-section-title", text: "引用上下文"});
		if (references.length === 0) {
			inspector.createDiv({cls: "media-vault-hint", text: "暂无引用。"});
			return;
		}

		for (const reference of references.slice(0, 8)) {
			const item = inspector.createDiv({cls: "media-vault-reference"});
			item.createDiv({cls: "media-vault-reference-path", text: formatReferenceLocation(reference)});
			this.renderReferenceHeading(item, reference);
			item.createDiv({cls: "media-vault-reference-context", text: reference.contextPreview ?? reference.rawLink});
			item.addEventListener("click", () => {
				void this.plugin.openReference(reference.sourceNotePath, reference.lineStart);
			});
		}
	}

	private renderMetaRow(parent: Element, label: string, value: string): void {
		const row = parent.createDiv({cls: "media-vault-meta-row"});
		row.createSpan({text: label});
		row.createSpan({text: value});
	}

	private renderReferenceHeading(parent: Element, reference: AssetReference): void {
		if (!reference.heading) {
			return;
		}
		parent.createDiv({cls: "media-vault-reference-heading", text: reference.heading});
	}

	private getFilteredAssets(): Asset[] {
		this.plugin.setActiveGalleryFilter(this.getEffectiveQuery(), this.quickFilter, this.sortOption, this.viewMode);
		const assets = this.plugin.services.searchService.filterAssets(
			this.plugin.services.assetRepository.getAssets(),
			this.quickFilter,
			this.getEffectiveQuery(),
		);
		return sortAssets(assets, this.sortOption);
	}

	private getEffectiveQuery(): AssetQuery {
		return normalizeQuery({
			...cloneQuery(this.appliedQuery),
			keyword: this.searchText,
		});
	}

	private getFocusedAsset(assets: Asset[]): Asset | undefined {
		const focused = this.plugin.getFocusedAsset() ?? this.plugin.services.assetRepository.getAssetById(this.focusedAssetId);
		if (focused && assets.some((asset) => asset.id === focused.id)) {
			this.focusedAssetId = focused.id;
			return focused;
		}

		const first = assets[0];
		if (first) {
			this.focusedAssetId = first.id;
			this.plugin.setFocusedAsset(first.id);
		}
		return first;
	}
}

class AssetNoteUnsavedConfirmModal extends Modal {
	private readonly asset: Asset;
	private readonly onSaveAndContinue: () => Promise<void>;
	private readonly onDiscardAndContinue: () => void;

	constructor(app: App, asset: Asset, onSaveAndContinue: () => Promise<void>, onDiscardAndContinue: () => void) {
		super(app);
		this.asset = asset;
		this.onSaveAndContinue = onSaveAndContinue;
		this.onDiscardAndContinue = onDiscardAndContinue;
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("media-vault-confirm-modal");
		this.contentEl.createEl("h3", {text: "素材笔记未保存"});
		this.contentEl.createDiv({text: `「${this.asset.filename}」的素材笔记有未保存修改。离开前请选择保存或放弃。`});
		const actions = this.contentEl.createDiv({cls: "media-vault-detail-actions"});
		const cancel = actions.createEl("button", {text: "取消"});
		cancel.addEventListener("click", () => this.close());
		const discard = actions.createEl("button", {text: "放弃修改"});
		discard.addEventListener("click", () => {
			this.onDiscardAndContinue();
			this.close();
		});
		const save = actions.createEl("button", {cls: "mod-cta", text: "保存并继续"});
		save.addEventListener("click", () => {
			void this.onSaveAndContinue()
				.then(() => this.close())
				.catch((error) => new Notice(`素材笔记保存失败：${getErrorMessage(error)}`));
		});
	}
}

class AnnotationDeleteConfirmModal extends Modal {
	private readonly annotation: Annotation;
	private readonly onConfirm: () => Promise<void>;

	constructor(app: App, annotation: Annotation, onConfirm: () => Promise<void>) {
		super(app);
		this.annotation = annotation;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("media-vault-confirm-modal");
		this.contentEl.createEl("h3", {text: "删除区域标注"});
		this.contentEl.createDiv({text: `确认删除「${this.annotation.label}」？图片文件和引用笔记不会被删除。`});
		const actions = this.contentEl.createDiv({cls: "media-vault-detail-actions"});
		const cancel = actions.createEl("button", {text: "取消"});
		cancel.addEventListener("click", () => this.close());
		const confirm = actions.createEl("button", {cls: "mod-warning", text: "删除标注"});
		confirm.addEventListener("click", () => {
			void this.onConfirm().then(() => this.close());
		});
	}
}

class AssetRenameModal extends Modal {
	private readonly plugin: MediaVaultPlugin;
	private readonly asset: Asset;
	private readonly onDone: () => void;
	private filename: string;
	private rewriteMarkdownLinks = true;
	private previewEl: HTMLDivElement | null = null;

	constructor(app: App, plugin: MediaVaultPlugin, asset: Asset, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.asset = asset;
		this.filename = asset.filename;
		this.onDone = onDone;
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("media-vault-confirm-modal", "media-vault-rename-modal");
		this.contentEl.createEl("h3", {text: "重命名图片"});
		this.contentEl.createDiv({
			cls: "media-vault-hint",
			text: "执行前会生成 dry run：目标路径、引用影响、Markdown 链接改写和事务日志都会记录。",
		});

		const field = this.contentEl.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: "新文件名"});
		const input = field.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "text",
				value: this.filename,
				placeholder: this.asset.filename,
			},
		});
		input.value = this.filename;
		input.addEventListener("input", () => {
			this.filename = input.value;
			this.renderDryRunPreview();
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void this.confirm();
			}
		});

		const rewrite = this.contentEl.createDiv({cls: "media-vault-filter-field media-vault-batch-toggle"});
		const label = rewrite.createEl("label");
		const checkbox = label.createEl("input", {attr: {type: "checkbox"}});
		checkbox.checked = this.rewriteMarkdownLinks;
		label.appendText(" 更新 Markdown 链接");
		checkbox.addEventListener("change", () => {
			this.rewriteMarkdownLinks = checkbox.checked;
			this.renderDryRunPreview();
		});

		this.previewEl = this.contentEl.createDiv({cls: "media-vault-rename-preview"});
		this.renderDryRunPreview();

		const actions = this.contentEl.createDiv({cls: "media-vault-detail-actions"});
		const cancel = actions.createEl("button", {text: "取消"});
		cancel.addEventListener("click", () => this.close());
		const confirm = actions.createEl("button", {cls: "mod-cta", text: "确认重命名"});
		confirm.addEventListener("click", () => {
			void this.confirm();
		});

		input.focus();
		input.select();
	}

	private renderDryRunPreview(): void {
		if (!this.previewEl) {
			return;
		}
		this.previewEl.empty();
		const plan = this.buildPlan();
		this.previewEl.createDiv({cls: "media-vault-section-title", text: "dry run 预检"});
		this.renderPreviewRow("当前路径", this.asset.filePath);
		this.renderPreviewRow("目标路径", plan.targetPath || "无效文件名");
		this.renderPreviewRow("引用影响", `${plan.referenceCount} 处引用，影响 ${plan.affectedNotes} 篇笔记`);
		this.renderPreviewRow("链接改写", this.rewriteMarkdownLinks ? "执行后自动改写 Markdown 图片链接" : "不改写，引用可能保留旧文件名");
		for (const warning of plan.warnings) {
			this.previewEl.createDiv({cls: "media-vault-rename-warning", text: warning});
		}
		for (const error of plan.errors) {
			this.previewEl.createDiv({cls: "media-vault-rename-error", text: error});
		}
	}

	private renderPreviewRow(label: string, value: string): void {
		const row = this.previewEl?.createDiv({cls: "media-vault-rename-row"});
		row?.createSpan({text: label});
		row?.createSpan({text: value});
	}

	private buildPlan(): {filename: string; targetPath: string; referenceCount: number; affectedNotes: number; warnings: string[]; errors: string[]} {
		const filename = normalizeRenameModalFilename(this.filename, this.asset.ext);
		const targetPath = filename ? joinVaultPath(getParentPath(this.asset.filePath), filename) : "";
		const references = this.plugin.services.assetRepository.getReferencesForAsset(this.asset.id);
		const warnings: string[] = [];
		const errors: string[] = [];
		if (!filename) {
			errors.push("新文件名为空。");
		}
		if (filename.includes("/") || filename.includes("\\")) {
			errors.push("新文件名不能包含路径分隔符。");
		}
		if (filename && !filename.toLowerCase().endsWith(`.${this.asset.ext.toLowerCase()}`)) {
			errors.push(`请保留 .${this.asset.ext} 后缀，不在重命名中改变图片格式。`);
		}
		if (targetPath === this.asset.filePath) {
			errors.push("新文件名与当前文件名相同。");
		}
		if (!this.rewriteMarkdownLinks && references.length > 0) {
			warnings.push("未开启链接改写，重命名后现有 Markdown 图片引用可能断开。");
		}
		if (targetPath && targetPath !== this.asset.filePath && this.app.vault.getAbstractFileByPath(targetPath)) {
			warnings.push("目标文件名已存在，执行时会自动添加 -1、-2 等后缀。");
		}
		return {
			filename,
			targetPath,
			referenceCount: references.length,
			affectedNotes: new Set(references.map((reference) => reference.sourceNotePath)).size,
			warnings,
			errors,
		};
	}

	private async confirm(): Promise<void> {
		const plan = this.buildPlan();
		if (plan.errors.length > 0) {
			new Notice("重命名 dry run 失败，未执行操作。");
			this.renderDryRunPreview();
			return;
		}
		const result = await this.plugin.renameAsset(this.asset.id, plan.filename, this.rewriteMarkdownLinks);
		if (result.errors.length > 0) {
			new Notice(`重命名失败：${result.errors.join("；")}`);
			return;
		}
		const logSuffix = result.operationLogPath ? `，事务日志 ${result.operationLogPath}` : "";
		new Notice(`已重命名图片，改写 ${result.updatedNotes} 篇笔记${logSuffix}。`);
		this.onDone();
		this.close();
	}
}

class SaveSmartCollectionModal extends Modal {
	private readonly defaultName: string;
	private readonly hitCount: number;
	private readonly onConfirm: (name: string) => Promise<void>;
	private inputEl: HTMLInputElement | null = null;

	constructor(app: App, defaultName: string, hitCount: number, onConfirm: (name: string) => Promise<void>) {
		super(app);
		this.defaultName = defaultName;
		this.hitCount = hitCount;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("media-vault-confirm-modal");
		this.contentEl.createEl("h3", {text: "保存为智能集合"});
		this.contentEl.createDiv({
			cls: "media-vault-hint",
			text: `当前筛选命中 ${this.hitCount} 张图片。保存后会出现在左侧智能 Collections 中，并可再次点击应用。`,
		});

		const field = this.contentEl.createDiv({cls: "media-vault-filter-field"});
		field.createEl("label", {text: "集合名称"});
		this.inputEl = field.createEl("input", {
			cls: "media-vault-filter-input",
			attr: {
				type: "text",
				value: this.defaultName,
				placeholder: "例如 紫色大图 · 项目复盘",
			},
		});
		this.inputEl.value = this.defaultName;
		this.inputEl.focus();
		this.inputEl.select();
		this.inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void this.confirm();
			}
		});

		const actions = this.contentEl.createDiv({cls: "media-vault-detail-actions"});
		const cancel = actions.createEl("button", {text: "取消"});
		cancel.addEventListener("click", () => this.close());
		const confirm = actions.createEl("button", {cls: "mod-cta", text: "保存集合"});
		confirm.addEventListener("click", () => {
			void this.confirm();
		});
	}

	private async confirm(): Promise<void> {
		const name = this.inputEl?.value.trim() ?? "";
		if (!name) {
			new Notice("请输入智能集合名称。");
			return;
		}
		await this.onConfirm(name);
		this.close();
	}
}

function normalizeRenameModalFilename(rawFilename: string, ext: string): string {
	const trimmed = rawFilename.trim();
	if (!trimmed) {
		return "";
	}
	if (trimmed.includes(".")) {
		return trimmed;
	}
	return `${trimmed}.${ext}`;
}

function getShortestColumnIndex(columnHeights: number[]): number {
	let shortestIndex = 0;
	let shortestHeight = columnHeights[0] ?? 0;

	for (let index = 1; index < columnHeights.length; index += 1) {
		const height = columnHeights[index] ?? 0;
		if (height < shortestHeight) {
			shortestHeight = height;
			shortestIndex = index;
		}
	}

	return shortestIndex;
}

function getTightGalleryColumns(width: number, targetCardWidth: number, gap: number): {columns: number; cardWidth: number; leftInset: number} {
	const safeWidth = Math.max(1, Math.floor(width));
	const availableWidth = Math.max(1, safeWidth - GALLERY_EDGE_PADDING * 2);
	const minimumCardWidth = Math.max(96, Math.round(targetCardWidth * GALLERY_CARD_MIN_WIDTH_RATIO));
	const maximumCardWidth = Math.max(minimumCardWidth, Math.round(targetCardWidth * GALLERY_CARD_MAX_WIDTH_RATIO));
	const maximumColumns = Math.max(1, Math.floor((availableWidth + gap) / (minimumCardWidth + gap)));
	let bestColumns = 1;
	let bestCardWidth = getFilledCardWidth(availableWidth, bestColumns, gap);
	let bestScore = getFilledLayoutScore(bestCardWidth, targetCardWidth, minimumCardWidth, maximumCardWidth);

	for (let columns = 2; columns <= maximumColumns; columns += 1) {
		const cardWidth = getFilledCardWidth(availableWidth, columns, gap);
		const score = getFilledLayoutScore(cardWidth, targetCardWidth, minimumCardWidth, maximumCardWidth);
		if (score < bestScore || (score === bestScore && columns > bestColumns)) {
			bestColumns = columns;
			bestCardWidth = cardWidth;
			bestScore = score;
		}
	}

	const usedWidth = bestColumns * bestCardWidth + (bestColumns - 1) * gap;
	const leftoverWidth = Math.max(0, availableWidth - usedWidth);
	return {
		columns: bestColumns,
		cardWidth: bestCardWidth,
		leftInset: GALLERY_EDGE_PADDING + Math.floor(leftoverWidth / 2),
	};
}

function getFilledCardWidth(availableWidth: number, columns: number, gap: number): number {
	return Math.max(1, Math.floor((availableWidth - (columns - 1) * gap) / columns));
}

function getFilledLayoutScore(cardWidth: number, targetCardWidth: number, minimumCardWidth: number, maximumCardWidth: number): number {
	const tooNarrowPenalty = cardWidth < minimumCardWidth ? (minimumCardWidth - cardWidth) * 4 : 0;
	const tooWidePenalty = cardWidth > maximumCardWidth ? (cardWidth - maximumCardWidth) * 4 : 0;
	return Math.abs(cardWidth - targetCardWidth) + tooNarrowPenalty + tooWidePenalty;
}

function getPersistedAspectRatio(asset: Asset): number | null {
	if (!asset.width || !asset.height || asset.width <= 0 || asset.height <= 0) {
		return null;
	}

	return asset.width / asset.height;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function roundDetailZoom(value: number): number {
	return Math.round(value * 100) / 100;
}

function normalizeDegrees(value: number): number {
	return ((value % 360) + 360) % 360;
}

function formatAnnotationPercent(value: number): string {
	return `${Math.round(value * 1000) / 10}%`;
}

function getRelativePoint(parent: HTMLElement, event: PointerEvent): {x: number; y: number} {
	const rect = parent.getBoundingClientRect();
	const x = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
	const y = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
	return {
		x: clamp(x, 0, 1),
		y: clamp(y, 0, 1),
	};
}

function normalizeDraftRect(start: {x: number; y: number}, end: {x: number; y: number}): AnnotationRect {
	const left = Math.min(start.x, end.x);
	const top = Math.min(start.y, end.y);
	const right = Math.max(start.x, end.x);
	const bottom = Math.max(start.y, end.y);
	const width = Math.max(ANNOTATION_MIN_SIZE, right - left);
	const height = Math.max(ANNOTATION_MIN_SIZE, bottom - top);
	return {
		x: clamp(left, 0, 1 - width),
		y: clamp(top, 0, 1 - height),
		width,
		height,
	};
}

function moveAnnotationRect(initialRect: AnnotationRect, deltaX: number, deltaY: number): AnnotationRect {
	return {
		...initialRect,
		x: clamp(initialRect.x + deltaX, 0, 1 - initialRect.width),
		y: clamp(initialRect.y + deltaY, 0, 1 - initialRect.height),
	};
}

function resizeAnnotationRect(
	initialRect: AnnotationRect,
	start: {x: number; y: number},
	current: {x: number; y: number},
	handle: AnnotationResizeHandle,
): AnnotationRect {
	let left = initialRect.x;
	let top = initialRect.y;
	let right = initialRect.x + initialRect.width;
	let bottom = initialRect.y + initialRect.height;
	const deltaX = current.x - start.x;
	const deltaY = current.y - start.y;

	if (handle.includes("w")) {
		left = clamp(left + deltaX, 0, right - ANNOTATION_MIN_SIZE);
	}
	if (handle.includes("e")) {
		right = clamp(right + deltaX, left + ANNOTATION_MIN_SIZE, 1);
	}
	if (handle.includes("n")) {
		top = clamp(top + deltaY, 0, bottom - ANNOTATION_MIN_SIZE);
	}
	if (handle.includes("s")) {
		bottom = clamp(bottom + deltaY, top + ANNOTATION_MIN_SIZE, 1);
	}

	return {
		x: left,
		y: top,
		width: right - left,
		height: bottom - top,
	};
}

function setAnnotationRectStyle(element: HTMLElement, rect: AnnotationRect): void {
	element.style.left = `${rect.x * 100}%`;
	element.style.top = `${rect.y * 100}%`;
	element.style.width = `${rect.width * 100}%`;
	element.style.height = `${rect.height * 100}%`;
}

function setOcrRectStyle(element: HTMLElement, rect: OcrRect): void {
	element.style.left = `${clamp(rect.x, 0, 1) * 100}%`;
	element.style.top = `${clamp(rect.y, 0, 1) * 100}%`;
	element.style.width = `${clamp(rect.width, 0, 1) * 100}%`;
	element.style.height = `${clamp(rect.height, 0, 1) * 100}%`;
}

function formatOcrRect(rect: OcrRect): string {
	return `${formatAnnotationPercent(rect.x)} / ${formatAnnotationPercent(rect.y)} / ${formatAnnotationPercent(rect.width)} / ${formatAnnotationPercent(rect.height)}`;
}

function setAnnotationColorStyle(element: HTMLElement, color: string | undefined): void {
	element.style.setProperty("--media-vault-annotation-color", getAnnotationColor(color));
}

function findAnnotationOverlay(parent: HTMLElement, annotationId: string): HTMLElement | null {
	for (const element of Array.from(parent.querySelectorAll<HTMLElement>(".media-vault-annotation-box"))) {
		if (element.dataset.mediaVaultAnnotationId === annotationId) {
			return element;
		}
	}
	return null;
}

function cloneQuery(query: AssetQuery | undefined): AssetQuery {
	if (!query) {
		return {};
	}

	return normalizeQuery({
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
		hasOcr: query.hasOcr,
		hasAnnotation: query.hasAnnotation,
		minReferenceCount: query.minReferenceCount,
		colors: query.colors ? [...query.colors] : undefined,
		createdAfter: query.createdAfter,
		createdBefore: query.createdBefore,
		modifiedAfter: query.modifiedAfter,
		modifiedBefore: query.modifiedBefore,
	});
}

function normalizeQuery(query: AssetQuery | undefined): AssetQuery {
	const source = query ?? {};
	const normalized: AssetQuery = {};
	const keyword = normalizeText(source.keyword);
	if (keyword) {
		normalized.keyword = keyword;
		normalized.keywordMode = source.keywordMode ?? "contains";
	}
	const linkedByNote = normalizeText(source.linkedByNote);
	if (linkedByNote) {
		normalized.linkedByNote = linkedByNote;
	}
	const linkedByFolder = normalizeText(source.linkedByFolder);
	if (linkedByFolder) {
		normalized.linkedByFolder = linkedByFolder;
	}
	const formats = normalizeTextList(source.formats);
	if (formats.length > 0) {
		normalized.formats = formats;
	}
	if (source.origin && source.origin.length > 0) {
		normalized.origin = [...source.origin];
	}
	if (source.status && source.status.length > 0) {
		normalized.status = [...source.status];
	}
	copyNumber(source, normalized, "minSizeKb");
	copyNumber(source, normalized, "maxSizeKb");
	copyNumber(source, normalized, "minWidth");
	copyNumber(source, normalized, "maxWidth");
	copyNumber(source, normalized, "minHeight");
	copyNumber(source, normalized, "maxHeight");
	copyNumber(source, normalized, "minReferenceCount");
	copyNumber(source, normalized, "ratingGte");
	if (typeof normalized.ratingGte === "number") {
		const ratingGte = Math.ceil(normalized.ratingGte);
		if (ratingGte <= 0) {
			delete normalized.ratingGte;
		} else {
			normalized.ratingGte = Math.min(5, ratingGte);
		}
	}
	copyNumber(source, normalized, "createdAfter");
	copyNumber(source, normalized, "createdBefore");
	copyNumber(source, normalized, "modifiedAfter");
	copyNumber(source, normalized, "modifiedBefore");
	if (source.ratio === "landscape" || source.ratio === "portrait" || source.ratio === "square") {
		normalized.ratio = source.ratio;
	}
	const tags = normalizeTextList(source.tags);
	if (tags.length > 0) {
		normalized.tags = tags;
	}
	const collections = normalizeTextList(source.collections);
	if (collections.length > 0) {
		normalized.collections = collections;
	}
	const colors = normalizeTextList(source.colors);
	if (colors.length > 0) {
		normalized.colors = colors;
	}
	if (typeof source.referenced === "boolean") {
		normalized.referenced = source.referenced;
	}
	if (typeof source.hasOcr === "boolean") {
		normalized.hasOcr = source.hasOcr;
	}
	if (typeof source.hasAnnotation === "boolean") {
		normalized.hasAnnotation = source.hasAnnotation;
	}
	return normalized;
}

function validateFilterQuery(query: AssetQuery): string[] {
	const normalized = normalizeQuery(query);
	const errors: string[] = [];
	if (normalized.keyword && normalized.keywordMode === "regex") {
		if (normalized.keyword.length > 96) {
			errors.push("关键词正则不能超过 96 个字符。");
		} else {
			try {
				new RegExp(normalized.keyword, "i");
			} catch (error) {
				errors.push(`关键词正则无效：${getErrorMessage(error)}`);
			}
		}
	}

	validateNonNegative(errors, normalized.minSizeKb, "最小大小");
	validateNonNegative(errors, normalized.maxSizeKb, "最大大小");
	validateNonNegative(errors, normalized.minWidth, "最小宽度");
	validateNonNegative(errors, normalized.maxWidth, "最大宽度");
	validateNonNegative(errors, normalized.minHeight, "最小高度");
	validateNonNegative(errors, normalized.maxHeight, "最大高度");
	validateNonNegative(errors, normalized.minReferenceCount, "最少引用次数");
	validateRange(errors, normalized.minSizeKb, normalized.maxSizeKb, "大小");
	validateRange(errors, normalized.minWidth, normalized.maxWidth, "宽度");
	validateRange(errors, normalized.minHeight, normalized.maxHeight, "高度");
	validateRange(errors, normalized.createdAfter, normalized.createdBefore, "创建时间");
	validateRange(errors, normalized.modifiedAfter, normalized.modifiedBefore, "修改时间");
	return errors;
}

function validateNonNegative(errors: string[], value: number | undefined, label: string): void {
	if (typeof value === "number" && value < 0) {
		errors.push(`${label}不能小于 0。`);
	}
}

function validateRange(errors: string[], min: number | undefined, max: number | undefined, label: string): void {
	if (typeof min === "number" && typeof max === "number" && min > max) {
		errors.push(`${label}的最小值不能大于最大值。`);
	}
}

function removeKeywordFromQuery(query: AssetQuery): AssetQuery {
	const normalized = cloneQuery(query);
	delete normalized.keyword;
	delete normalized.keywordMode;
	return normalized;
}

function isQueryEmpty(query: AssetQuery): boolean {
	return Object.keys(normalizeQuery(query)).length === 0;
}

function getQueryKey(query: AssetQuery | null): string {
	return query ? JSON.stringify(normalizeQuery(query)) : "";
}

function parseSortOption(value: string): SortOption {
	return SORT_OPTIONS.some((option) => option.id === value) ? value as SortOption : "mtime-desc";
}

function sortAssets(assets: Asset[], sortOption: SortOption): Asset[] {
	const sorted = [...assets];
	sorted.sort((left, right) => {
		switch (sortOption) {
			case "mtime-asc":
				return left.mtime - right.mtime || compareAssetName(left, right);
			case "name-asc":
				return compareAssetName(left, right);
			case "size-desc":
				return right.sizeBytes - left.sizeBytes || compareAssetName(left, right);
			case "references-desc":
				return right.referenceCount - left.referenceCount || right.mtime - left.mtime || compareAssetName(left, right);
			case "mtime-desc":
			default:
				return right.mtime - left.mtime || compareAssetName(left, right);
		}
	});
	return sorted;
}

function compareAssetName(left: Asset, right: Asset): number {
	return left.filename.localeCompare(right.filename) || left.filePath.localeCompare(right.filePath);
}

function formatDimensions(asset: Asset): string {
	if (typeof asset.width !== "number" || typeof asset.height !== "number") {
		return "未知";
	}

	return `${asset.width} × ${asset.height}`;
}

function formatSimilarityKind(kind: SimilarityCandidate["kind"]): string {
	if (kind === "exact") {
		return "完全重复";
	}
	if (kind === "near") {
		return "近似重复";
	}
	return "视觉相似";
}

function getSimilaritySortLabel(sortOption: SimilaritySortOption): string {
	return SIMILARITY_SORT_OPTIONS.find((option) => option.id === sortOption)?.label ?? "相似度";
}

function getSmartConditionPlaceholder(field: SmartConditionField): string {
	if (field === "tag") {
		return "diagram, screenshot";
	}
	if (field === "rating") {
		return "4";
	}
	if (field === "linked") {
		return "Notes/项目复盘.md 或留空";
	}
	if (field === "used-in-folder") {
		return "Projects/2026";
	}
	if (field === "format") {
		return "png, jpg";
	}
	if (field === "width" || field === "height") {
		return "1200";
	}
	if (field === "size") {
		return "512";
	}
	if (field === "source") {
		return "library, imported";
	}
	if (field === "unused") {
		return "true";
	}
	if (field === "has-ocr" || field === "has-annotation") {
		return "true / false";
	}
	return "输入值";
}

function isSmartOperatorAvailable(field: SmartConditionField, operator: SmartConditionOperator): boolean {
	if (BOOLEAN_SMART_FIELDS.has(field)) {
		return operator === "equals" || operator === "exists";
	}
	if (field === "rating" || field === "width" || field === "height" || field === "size") {
		return operator === "gte" || operator === "lte" || operator === "equals";
	}
	if (field === "linked") {
		return operator === "contains" || operator === "exists";
	}
	return operator === "contains" || operator === "equals";
}

function getDeleteSuggestion(item: BatchPreflightItem): string {
	if (item.referenceNotes.length > 0) {
		return "建议跳过或先处理引用";
	}
	if (item.asset.notePath || item.warnings.length > 0) {
		return "建议归档或移入回收站";
	}
	return "可安全移入回收站";
}

function getBatchPreflightSummary(preflight: BatchPreflightResult): string {
	if (preflight.errors.length > 0) {
		return `${preflight.errors.length} 个错误需要先处理；不会执行任何文件移动、链接改写或元数据更新。`;
	}
	if (preflight.plannedMoves > 0) {
		const rewriteText = preflight.plannedMarkdownLinkRewrites > 0
			? `会改写 ${preflight.plannedMarkdownLinkRewrites} 处 Markdown 图片链接`
			: "不会改写 Markdown 图片链接";
		const breakText = preflight.brokenLinksIfNotRewrite > 0 ? `，可能留下 ${preflight.brokenLinksIfNotRewrite} 处断链` : "";
		return `将移动 ${preflight.plannedMoves} 张图片，${rewriteText}${breakText}。`;
	}
	if (preflight.steps.length === 1 && preflight.steps[0] === "尚未选择任何批量操作。") {
		return "尚未选择操作，仅展示当前选择范围的引用和标注影响。";
	}
	const variantText = preflight.variantCount > 0 ? `，${preflight.variantCount} 个潜在变体` : "";
	if (preflight.newCollections > 0) {
		return `将处理 ${preflight.totalAssets} 张图片，并创建 ${preflight.newCollections} 个手动 Collection；影响 ${preflight.affectedNotes} 篇笔记，${preflight.annotationCount} 个区域标注${variantText}。`;
	}
	return `将处理 ${preflight.totalAssets} 张图片；影响 ${preflight.affectedNotes} 篇笔记，${preflight.annotationCount} 个区域标注${variantText}。`;
}

function buildBatchDryRunReport(preflight: BatchPreflightResult): string {
	const lines = [
		`${PLUGIN_DISPLAY_NAME} batch dry run`,
		getBatchPreflightSummary(preflight),
		"",
		`图片：${preflight.totalAssets}`,
		`有引用：${preflight.referencedAssets}`,
		`影响笔记：${preflight.affectedNotes}`,
		`计划移动：${preflight.plannedMoves}`,
		`Markdown 改写：${preflight.plannedMarkdownLinkRewrites}`,
		`潜在断链：${preflight.brokenLinksIfNotRewrite}`,
		`回滚步骤：${preflight.plannedRollbackSteps}`,
	];
	if (preflight.steps.length > 0) {
		lines.push("", "操作步骤：", ...preflight.steps.map((step) => `- ${step}`));
	}
	const movedItems = preflight.items.filter((item) => item.targetPath && item.targetPath !== item.asset.filePath);
	if (movedItems.length > 0) {
		lines.push("", "移动路径：");
		for (const item of movedItems) {
			lines.push(`- ${item.asset.filePath} -> ${item.targetPath}`);
		}
	}
	if (preflight.noteRewritePlans.length > 0) {
		lines.push("", "Markdown 链接改写：");
		for (const plan of preflight.noteRewritePlans) {
			lines.push(`- ${plan.notePath}: ${plan.rewriteCount} 处`);
		}
	}
	if (preflight.warnings.length > 0) {
		lines.push("", "警告：", ...preflight.warnings.map((warning) => `- ${warning}`));
	}
	if (preflight.errors.length > 0) {
		lines.push("", "错误：", ...preflight.errors.map((error) => `- ${error}`));
	}

	return lines.join("\n");
}

function getMetadataOperationLabel(addTags: string[], removeTags: string[], addCollections: string[], setRating: string): string {
	const operations: string[] = [];
	if (addTags.length > 0) {
		operations.push("加标签");
	}
	if (removeTags.length > 0) {
		operations.push("移除标签");
	}
	if (addCollections.length > 0) {
		operations.push("加入集合");
	}
	if (setRating !== "") {
		operations.push("设置评分");
	}
	return operations.length > 0 ? operations.join(" + ") : "仅预检";
}

function getBatchRiskLevel(currentLevel: BatchRiskLevel, options: {
	deleteMode?: DeleteMode;
	hasReferences: boolean;
	hasAssetNote: boolean;
	hasAnnotations: boolean;
	hasVariants: boolean;
	willBreakLinks: boolean;
}): BatchRiskLevel {
	if (currentLevel === "high" || options.deleteMode === "permanent" || options.willBreakLinks || (options.deleteMode && (options.hasReferences || options.hasAssetNote || options.hasAnnotations))) {
		return "high";
	}
	if (currentLevel === "medium" || options.hasReferences || options.hasAssetNote || options.hasAnnotations || options.hasVariants) {
		return "medium";
	}
	return "low";
}

function getRiskLevelLabel(level: BatchRiskLevel): string {
	if (level === "high") {
		return "高风险";
	}
	if (level === "medium") {
		return "需确认";
	}
	return "低风险";
}

function getAvailablePreflightMovePath(app: App, targetPath: string, currentPath: string, reservedPaths: Set<string>): string {
	if (targetPath === currentPath) {
		return targetPath;
	}
	if (!reservedPaths.has(targetPath) && !app.vault.getAbstractFileByPath(targetPath)) {
		return targetPath;
	}

	const slashIndex = targetPath.lastIndexOf("/");
	const directory = slashIndex >= 0 ? targetPath.slice(0, slashIndex + 1) : "";
	const filename = slashIndex >= 0 ? targetPath.slice(slashIndex + 1) : targetPath;
	const dotIndex = filename.lastIndexOf(".");
	const basename = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
	const extension = dotIndex >= 0 ? filename.slice(dotIndex) : "";
	for (let index = 1; index < 1000; index += 1) {
		const candidate = joinVaultPath(`${directory}${basename}-${index}${extension}`);
		if (candidate === currentPath || (!reservedPaths.has(candidate) && !app.vault.getAbstractFileByPath(candidate))) {
			return candidate;
		}
	}
	return targetPath;
}

function splitTextList(value: string): string[] {
	return normalizeTextList(value.split(","));
}

function normalizeTextList(values: string[] | undefined): string[] {
	if (!values) {
		return [];
	}
	const unique = new Set<string>();
	for (const value of values) {
		const normalized = normalizeText(value);
		if (normalized) {
			unique.add(normalized);
		}
	}
	return Array.from(unique);
}

function normalizeText(value: string | undefined): string {
	return (value ?? "").trim();
}

function createManualCollectionId(name: string, seed: number): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 36) || "collection";
	return `manual-${slug}-${seed.toString(36)}`;
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

function copyNumber(source: AssetQuery, target: AssetQuery, field: NumericQueryField | DateQueryField): void {
	const value = source[field];
	if (typeof value === "number" && Number.isFinite(value)) {
		target[field] = value;
	}
}

function getRatioLabel(ratio: NonNullable<AssetQuery["ratio"]>): string {
	if (ratio === "landscape") {
		return "横图";
	}
	if (ratio === "portrait") {
		return "竖图";
	}
	return "方图";
}

function toDateInputValue(value: number): string {
	const date = new Date(value);
	const month = date.getMonth() + 1;
	const day = date.getDate();
	const monthText = month < 10 ? `0${month}` : String(month);
	const dayText = day < 10 ? `0${day}` : String(day);
	return `${date.getFullYear()}-${monthText}-${dayText}`;
}

function buildSmartCollectionName(query: AssetQuery): string {
	const parts: string[] = [];
	if (query.linkedByNote) {
		parts.push(`按笔记 ${getPathBasename(query.linkedByNote)}`);
	}
	if (query.linkedByFolder) {
		parts.push(`按项目 ${getPathBasename(query.linkedByFolder)}`);
	}
	if (query.keyword) {
		parts.push(query.keyword);
	}
	if (query.formats && query.formats.length > 0) {
		parts.push(query.formats.join("/").toUpperCase());
	}
	if (typeof query.referenced === "boolean") {
		parts.push(query.referenced ? "已引用" : "未引用");
	}
	if (typeof query.minSizeKb === "number" || typeof query.maxSizeKb === "number") {
		parts.push("大小筛选");
	}
	if (query.ratio) {
		parts.push(getRatioLabel(query.ratio));
	}
	if (typeof query.ratingGte === "number") {
		parts.push(`评分 ≥ ${query.ratingGte}`);
	}
	const firstTag = query.tags?.[0];
	if (firstTag) {
		parts.push(firstTag);
	}
	return `筛选：${parts.slice(0, 3).join(" + ") || "智能集合"}`;
}

function createEmptyBatchDraft(): BatchOperationDraft {
	return {
		assetIds: [],
		addTags: "",
		removeTags: "",
		addCollections: "",
		moveToFolder: "",
		setRating: "",
		convertEnabled: false,
		convertFormat: "webp",
		convertMaxEdge: "",
		convertQuality: "",
		copyWikiLinks: false,
		rewriteMarkdownLinks: true,
	};
}

function normalizeBatchOperationDraft(draft: Partial<BatchOperationDraft> | undefined): BatchOperationDraft {
	const base = createEmptyBatchDraft();
	if (!draft || typeof draft !== "object") {
		return base;
	}

	return {
		assetIds: Array.isArray(draft.assetIds) ? draft.assetIds.filter((assetId): assetId is string => typeof assetId === "string") : base.assetIds,
		addTags: typeof draft.addTags === "string" ? draft.addTags : base.addTags,
		removeTags: typeof draft.removeTags === "string" ? draft.removeTags : base.removeTags,
		addCollections: typeof draft.addCollections === "string" ? draft.addCollections : base.addCollections,
		moveToFolder: typeof draft.moveToFolder === "string" ? draft.moveToFolder : base.moveToFolder,
		setRating: typeof draft.setRating === "string" ? draft.setRating : base.setRating,
		convertEnabled: typeof draft.convertEnabled === "boolean" ? draft.convertEnabled : base.convertEnabled,
		convertFormat: isBatchConvertFormat(draft.convertFormat) ? draft.convertFormat : base.convertFormat,
		convertMaxEdge: typeof draft.convertMaxEdge === "string" ? draft.convertMaxEdge : base.convertMaxEdge,
		convertQuality: typeof draft.convertQuality === "string" ? draft.convertQuality : base.convertQuality,
		copyWikiLinks: typeof draft.copyWikiLinks === "boolean" ? draft.copyWikiLinks : base.copyWikiLinks,
		rewriteMarkdownLinks: typeof draft.rewriteMarkdownLinks === "boolean" ? draft.rewriteMarkdownLinks : base.rewriteMarkdownLinks,
	};
}

function isBatchConvertFormat(value: unknown): value is BatchConvertFormat {
	return value === "webp" || value === "jpg" || value === "png";
}

function isTextEntryTarget(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isAnnotationColor(value: string | undefined): boolean {
	return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());
}

function getAnnotationColor(value: string | undefined): string {
	if (!value) {
		return DEFAULT_ANNOTATION_COLOR;
	}
	const color = value.trim();
	return isAnnotationColor(color) ? color : DEFAULT_ANNOTATION_COLOR;
}

function createEmptyAnnotationDraft(storageMode: AnnotationStorageMode = "index"): AnnotationDraft {
	return {
		label: "",
		text: "",
		linkedNotePath: "",
		linkedHeading: "",
		linkedBlockId: "",
		storageMode,
		color: DEFAULT_ANNOTATION_COLOR,
		x: 0.42,
		y: 0.28,
		width: 0.24,
		height: 0.16,
	};
}

function annotationToDraft(annotation: Annotation): AnnotationDraft {
	return {
		label: annotation.label,
		text: annotation.text ?? "",
		linkedNotePath: annotation.linkedNotePath ?? "",
		linkedHeading: annotation.linkedHeading ?? "",
		linkedBlockId: annotation.linkedBlockId ?? "",
		storageMode: getAnnotationStorageMode(annotation),
		color: getAnnotationColor(annotation.color),
		x: annotation.x,
		y: annotation.y,
		width: annotation.width,
		height: annotation.height,
	};
}

function getAnnotationStorageMode(annotation: Pick<Annotation, "storageMode">): AnnotationStorageMode {
	return annotation.storageMode === "index" ? "index" : "asset-note";
}

function getAnnotationStorageLabel(storageMode: AnnotationStorageMode): string {
	return storageMode === "asset-note" ? "Asset Note" : "插件索引";
}

function getClientSelectionRect(startX: number, startY: number, currentX: number, currentY: number): ClientSelectionRect {
	return {
		left: Math.min(startX, currentX),
		top: Math.min(startY, currentY),
		right: Math.max(startX, currentX),
		bottom: Math.max(startY, currentY),
	};
}

function rectsIntersect(selectionRect: ClientSelectionRect, itemRect: DOMRect): boolean {
	return selectionRect.left <= itemRect.right
		&& selectionRect.right >= itemRect.left
		&& selectionRect.top <= itemRect.bottom
		&& selectionRect.bottom >= itemRect.top;
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

function parseRating(value: string): Asset["rating"] | undefined {
	const parsed = Number(value);
	if (parsed === 0 || parsed === 1 || parsed === 2 || parsed === 3 || parsed === 4 || parsed === 5) {
		return parsed;
	}
	return undefined;
}

function mergeTextList(currentValues: string[], nextValues: string[]): string[] {
	const merged = new Set<string>();
	for (const value of currentValues) {
		if (value.trim()) {
			merged.add(value.trim());
		}
	}
	for (const value of nextValues) {
		if (value.trim()) {
			merged.add(value.trim());
		}
	}
	return Array.from(merged);
}

function removeTextList(currentValues: string[], valuesToRemove: string[]): string[] {
	if (valuesToRemove.length === 0) {
		return currentValues;
	}
	const normalizedRemovals = new Set(valuesToRemove.map((value) => value.trim().toLowerCase()).filter(Boolean));
	return currentValues.filter((value) => !normalizedRemovals.has(value.trim().toLowerCase()));
}

function getPermanentConfirmToken(): string {
	return ["DEL", "ETE"].join("");
}

function getToolbarLayoutIcon(viewMode: GalleryViewMode): string {
	if (viewMode === "list") {
		return "list";
	}
	if (viewMode === "compact") {
		return "gallery-thumbnails";
	}
	return "layout-grid";
}

function getPathBasename(filePath: string): string {
	return filePath.split("/").pop() ?? filePath;
}
