import {App, normalizePath, TAbstractFile, TFile} from "obsidian";
import type {Asset, AssetOrigin} from "../types/asset";
import {generateAssetId} from "../utils/hash-utils";
import {getFileExtension, getFilename, isSupportedImagePath} from "../utils/path-utils";
import {mimeTypeFromExtension} from "../utils/image-utils";
import {parseAssetNoteFrontmatter, parseAssetNoteMetadata, toAssetNoteAnnotations, toAssetNoteMetadataPatch, type ParsedAssetNoteMetadata} from "../utils/asset-note-metadata";
import type {AssetRepository} from "./asset-repository";

const MAX_SHA256_FILE_BYTES = 50 * 1024 * 1024;
const MAX_DIMENSION_FILE_BYTES = 50 * 1024 * 1024;
const MAX_SVG_DIMENSION_FILE_BYTES = 2 * 1024 * 1024;
const DIMENSION_READ_TIMEOUT_MS = 5000;
const MAX_DOMINANT_COLOR_FILE_BYTES = 20 * 1024 * 1024;
const DOMINANT_COLOR_READ_TIMEOUT_MS = 5000;
const DOMINANT_COLOR_SAMPLE_SIZE = 32;
const MAX_DOMINANT_COLORS = 5;
const COLOR_QUANTIZATION_STEP = 32;
const MIN_COLOR_ALPHA = 32;

interface ImageDimensions {
	width?: number;
	height?: number;
}

interface ColorBucket {
	r: number;
	g: number;
	b: number;
	count: number;
	saturation: number;
	luminance: number;
}

export interface IndexingResult {
	totalImages: number;
	added: number;
	updated: number;
	missing: number;
}

interface AssetNoteMetadataIndex {
	byAssetId: Map<string, ParsedAssetNoteMetadata>;
	byFilePath: Map<string, ParsedAssetNoteMetadata>;
}

export class AssetIndexer {
	private readonly app: App;
	private readonly repository: AssetRepository;
	private scanInProgress = false;

	constructor(app: App, repository: AssetRepository) {
		this.app = app;
		this.repository = repository;
	}

	async scanVault(): Promise<IndexingResult> {
		if (this.scanInProgress) {
			return {
				totalImages: this.repository.getActiveAssets().length,
				added: 0,
				updated: 0,
				missing: 0,
			};
		}

		this.scanInProgress = true;
		try {
			const existingAssets = this.repository.getAssets();
			const assetsByPath = new Map(existingAssets.map((asset) => [asset.filePath, asset]));
			const nextAssets = new Map(existingAssets.map((asset) => [asset.id, asset]));
			const assetNoteMetadataIndex = this.buildAssetNoteMetadataIndex();
			const seenAssetIds = new Set<string>();
			const assetNoteAnnotations = new Map<string, ReturnType<typeof toAssetNoteAnnotations>>();
			let added = 0;
			let updated = 0;

			for (const file of this.app.vault.getFiles()) {
				if (!isSupportedImagePath(file.path)) {
					continue;
				}

				const existing = assetsByPath.get(file.path);
				const noteMetadata = this.resolveAssetNoteMetadata(file.path, existing, assetNoteMetadataIndex);
				const asset = await this.createAssetFromFile(file, existing, noteMetadata);
				seenAssetIds.add(asset.id);
				if (existing && existing.id !== asset.id) {
					nextAssets.delete(existing.id);
				}
				nextAssets.set(asset.id, asset);
				if (noteMetadata?.annotations) {
					assetNoteAnnotations.set(asset.id, toAssetNoteAnnotations(noteMetadata, asset.id, this.repository.getAnnotationsForAsset(asset.id)));
				}

				if (existing) {
					updated += 1;
				} else {
					added += 1;
				}

				if (seenAssetIds.size % 10 === 0) {
					await yieldToMainThread();
				}
			}

			let missing = 0;
			for (const asset of nextAssets.values()) {
				if (!seenAssetIds.has(asset.id) && asset.status === "active") {
					nextAssets.set(asset.id, {
						...asset,
						status: "missing",
						updatedAt: Date.now(),
					});
					missing += 1;
				}
			}

			await this.repository.replaceAssets([...nextAssets.values()]);
			await this.repository.replaceAssetNoteAnnotationsForAssets(assetNoteAnnotations);
			return {
				totalImages: seenAssetIds.size,
				added,
				updated,
				missing,
			};
		} finally {
			this.scanInProgress = false;
		}
	}

	async handleCreate(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile)) {
			return;
		}
		if (file.extension === "md") {
			await this.syncAssetNoteMetadataFromFile(file);
			return;
		}
		if (!isSupportedImagePath(file.path)) {
			return;
		}

		const existing = this.repository.getAssetByPath(file.path);
		await this.repository.upsertAsset(await this.createAssetFromFile(file, existing, this.findAssetNoteMetadataForImage(file.path, existing)));
	}

	async handleModify(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile)) {
			return;
		}
		if (file.extension === "md") {
			await this.syncAssetNoteMetadataFromFile(file);
			return;
		}
		if (!isSupportedImagePath(file.path)) {
			return;
		}

		const existing = this.repository.getAssetByPath(file.path);
		await this.repository.upsertAsset(await this.createAssetFromFile(file, existing, this.findAssetNoteMetadataForImage(file.path, existing)));
	}

	async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!(file instanceof TFile)) {
			return;
		}
		if (file.extension === "md") {
			await this.syncAssetNoteMetadataFromFile(file);
			return;
		}

		const oldAsset = this.repository.getAssetByPath(oldPath);
		if (!isSupportedImagePath(file.path)) {
			if (oldAsset) {
				await this.repository.markMissingByPath(oldPath);
			}
			return;
		}

		const existing = oldAsset ?? this.repository.getAssetByPath(file.path);
		await this.repository.upsertAsset(await this.createAssetFromFile(file, existing, this.findAssetNoteMetadataForImage(file.path, existing)));
	}

	async handleDelete(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || !isSupportedImagePath(file.path)) {
			return;
		}

		await this.repository.markMissingByPath(file.path);
	}

	private async createAssetFromFile(file: TFile, existing: Asset | undefined, noteMetadata?: ParsedAssetNoteMetadata): Promise<Asset> {
		const ext = getFileExtension(file.path);
		const now = Date.now();
		const ctime = file.stat.ctime || now;
		const sizeBytes = file.stat.size || 0;
		const mtime = file.stat.mtime || now;
		const sha256 = await this.readSha256(file, existing, sizeBytes, mtime);
		const dimensions = await this.readDimensions(file, existing, sizeBytes, mtime, ext);
		const dominantColors = noteMetadata?.dominantColors ?? (await this.readDominantColors(file, existing, sizeBytes, mtime, ext));

		return {
			id: noteMetadata?.assetId ?? existing?.id ?? generateAssetId(file.path, ctime, sizeBytes),
			filePath: file.path,
			notePath: noteMetadata?.notePath ?? existing?.notePath,
			origin: existing?.origin ?? inferOrigin(file.path),
			status: "active",
			filename: getFilename(file.path),
			ext,
			mimeType: mimeTypeFromExtension(ext),
			sizeBytes,
			width: dimensions.width,
			height: dimensions.height,
			ctime,
			mtime,
			sha256,
			perceptualHash: existing?.perceptualHash,
			dominantColors,
			tags: noteMetadata?.tags ?? existing?.tags ?? [],
			collections: noteMetadata?.collections ?? existing?.collections ?? [],
			rating: noteMetadata?.rating ?? existing?.rating,
			favorite: noteMetadata?.favorite ?? existing?.favorite ?? false,
			referenceCount: existing?.referenceCount ?? 0,
			thumbnail: existing?.thumbnail ?? {},
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
	}

	private buildAssetNoteMetadataIndex(): AssetNoteMetadataIndex {
		const index: AssetNoteMetadataIndex = {
			byAssetId: new Map(),
			byFilePath: new Map(),
		};

		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const metadata = parseAssetNoteFrontmatter(cache?.frontmatter);
			if (!metadata.isAssetNote || (!metadata.assetId && !metadata.filePath)) {
				continue;
			}
			const indexed: ParsedAssetNoteMetadata = {
				...metadata,
				notePath: file.path,
			};
			if (indexed.assetId) {
				index.byAssetId.set(indexed.assetId, indexed);
			}
			if (indexed.filePath) {
				index.byFilePath.set(normalizePath(indexed.filePath), indexed);
			}
		}

		return index;
	}

	private findAssetNoteMetadataForImage(filePath: string, existing: Asset | undefined): ParsedAssetNoteMetadata | undefined {
		return this.resolveAssetNoteMetadata(filePath, existing, this.buildAssetNoteMetadataIndex());
	}

	private resolveAssetNoteMetadata(filePath: string, existing: Asset | undefined, index: AssetNoteMetadataIndex): ParsedAssetNoteMetadata | undefined {
		return index.byFilePath.get(normalizePath(filePath)) ?? (existing ? index.byAssetId.get(existing.id) : undefined);
	}

	private async syncAssetNoteMetadataFromFile(file: TFile): Promise<void> {
		let metadata: ParsedAssetNoteMetadata;
		try {
			metadata = parseAssetNoteMetadata(await this.app.vault.read(file));
		} catch {
			return;
		}
		if (!metadata.isAssetNote) {
			return;
		}

		const asset = this.findAssetForAssetNoteMetadata(metadata);
		if (!asset) {
			return;
		}

		const metadataPatch = toAssetNoteMetadataPatch(metadata);
		await this.repository.updateAssets([asset.id], (item) => ({
			...item,
			notePath: file.path,
			...metadataPatch,
			updatedAt: Date.now(),
		}));
		if (metadata.annotations) {
			await this.repository.replaceAssetNoteAnnotations(
				asset.id,
				toAssetNoteAnnotations(metadata, asset.id, this.repository.getAnnotationsForAsset(asset.id)),
			);
		}
	}

	private findAssetForAssetNoteMetadata(metadata: ParsedAssetNoteMetadata): Asset | undefined {
		if (metadata.assetId) {
			const asset = this.repository.getAssetById(metadata.assetId);
			if (asset) {
				return asset;
			}
		}
		if (metadata.filePath) {
			return this.repository.getAssetByPath(metadata.filePath);
		}
		return undefined;
	}

	private async readSha256(file: TFile, existing: Asset | undefined, sizeBytes: number, mtime: number): Promise<string | undefined> {
		const isUnchanged = existing?.sizeBytes === sizeBytes && existing.mtime === mtime;
		if (isUnchanged && existing?.sha256) {
			return existing.sha256;
		}
		if (sizeBytes > MAX_SHA256_FILE_BYTES) {
			return isUnchanged ? existing?.sha256 : undefined;
		}
		if (!globalThis.crypto?.subtle) {
			return isUnchanged ? existing?.sha256 : undefined;
		}

		try {
			const buffer = await this.app.vault.readBinary(file);
			const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
			return toHex(digest);
		} catch {
			return isUnchanged ? existing?.sha256 : undefined;
		}
	}

	private async readDimensions(file: TFile, existing: Asset | undefined, sizeBytes: number, mtime: number, ext: string): Promise<ImageDimensions> {
		const isUnchanged = existing?.sizeBytes === sizeBytes && existing.mtime === mtime;
		if (isUnchanged && hasDimensions(existing)) {
			return {
				width: existing.width,
				height: existing.height,
			};
		}
		if (ext === "svg") {
			return this.readSvgDimensions(file, existing, isUnchanged, sizeBytes);
		}
		if (sizeBytes > MAX_DIMENSION_FILE_BYTES) {
			return isUnchanged ? getExistingDimensions(existing) : {};
		}

		const resourcePath = this.app.vault.getResourcePath(file);
		const dimensions = await readRasterDimensions(resourcePath);
		return dimensions ?? (isUnchanged ? getExistingDimensions(existing) : {});
	}

	private async readSvgDimensions(file: TFile, existing: Asset | undefined, isUnchanged: boolean, sizeBytes: number): Promise<ImageDimensions> {
		if (sizeBytes > MAX_SVG_DIMENSION_FILE_BYTES) {
			return isUnchanged ? getExistingDimensions(existing) : {};
		}

		try {
			const content = await this.app.vault.read(file);
			return parseSvgDimensions(content) ?? (isUnchanged ? getExistingDimensions(existing) : {});
		} catch {
			return isUnchanged ? getExistingDimensions(existing) : {};
		}
	}

	private async readDominantColors(file: TFile, existing: Asset | undefined, sizeBytes: number, mtime: number, ext: string): Promise<string[] | undefined> {
		const isUnchanged = existing?.sizeBytes === sizeBytes && existing.mtime === mtime;
		if (isUnchanged && hasDominantColors(existing)) {
			return [...existing.dominantColors];
		}
		if (ext === "svg" || sizeBytes > MAX_DOMINANT_COLOR_FILE_BYTES) {
			return isUnchanged ? getExistingDominantColors(existing) : undefined;
		}

		const resourcePath = this.app.vault.getResourcePath(file);
		const colors = await readRasterDominantColors(resourcePath);
		if (colors.length > 0) {
			return colors;
		}
		return isUnchanged ? getExistingDominantColors(existing) : undefined;
	}
}

function hasDimensions(asset: Asset | undefined): asset is Asset & {width: number; height: number} {
	return typeof asset?.width === "number" && asset.width > 0 && typeof asset.height === "number" && asset.height > 0;
}

function getExistingDimensions(asset: Asset | undefined): ImageDimensions {
	return hasDimensions(asset) ? {width: asset.width, height: asset.height} : {};
}

function hasDominantColors(asset: Asset | undefined): asset is Asset & {dominantColors: string[]} {
	return Array.isArray(asset?.dominantColors) && asset.dominantColors.length > 0;
}

function getExistingDominantColors(asset: Asset | undefined): string[] | undefined {
	return hasDominantColors(asset) ? [...asset.dominantColors] : undefined;
}

function readRasterDimensions(resourcePath: string): Promise<ImageDimensions | null> {
	return new Promise((resolve) => {
		const image = new Image();
		let settled = false;
		let timeout: number | null = null;
		const finish = (dimensions: ImageDimensions | null) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout !== null) {
				window.clearTimeout(timeout);
			}
			image.onload = null;
			image.onerror = null;
			resolve(dimensions);
		};
		timeout = window.setTimeout(() => finish(null), DIMENSION_READ_TIMEOUT_MS);
		image.onload = () => {
			finish(toDimensions(image.naturalWidth, image.naturalHeight));
		};
		image.onerror = () => finish(null);
		image.decoding = "async";
		image.src = resourcePath;
	});
}

function toDimensions(width: number, height: number): ImageDimensions | null {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		return null;
	}
	return {
		width: Math.round(width),
		height: Math.round(height),
	};
}

function readRasterDominantColors(resourcePath: string): Promise<string[]> {
	return new Promise((resolve) => {
		const image = new Image();
		let settled = false;
		let timeout: number | null = null;
		const finish = (colors: string[]) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout !== null) {
				window.clearTimeout(timeout);
			}
			image.onload = null;
			image.onerror = null;
			resolve(colors);
		};
		timeout = window.setTimeout(() => finish([]), DOMINANT_COLOR_READ_TIMEOUT_MS);
		image.onload = () => {
			try {
				finish(extractDominantColors(image));
			} catch {
				finish([]);
			}
		};
		image.onerror = () => finish([]);
		image.decoding = "async";
		image.src = resourcePath;
	});
}

function extractDominantColors(image: HTMLImageElement): string[] {
	const imageWidth = image.naturalWidth;
	const imageHeight = image.naturalHeight;
	if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
		return [];
	}

	const scale = Math.min(1, DOMINANT_COLOR_SAMPLE_SIZE / Math.max(imageWidth, imageHeight));
	const canvasWidth = Math.max(1, Math.round(imageWidth * scale));
	const canvasHeight = Math.max(1, Math.round(imageHeight * scale));
	const canvas = document.createElement("canvas");
	canvas.width = canvasWidth;
	canvas.height = canvasHeight;
	const context = canvas.getContext("2d");
	if (!context) {
		return [];
	}

	context.drawImage(image, 0, 0, canvasWidth, canvasHeight);
	const imageData = context.getImageData(0, 0, canvasWidth, canvasHeight);
	const buckets = new Map<string, ColorBucket>();
	for (let index = 0; index < imageData.data.length; index += 4) {
		const alpha = imageData.data[index + 3] ?? 0;
		if (alpha < MIN_COLOR_ALPHA) {
			continue;
		}
		const r = quantizeColor(imageData.data[index] ?? 0);
		const g = quantizeColor(imageData.data[index + 1] ?? 0);
		const b = quantizeColor(imageData.data[index + 2] ?? 0);
		const key = `${r},${g},${b}`;
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.count += 1;
			continue;
		}

		buckets.set(key, {
			r,
			g,
			b,
			count: 1,
			saturation: getSaturation(r, g, b),
			luminance: getLuminance(r, g, b),
		});
	}

	return Array.from(buckets.values())
		.sort((left, right) => {
			const scoreDiff = getColorScore(right) - getColorScore(left);
			return scoreDiff !== 0 ? scoreDiff : right.count - left.count;
		})
		.slice(0, MAX_DOMINANT_COLORS)
		.map((bucket) => toHexColor(bucket.r, bucket.g, bucket.b));
}

function quantizeColor(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return clampByte(Math.round(value / COLOR_QUANTIZATION_STEP) * COLOR_QUANTIZATION_STEP);
}

function getSaturation(r: number, g: number, b: number): number {
	const red = r / 255;
	const green = g / 255;
	const blue = b / 255;
	const max = Math.max(red, green, blue);
	const min = Math.min(red, green, blue);
	if (max === 0) {
		return 0;
	}
	return (max - min) / max;
}

function getLuminance(r: number, g: number, b: number): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getColorScore(bucket: ColorBucket): number {
	let neutralWeight = 1;
	if (bucket.saturation < 0.12 && bucket.luminance > 245) {
		neutralWeight = 0.12;
	} else if (bucket.saturation < 0.12) {
		neutralWeight = 0.55;
	}
	return bucket.count * (0.35 + bucket.saturation * 0.65) * neutralWeight;
}

function toHexColor(r: number, g: number, b: number): string {
	return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

function toHexByte(value: number): string {
	return clampByte(value).toString(16).padStart(2, "0");
}

function clampByte(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(255, Math.round(value)));
}

function parseSvgDimensions(content: string): ImageDimensions | null {
	const svgTag = content.match(/<svg\b[^>]*>/i)?.[0];
	if (!svgTag) {
		return null;
	}
	const width = parseSvgLength(getSvgAttribute(svgTag, "width"));
	const height = parseSvgLength(getSvgAttribute(svgTag, "height"));
	if (typeof width === "number" && typeof height === "number") {
		return toDimensions(width, height);
	}

	const viewBox = getSvgAttribute(svgTag, "viewBox");
	if (!viewBox) {
		return null;
	}
	const parts = viewBox
		.trim()
		.split(/[\s,]+/)
		.map((part) => Number(part));
	const viewBoxWidth = parts[2];
	const viewBoxHeight = parts[3];
	if (typeof viewBoxWidth !== "number" || typeof viewBoxHeight !== "number") {
		return null;
	}
	return toDimensions(viewBoxWidth, viewBoxHeight);
}

function getSvgAttribute(svgTag: string, name: string): string | null {
	const pattern = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i");
	return svgTag.match(pattern)?.[1] ?? null;
}

function parseSvgLength(value: string | null): number | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (/%$/.test(trimmed)) {
		return null;
	}
	const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)(px|pt|pc|mm|cm|in)?$/i);
	if (!match) {
		return null;
	}
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) {
		return null;
	}
	const unit = (match[2] ?? "px").toLowerCase();
	switch (unit) {
		case "in":
			return amount * 96;
		case "cm":
			return amount * 37.7952755906;
		case "mm":
			return amount * 3.7795275591;
		case "pt":
			return amount * 1.3333333333;
		case "pc":
			return amount * 16;
		case "px":
		default:
			return amount;
	}
}

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function yieldToMainThread(): Promise<void> {
	await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function inferOrigin(filePath: string): AssetOrigin {
	if (/\.assets\//i.test(filePath)) {
		return "local-note";
	}
	if (/screenshots/i.test(filePath)) {
		return "screenshot";
	}
	if (/imported/i.test(filePath)) {
		return "imported";
	}
	if (/web/i.test(filePath)) {
		return "web";
	}
	return "library";
}
