import type {Plugin} from "obsidian";
import {loadPluginData, savePluginData} from "../storage/plugin-data-store";
import type {RecommendationDismissal} from "./recommendation-service";

const MAX_RECOMMENDATION_DISMISSALS = 2000;

export class RecommendationPreferenceService {
	constructor(private readonly plugin: Plugin) {
	}

	async getDismissedAssetIds(notePath: string): Promise<Set<string>> {
		const data = await loadPluginData(this.plugin);
		return new Set(normalizeDismissals(data.recommendationDismissals)
			.filter((dismissal) => dismissal.notePath === notePath)
			.map((dismissal) => dismissal.assetId));
	}

	async dismiss(notePath: string, assetId: string): Promise<void> {
		const data = await loadPluginData(this.plugin);
		const dismissals = normalizeDismissals(data.recommendationDismissals);
		const existing = dismissals.find((dismissal) => dismissal.notePath === notePath && dismissal.assetId === assetId);
		const nextDismissal: RecommendationDismissal = {
			notePath,
			assetId,
			dismissedAt: Date.now(),
			dismissCount: (existing?.dismissCount ?? 0) + 1,
		};
		data.recommendationDismissals = [nextDismissal, ...dismissals.filter((dismissal) => dismissal.notePath !== notePath || dismissal.assetId !== assetId)]
			.sort((a, b) => b.dismissedAt - a.dismissedAt)
			.slice(0, MAX_RECOMMENDATION_DISMISSALS);
		await savePluginData(this.plugin, data);
	}

	async restoreForNote(notePath: string): Promise<number> {
		const data = await loadPluginData(this.plugin);
		const dismissals = normalizeDismissals(data.recommendationDismissals);
		const remaining = dismissals.filter((dismissal) => dismissal.notePath !== notePath);
		const restored = dismissals.length - remaining.length;
		if (restored === 0) {
			return 0;
		}
		data.recommendationDismissals = remaining;
		await savePluginData(this.plugin, data);
		return restored;
	}
}

function normalizeDismissals(value: unknown): RecommendationDismissal[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map(normalizeDismissal)
		.filter((dismissal): dismissal is RecommendationDismissal => dismissal !== null);
}

function normalizeDismissal(value: unknown): RecommendationDismissal | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.notePath !== "string" || typeof record.assetId !== "string") {
		return null;
	}
	return {
		notePath: record.notePath,
		assetId: record.assetId,
		dismissedAt: typeof record.dismissedAt === "number" && Number.isFinite(record.dismissedAt) ? record.dismissedAt : 0,
		dismissCount: typeof record.dismissCount === "number" && Number.isFinite(record.dismissCount) ? Math.max(1, Math.floor(record.dismissCount)) : 1,
	};
}
