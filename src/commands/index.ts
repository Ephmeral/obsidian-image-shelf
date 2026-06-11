import {Notice} from "obsidian";
import type MediaVaultPlugin from "../main";

export function registerCommands(plugin: MediaVaultPlugin): void {
	plugin.addCommand({
		id: "open-asset-library",
		name: "Open asset library",
		callback: () => {
			void plugin.activateView();
		},
	});

	plugin.addCommand({
		id: "rebuild-index",
		name: "Rebuild image index",
		callback: () => {
			plugin.confirmRebuildIndex();
		},
	});

	plugin.addCommand({
		id: "open-task-center",
		name: "Open task center",
		callback: () => {
			void plugin.openTaskCenter();
		},
	});

	plugin.addCommand({
		id: "rebuild-thumbnail-cache",
		name: "Rebuild thumbnail cache",
		callback: () => {
			void plugin.rebuildThumbnailCache(true);
		},
	});

	plugin.addCommand({
		id: "import-images",
		name: "Import images",
		callback: () => {
			void plugin.importImagesFromPicker();
		},
	});

	plugin.addCommand({
		id: "find-duplicate-images",
		name: "Find duplicate images",
		callback: () => {
			void plugin.activateView().then(() => plugin.showDuplicateAssets());
		},
	});

	plugin.addCommand({
		id: "find-similar-images",
		name: "Find similar images",
		checkCallback: (checking) => {
			const asset = plugin.getFocusedAsset();
			if (checking) {
				return Boolean(asset);
			}
			if (!asset) {
				new Notice("请先选择图片。");
				return false;
			}
			void plugin.openSimilarAssets(asset.id);
			return true;
		},
	});

	plugin.addCommand({
		id: "show-unused-images",
		name: "Show unused images",
		callback: () => {
			void plugin.activateView().then(() => plugin.showUnusedImages());
		},
	});

	plugin.addCommand({
		id: "open-advanced-filter",
		name: "Open advanced filter",
		callback: () => {
			void plugin.openAdvancedFilter();
		},
	});

	plugin.addCommand({
		id: "new-smart-collection",
		name: "New smart collection",
		callback: () => {
			void plugin.openSmartCollectionBuilder();
		},
	});

	plugin.addCommand({
		id: "compress-selected-images",
		name: "Compress selected images",
		callback: () => {
			void plugin.openCompressSelectedImagesDryRun();
		},
	});

	plugin.addCommand({
		id: "show-current-note-images",
		name: "Show current note images",
		checkCallback: (checking) => {
			const hasFile = Boolean(plugin.getActiveMarkdownFile());
			if (checking) {
				return hasFile;
			}
			if (!hasFile) {
				new Notice("当前没有打开的 Markdown 笔记。");
				return false;
			}
			void plugin.showCurrentNoteCollection();
			return true;
		},
	});

	plugin.addCommand({
		id: "show-current-folder-images",
		name: "Show current folder images",
		checkCallback: (checking) => {
			const hasFolder = Boolean(plugin.getActiveMarkdownFolderPath());
			if (checking) {
				return hasFolder;
			}
			if (!hasFolder) {
				new Notice("当前笔记没有可用目录。");
				return false;
			}
			void plugin.showCurrentFolderCollection();
			return true;
		},
	});

	plugin.addCommand({
		id: "open-asset-detail",
		name: "Open asset detail",
		callback: () => {
			void plugin.openCommandTargetAssetDetail();
		},
	});

	plugin.addCommand({
		id: "create-asset-note",
		name: "Create asset note",
		callback: () => {
			void plugin.createAssetNoteForCommandTarget();
		},
	});

	plugin.addCommand({
		id: "promote-current-image-to-asset-library",
		name: "Promote current image to asset library",
		callback: () => {
			void plugin.promoteCurrentImageToAssetLibrary();
		},
	});

	plugin.addCommand({
		id: "demote-focused-asset-to-current-note-attachment",
		name: "Demote focused asset to current note attachment",
		checkCallback: (checking) => {
			const canDemote = Boolean(plugin.getFocusedAsset() && plugin.getActiveMarkdownFile());
			if (checking) {
				return canDemote;
			}
			if (!canDemote) {
				new Notice("请先选择图片，并打开目标 Markdown 笔记。");
				return false;
			}
			void plugin.demoteFocusedAssetToCurrentNoteAttachment();
			return true;
		},
	});

	plugin.addCommand({
		id: "insert-focused-asset",
		name: "Insert focused asset",
		checkCallback: (checking) => {
			const hasAsset = Boolean(plugin.getFocusedAsset());
			if (checking) {
				return hasAsset;
			}
			if (!hasAsset) {
				new Notice("请先选择图片。");
				return false;
			}
			void plugin.insertFocusedAsset();
			return true;
		},
	});

	plugin.addCommand({
		id: "copy-focused-asset-wiki-link",
		name: "Copy focused asset wiki link",
		checkCallback: (checking) => {
			const hasAsset = Boolean(plugin.getFocusedAsset());
			if (checking) {
				return hasAsset;
			}
			if (!hasAsset) {
				new Notice("请先选择图片。");
				return false;
			}
			void plugin.copyFocusedAssetWikiLink();
			return true;
		},
	});
}
