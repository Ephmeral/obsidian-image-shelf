export type ThumbnailQualityPreset = "space" | "balanced" | "quality";

export interface ThumbnailPresetConfig {
	small: number;
	large: number;
	quality: number;
	cacheSignature: string;
}

const THUMBNAIL_PRESETS: Record<ThumbnailQualityPreset, ThumbnailPresetConfig> = {
	space: {
		small: 240,
		large: 720,
		quality: 0.72,
		cacheSignature: "space-240-720-q72",
	},
	balanced: {
		small: 360,
		large: 900,
		quality: 0.82,
		cacheSignature: "balanced-360-900-q82",
	},
	quality: {
		small: 480,
		large: 1200,
		quality: 0.9,
		cacheSignature: "quality-480-1200-q90",
	},
};

export function resolveThumbnailQualityPreset(value: unknown): ThumbnailQualityPreset {
	if (value === "space" || value === "balanced" || value === "quality") {
		return value;
	}
	return "balanced";
}

export function getThumbnailPresetConfig(preset: ThumbnailQualityPreset): ThumbnailPresetConfig {
	return THUMBNAIL_PRESETS[preset];
}
