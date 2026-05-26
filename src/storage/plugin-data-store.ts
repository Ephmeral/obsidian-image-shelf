import type {Plugin} from "obsidian";
import type {ImageGalleryIndexSnapshot} from "../types/asset";
import type {BatchOperationDraft} from "../types/batch";
import type {RecommendationDismissal} from "../services/recommendation-service";
import type {MediaVaultSettings} from "../settings/defaults";

export interface ImageGalleryPluginData {
	settings?: Partial<MediaVaultSettings>;
	index?: Partial<ImageGalleryIndexSnapshot>;
	batchOperationDraft?: Partial<BatchOperationDraft>;
	recommendationDismissals?: RecommendationDismissal[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadPluginData(plugin: Plugin): Promise<ImageGalleryPluginData> {
	const data: unknown = await plugin.loadData();
	if (!isRecord(data)) {
		return {};
	}

	return data as ImageGalleryPluginData;
}

export async function savePluginData(plugin: Plugin, data: ImageGalleryPluginData): Promise<void> {
	await plugin.saveData(data);
}

export async function loadBatchOperationDraft(plugin: Plugin): Promise<Partial<BatchOperationDraft> | undefined> {
	const data = await loadPluginData(plugin);
	return data.batchOperationDraft;
}

export async function saveBatchOperationDraft(plugin: Plugin, draft: BatchOperationDraft): Promise<void> {
	const data = await loadPluginData(plugin);
	data.batchOperationDraft = draft;
	await savePluginData(plugin, data);
}
