import {ItemView, Notice, TFile, TFolder, WorkspaceLeaf} from "obsidian";
import {MEDIA_VAULT_NAV_VIEW_TYPE, PLUGIN_DISPLAY_NAME} from "../constants";
import type MediaVaultPlugin from "../main";
import type {Asset, AssetReference} from "../types/asset";
import type {AssetQuery, QuickFilterId} from "../types/query";
import {getDuplicateAssetIds} from "../services/search-service";
import {getParentPath} from "../utils/path-utils";

const MAX_NAV_FACET_ITEMS = 10;
const TAG_DOT_COLORS = ["#6c5ce7", "#d09a11", "#d85d72", "#2f9e63", "#3182ce", "#805ad5", "#dd6b20", "#0f766e"];

type NavSectionId = "gallery" | "obsidian" | "smart" | "collections" | "projects" | "tags" | "system";

export class MediaVaultNavView extends ItemView {
	private readonly plugin: MediaVaultPlugin;
	private unsubscribeRepository: (() => void) | null = null;
	private unsubscribeUiState: (() => void) | null = null;
	private readonly collapsedSections = new Set<NavSectionId>(["tags"]);

	constructor(leaf: WorkspaceLeaf, plugin: MediaVaultPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return MEDIA_VAULT_NAV_VIEW_TYPE;
	}

	getDisplayText(): string {
		return PLUGIN_DISPLAY_NAME;
	}

	getIcon(): string {
		return "images";
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
		root.addClass("media-vault-nav-root");

		root.createDiv({cls: "media-vault-logo", text: PLUGIN_DISPLAY_NAME});

		const allAssets = this.plugin.services.assetRepository.getAssets();
		const activeAssets = allAssets.filter((asset) => asset.status === "active");
		const trashAssets = allAssets.filter((asset) => asset.status === "trash");
		const activeCollectionId = this.plugin.getActiveCollectionId();
		const activeNavQuery = this.plugin.getNavQuery();
		const hasNavQuery = activeNavQuery !== null;
		const filters: Array<{id: QuickFilterId; label: string; count: number}> = [
			{id: "all", label: "全部图片", count: activeAssets.length},
			{id: "unreferenced", label: "未引用", count: activeAssets.filter((asset) => asset.referenceCount === 0).length},
			{id: "favorites", label: "收藏", count: activeAssets.filter((asset) => asset.favorite).length},
			{id: "recent", label: "最近使用", count: activeAssets.filter(isRecentAsset).length},
			{id: "duplicates", label: "重复图片", count: getDuplicateAssetIds(activeAssets).size},
		];

		this.renderSection(root, "gallery", "Gallery", (section) => {
			for (const filter of filters) {
				const isActive = !hasNavQuery && !activeCollectionId && this.plugin.getQuickFilter() === filter.id;
				const item = section.createDiv({cls: `media-vault-sidebar-item ${isActive ? "is-active" : ""}`});
				item.createSpan({text: filter.label});
				item.createSpan({cls: "media-vault-count", text: String(filter.count)});
				item.addEventListener("click", () => {
					this.plugin.setQuickFilter(filter.id);
				});
			}
		});

		this.renderSection(root, "system", "System", (section) => {
			const trash = section.createDiv({cls: `media-vault-sidebar-item ${!hasNavQuery && this.plugin.getQuickFilter() === "trash" ? "is-active" : ""}`});
			trash.createSpan({text: "回收站"});
			trash.createSpan({cls: "media-vault-count", text: String(trashAssets.length)});
			trash.addEventListener("click", () => {
				this.plugin.setQuickFilter("trash");
			});
			section.createDiv({cls: "media-vault-hint", text: "索引、引用和缩略图缓存均可重建。"});
		});

		const smartCollections = this.plugin.services.assetRepository.getCollections()
			.filter((collection) => collection.type === "smart");
		this.renderSection(root, "smart", "Smart Collections", (section) => {
			for (const collection of smartCollections) {
					const query = collection.query as AssetQuery;
					const linkedByNote = query.linkedByNote;
					const linkedByFolder = query.linkedByFolder;
				const isUnavailable = Boolean(
					(linkedByNote && !isNotePathAvailable(this.plugin, linkedByNote))
					|| (linkedByFolder && !isFolderPathAvailable(this.plugin, linkedByFolder)),
				);
				const count = this.plugin.services.searchService.filterAssets(
					activeAssets,
					"all",
					query,
				).length;
					const item = section.createDiv({
						cls: [
							"media-vault-sidebar-item",
							activeCollectionId === collection.id ? "is-active" : "",
						isUnavailable ? "is-unavailable" : "",
					].filter(Boolean).join(" "),
				});
				const label = item.createSpan({cls: "media-vault-sidebar-text", text: collection.name});
				label.setAttr("title", getSmartCollectionTitle(collection.name, linkedByNote, linkedByFolder, isUnavailable));
				const meta = item.createSpan({cls: "media-vault-sidebar-actions"});
				if (isUnavailable) {
					meta.createSpan({cls: "media-vault-sidebar-status", text: "不可用"});
				} else {
					meta.createSpan({cls: "media-vault-count", text: String(count)});
				}
				const remove = meta.createEl("button", {cls: "media-vault-sidebar-action", text: "×"});
				remove.setAttr("aria-label", `删除智能集合 ${collection.name}`);
				remove.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					void this.deleteSmartCollection(collection.id);
				});
				if (isUnavailable) {
					item.setAttr("aria-disabled", "true");
				} else {
					item.addEventListener("click", () => {
						this.plugin.setActiveCollection(collection.id);
					});
					}
				}
			const createSmart = section.createDiv({cls: "media-vault-sidebar-item media-vault-sidebar-create"});
			createSmart.createSpan({text: "+ 新建 Smart Collection"});
			createSmart.addEventListener("click", () => {
				void this.plugin.openSmartCollectionBuilder();
			});
		});

		const manualCollections = getTopValueCounts(activeAssets, (asset) => asset.collections, MAX_NAV_FACET_ITEMS);
		if (manualCollections.length > 0) {
			this.renderSection(root, "collections", "Collections", (section) => {
				for (const collection of manualCollections) {
					const item = section.createDiv({cls: `media-vault-sidebar-item ${isSingleNavValue(activeNavQuery, "collections", collection.value) ? "is-active" : ""}`});
					const label = item.createSpan({cls: "media-vault-sidebar-label"});
					label.createSpan({cls: "media-vault-sidebar-text", text: collection.value});
					item.createSpan({cls: "media-vault-count", text: String(collection.count)});
					item.addEventListener("click", () => {
						this.plugin.setNavQuery({collections: [collection.value]});
					});
				}
			});
		}

		const noteCollections = getNoteCollectionEntries(activeAssets, this.plugin.services.assetRepository.getReferences(), MAX_NAV_FACET_ITEMS);
		if (noteCollections.length > 0) {
			this.renderSection(root, "obsidian", "Obsidian", (section) => {
				for (const collection of noteCollections) {
					const isActive = activeNavQuery?.linkedByNote === collection.notePath;
					const isUnavailable = !isNotePathAvailable(this.plugin, collection.notePath);
					const item = section.createDiv({
						cls: [
							"media-vault-sidebar-item",
							isActive ? "is-active" : "",
							isUnavailable ? "is-unavailable" : "",
						].filter(Boolean).join(" "),
					});
					const label = item.createSpan({cls: "media-vault-sidebar-label"});
					label.createSpan({cls: "media-vault-sidebar-text", text: getPathBasename(collection.notePath)});
					if (isUnavailable) {
						item.createSpan({cls: "media-vault-sidebar-status", text: "不可用"});
						item.setAttr("aria-disabled", "true");
						item.setAttr("title", `目标笔记不存在：${collection.notePath}`);
					} else {
						item.createSpan({cls: "media-vault-count", text: String(collection.assetIds.size)});
						item.setAttr("title", collection.notePath);
						item.addEventListener("click", () => {
							this.plugin.setNavQuery({linkedByNote: collection.notePath});
						});
					}
				}
			});
		}

		const folderCollections = getFolderCollectionEntries(activeAssets, this.plugin.services.assetRepository.getReferences(), MAX_NAV_FACET_ITEMS);
		if (folderCollections.length > 0) {
			this.renderSection(root, "projects", "Projects", (section) => {
				for (const collection of folderCollections) {
					const isActive = activeNavQuery?.linkedByFolder === collection.folderPath;
					const isUnavailable = !isFolderPathAvailable(this.plugin, collection.folderPath);
					const item = section.createDiv({
						cls: [
							"media-vault-sidebar-item",
							isActive ? "is-active" : "",
							isUnavailable ? "is-unavailable" : "",
						].filter(Boolean).join(" "),
					});
					const label = item.createSpan({cls: "media-vault-sidebar-label"});
					label.createSpan({cls: "media-vault-sidebar-text", text: getPathBasename(collection.folderPath)});
					if (isUnavailable) {
						item.createSpan({cls: "media-vault-sidebar-status", text: "不可用"});
						item.setAttr("aria-disabled", "true");
						item.setAttr("title", `目标目录不存在：${collection.folderPath}`);
					} else {
						item.createSpan({cls: "media-vault-count", text: String(collection.assetIds.size)});
						item.setAttr("title", collection.folderPath);
						item.addEventListener("click", () => {
							this.plugin.setNavQuery({linkedByFolder: collection.folderPath});
						});
					}
				}
			});
		}

		const tagCounts = getTopValueCounts(activeAssets, (asset) => asset.tags, MAX_NAV_FACET_ITEMS);
		if (tagCounts.length > 0) {
			this.renderSection(root, "tags", "Tags", (section) => {
				tagCounts.forEach((entry, index) => {
					const item = section.createDiv({cls: `media-vault-sidebar-item ${isSingleNavValue(activeNavQuery, "tags", entry.value) ? "is-active" : ""}`});
					const label = item.createSpan({cls: "media-vault-sidebar-label"});
					const dot = label.createSpan({cls: "media-vault-sidebar-dot"});
					dot.style.backgroundColor = TAG_DOT_COLORS[index % TAG_DOT_COLORS.length] ?? "#6c5ce7";
					label.createSpan({cls: "media-vault-sidebar-text", text: entry.value});
					item.createSpan({cls: "media-vault-count", text: String(entry.count)});
					item.addEventListener("click", () => {
						this.plugin.setNavQuery({tags: [entry.value]});
					});
				});
			});
		}
	}

	private renderSection(root: HTMLElement, id: NavSectionId, title: string, renderBody: (section: HTMLElement) => void): void {
		const collapsed = this.collapsedSections.has(id);
		const header = root.createEl("button", {cls: `media-vault-section-toggle ${collapsed ? "is-collapsed" : ""}`});
		header.setAttr("aria-expanded", String(!collapsed));
		header.createSpan({cls: "media-vault-section-chevron", text: collapsed ? "›" : "⌄"});
		header.createSpan({cls: "media-vault-section-title-text", text: title});
		header.addEventListener("click", () => {
			if (collapsed) {
				this.collapsedSections.delete(id);
			} else {
				this.collapsedSections.add(id);
			}
			this.render();
		});
		if (collapsed) {
			return;
		}

		const section = root.createDiv({cls: "media-vault-section-body"});
		renderBody(section);
	}

	private async deleteSmartCollection(collectionId: string): Promise<void> {
		const collection = this.plugin.services.assetRepository.getCollectionById(collectionId);
		if (!collection || collection.type !== "smart") {
			return;
		}

		await this.plugin.services.assetRepository.deleteCollection(collectionId);
		if (this.plugin.getActiveCollectionId() === collectionId) {
			this.plugin.setActiveCollection(null);
		}
		new Notice("已删除智能集合。");
	}
}

interface CountEntry {
	value: string;
	count: number;
}

interface NoteCollectionEntry {
	notePath: string;
	assetIds: Set<string>;
}

interface FolderCollectionEntry {
	folderPath: string;
	assetIds: Set<string>;
}

function isRecentAsset(asset: Asset): boolean {
	const thirtyDays = 30 * 24 * 60 * 60 * 1000;
	return Date.now() - asset.mtime <= thirtyDays;
}

function isNotePathAvailable(plugin: MediaVaultPlugin, notePath: string): boolean {
	return plugin.app.vault.getAbstractFileByPath(notePath) instanceof TFile;
}

function isFolderPathAvailable(plugin: MediaVaultPlugin, folderPath: string): boolean {
	return plugin.app.vault.getAbstractFileByPath(folderPath) instanceof TFolder;
}

function getSmartCollectionTitle(name: string, linkedByNote: string | undefined, linkedByFolder: string | undefined, isUnavailable: boolean): string {
	if (!isUnavailable) {
		return name;
	}
	if (linkedByNote) {
		return `${name}：目标笔记不存在 ${linkedByNote}`;
	}
	if (linkedByFolder) {
		return `${name}：目标目录不存在 ${linkedByFolder}`;
	}
	return name;
}

function getNoteCollectionEntries(assets: Asset[], references: AssetReference[], limit: number): NoteCollectionEntry[] {
	const activeAssetIds = new Set(assets.map((asset) => asset.id));
	const byNote = new Map<string, Set<string>>();
	for (const reference of references) {
		if (!activeAssetIds.has(reference.assetId)) {
			continue;
		}
		const assetIds = byNote.get(reference.sourceNotePath) ?? new Set<string>();
		assetIds.add(reference.assetId);
		byNote.set(reference.sourceNotePath, assetIds);
	}

	return Array.from(byNote.entries())
		.map(([notePath, assetIds]) => ({notePath, assetIds}))
		.sort((a, b) => b.assetIds.size - a.assetIds.size || a.notePath.localeCompare(b.notePath))
		.slice(0, limit);
}

function getFolderCollectionEntries(assets: Asset[], references: AssetReference[], limit: number): FolderCollectionEntry[] {
	const activeAssetIds = new Set(assets.map((asset) => asset.id));
	const byFolder = new Map<string, Set<string>>();
	for (const reference of references) {
		if (!activeAssetIds.has(reference.assetId)) {
			continue;
		}
		const folderPath = getParentPath(reference.sourceNotePath);
		if (!folderPath) {
			continue;
		}
		const assetIds = byFolder.get(folderPath) ?? new Set<string>();
		assetIds.add(reference.assetId);
		byFolder.set(folderPath, assetIds);
	}

	return Array.from(byFolder.entries())
		.map(([folderPath, assetIds]) => ({folderPath, assetIds}))
		.sort((a, b) => b.assetIds.size - a.assetIds.size || a.folderPath.localeCompare(b.folderPath))
		.slice(0, limit);
}

function getTopValueCounts(assets: Asset[], getValues: (asset: Asset) => string[], limit: number): CountEntry[] {
	const counts = new Map<string, CountEntry>();
	for (const asset of assets) {
		for (const rawValue of getValues(asset)) {
			const value = rawValue.trim();
			if (!value) {
				continue;
			}

			const key = value.toLowerCase();
			const existing = counts.get(key);
			if (existing) {
				existing.count += 1;
			} else {
				counts.set(key, {value, count: 1});
			}
		}
	}

	return Array.from(counts.values())
		.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
		.slice(0, limit);
}

function isSingleNavValue(query: AssetQuery | null, field: "tags" | "colors" | "formats" | "collections", value: string): boolean {
	const values = query?.[field];
	return Boolean(values && values.length === 1 && values[0]?.toLowerCase() === value.toLowerCase());
}

function getPathBasename(filePath: string): string {
	return filePath.split("/").pop() ?? filePath;
}
