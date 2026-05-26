import type {Plugin} from "obsidian";
import {loadPluginData, savePluginData} from "../storage/plugin-data-store";
import type {MediaVaultGalleryDisplayFields} from "../types/gallery";

export interface ThumbnailSizeSettings {
	small: number;
	large: number;
}

export interface MediaVaultSettings {
	globalAssetDirectoryTemplate: string;
	assetNoteDirectory: string;
	localAttachmentDirectoryTemplate: string;
	defaultPasteBehavior: "local-attachment" | "asset-library";
	defaultImportBehavior: "asset-library" | "local-attachment";
	imageNamingTemplate: string;
	defaultDeleteBehavior: "trash";
	thumbnailSizes: ThumbnailSizeSettings;
	thumbnailCacheLimitMb: number;
	enableDominantColor: boolean;
	enableSha256: boolean;
	enablePerceptualHash: boolean;
	enableOcr: boolean;
	enableAiTagging: boolean;
	enableCloudAiUploads: boolean;
	syncAnnotationsToAssetNote: boolean;
	mobileReadOnlyMode: boolean;
	galleryDisplayFields: MediaVaultGalleryDisplayFields;
}

export const DEFAULT_GALLERY_DISPLAY_FIELDS: MediaVaultGalleryDisplayFields = {
	filename: true,
	description: false,
	extension: false,
	dimensions: true,
	size: true,
	tags: true,
	rating: true,
	references: true,
	mtime: false,
	path: false,
};

export const DEFAULT_SETTINGS: MediaVaultSettings = {
	globalAssetDirectoryTemplate: "Assets/Images/{{YYYY}}/{{MM}}/",
	assetNoteDirectory: "Assets/Asset Notes/",
	localAttachmentDirectoryTemplate: "{{noteName}}.assets/",
	defaultPasteBehavior: "local-attachment",
	defaultImportBehavior: "asset-library",
	imageNamingTemplate: "{{type}}_{{date}}_{{hash8}}_{{slug}}.{{ext}}",
	defaultDeleteBehavior: "trash",
	thumbnailSizes: {
		small: 300,
		large: 800,
	},
	thumbnailCacheLimitMb: 1024,
	enableDominantColor: true,
	enableSha256: true,
	enablePerceptualHash: false,
	enableOcr: false,
	enableAiTagging: false,
	enableCloudAiUploads: false,
	syncAnnotationsToAssetNote: false,
	mobileReadOnlyMode: true,
	galleryDisplayFields: DEFAULT_GALLERY_DISPLAY_FIELDS,
};

export function normalizeMediaVaultSettings(settings: Partial<MediaVaultSettings> | undefined): MediaVaultSettings {
	return {
		...DEFAULT_SETTINGS,
		...settings,
		thumbnailSizes: {
			...DEFAULT_SETTINGS.thumbnailSizes,
			...settings?.thumbnailSizes,
		},
		galleryDisplayFields: {
			...DEFAULT_GALLERY_DISPLAY_FIELDS,
			...settings?.galleryDisplayFields,
		},
		enableCloudAiUploads: false,
		enableOcr: false,
		enableAiTagging: Boolean(settings?.enableAiTagging),
	};
}

export async function loadMediaVaultSettings(plugin: Plugin): Promise<MediaVaultSettings> {
	const data = await loadPluginData(plugin);
	return normalizeMediaVaultSettings(data.settings);
}

export async function saveMediaVaultSettings(plugin: Plugin, settings: MediaVaultSettings): Promise<void> {
	const data = await loadPluginData(plugin);
	data.settings = normalizeMediaVaultSettings(settings);
	await savePluginData(plugin, data);
}
