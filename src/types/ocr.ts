export type OcrProvider = "local" | "system" | "cloud";

export interface OcrRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface OcrBlock {
	text: string;
	confidence: number;
	rect: OcrRect;
}

export interface OcrResult {
	assetId: string;
	text: string;
	blocks: OcrBlock[];
	language?: string;
	provider: OcrProvider;
	createdAt: number;
	updatedAt?: number;
}
