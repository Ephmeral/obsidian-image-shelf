import {App, FileSystemAdapter, normalizePath, TFile} from "obsidian";
import type {MediaVaultSettings} from "../settings/defaults";
import type {Asset, AssetThumbnailState} from "../types/asset";
import type {AssetRepository} from "./asset-repository";
import type {JobQueueService} from "./task-queue";

export type ThumbnailVariant = "small" | "large";

interface ThumbnailJob {
	asset: Asset;
	variant: ThumbnailVariant;
	key: string;
}

interface FsLike {
	existsSync(path: string): boolean;
	mkdirSync(path: string, options?: {recursive?: boolean}): void;
	writeFileSync(path: string, data: Uint8Array): void;
	rmSync(path: string, options?: {recursive?: boolean; force?: boolean}): void;
	readdirSync(path: string): string[];
	statSync(path: string): {isFile(): boolean; mtimeMs: number; size: number};
	unlinkSync(path: string): void;
}

interface PathLike {
	join(...segments: string[]): string;
	basename(path: string): string;
	dirname(path: string): string;
}

const CACHE_SUBDIR = ["cache", "thumbnails"];
const MAX_ACTIVE_JOBS = 1;
const CACHE_PRUNE_INTERVAL_MS = 60_000;
const THUMBNAIL_STATE_FLUSH_DELAY_MS = 750;
const THUMBNAIL_STATE_FLUSH_BATCH_SIZE = 16;

type WindowWithOptionalRequire = Window & typeof globalThis & {
	require?: (moduleName: string) => unknown;
};

interface ThumbnailRebuildTracker {
	jobId: string;
	total: number;
	completed: number;
}

interface GeneratedThumbnail {
	relativePath: string;
	width: number;
	height: number;
}

interface PendingThumbnailStateUpdate {
	assetId: string;
	filePath: string;
	mtime: number;
	thumbnail: AssetThumbnailState;
	width?: number;
	height?: number;
}

export class ThumbnailService {
	private readonly app: App;
	private readonly repository: AssetRepository;
	private readonly getSettings: () => MediaVaultSettings;
	private readonly pluginId: string;
	private readonly jobQueue?: JobQueueService;
	private readonly pendingKeys = new Set<string>();
	private readonly jobs: ThumbnailJob[] = [];
	private activeJobs = 0;
	private lastPrunedAt = 0;
	private rebuildTracker: ThumbnailRebuildTracker | null = null;
	private readonly resourcePathCache = new Map<string, string | null>();
	private readonly pendingThumbnailStateUpdates = new Map<string, PendingThumbnailStateUpdate>();
	private thumbnailStateFlushTimeout: number | null = null;
	private thumbnailStateFlushPromise: Promise<void> | null = null;

	constructor(app: App, repository: AssetRepository, getSettings: () => MediaVaultSettings, pluginId: string, jobQueue?: JobQueueService) {
		this.app = app;
		this.repository = repository;
		this.getSettings = getSettings;
		this.pluginId = pluginId;
		this.jobQueue = jobQueue;
	}

	getResourcePath(asset: Asset, variant: ThumbnailVariant = "small"): string | null {
		const cacheKey = `${asset.id}:${asset.mtime}:${variant}`;
		const cached = this.resourcePathCache.get(cacheKey);
		if (cached !== undefined) {
			return cached;
		}

		const result = this.resolveResourcePath(asset, variant);
		this.resourcePathCache.set(cacheKey, result);
		return result;
	}

	private resolveResourcePath(asset: Asset, variant: ThumbnailVariant): string | null {
		const cached = this.getCachedResourcePath(asset, variant);
		if (cached) {
			return cached;
		}

		this.requestThumbnail(asset, variant);
		if (variant === "large") {
			const small = this.getCachedResourcePath(asset, "small");
			if (small) {
				return small;
			}
			this.requestThumbnail(asset, "small");
		}

		return this.getOriginalResourcePath(asset);
	}

	requestThumbnail(asset: Asset, variant: ThumbnailVariant = "small"): void {
		if (!this.canUsePersistentCache()) {
			return;
		}
		const expectedPath = this.getRelativeCachePath(asset, variant);
		if (this.cacheFileExists(expectedPath)) {
			return;
		}

		const key = `${asset.id}:${asset.mtime}:${variant}`;
		if (this.pendingKeys.has(key)) {
			return;
		}

		this.pendingKeys.add(key);
		this.jobs.push({asset, variant, key});
		this.drainQueue();
	}

	async rebuildCache(assets: Asset[]): Promise<number> {
		this.jobs.length = 0;
		this.pendingKeys.clear();
		this.activeJobs = 0;
		const jobId = this.jobQueue?.startJob({
			type: "thumbnail",
			label: "重建缩略图缓存",
			total: Math.max(1, assets.length),
			priority: "normal",
			details: `准备处理 ${assets.length} 张图片。`,
		});
		this.rebuildTracker = jobId ? {jobId, total: assets.length, completed: 0} : null;
		this.clearCacheDirectory();
		this.resourcePathCache.clear();
		await this.repository.updateAssets(assets.map((asset) => asset.id), (asset) => ({
			...asset,
			thumbnail: {},
			updatedAt: Date.now(),
		}));
		for (const asset of assets) {
			this.requestThumbnail(asset, "small");
		}
		if (assets.length === 0 && jobId) {
			this.jobQueue?.completeJob(jobId, "没有需要重建缩略图的图片。");
			this.rebuildTracker = null;
		}
		return assets.length;
	}

	abortAll(): void {
		this.jobs.length = 0;
		this.pendingKeys.clear();
		if (this.thumbnailStateFlushTimeout !== null) {
			window.clearTimeout(this.thumbnailStateFlushTimeout);
			this.thumbnailStateFlushTimeout = null;
		}
		this.pendingThumbnailStateUpdates.clear();
		if (this.rebuildTracker) {
			this.jobQueue?.cancelJob(this.rebuildTracker.jobId);
			this.rebuildTracker = null;
		}
		this.resourcePathCache.clear();
	}

	private drainQueue(): void {
		while (this.activeJobs < MAX_ACTIVE_JOBS) {
			const job = this.jobs.shift();
			if (!job) {
				return;
			}

			this.activeJobs += 1;
			void this.runJob(job).finally(() => {
				this.activeJobs = Math.max(0, this.activeJobs - 1);
				this.pendingKeys.delete(job.key);
				this.drainQueue();
			});
		}
	}

	private async runJob(job: ThumbnailJob): Promise<void> {
		try {
			const generated = await this.generateThumbnail(job.asset, job.variant);
			if (!generated) {
				return;
			}

			const field = job.variant === "large" ? "thumb800" : "thumb300";
			this.queueThumbnailStateUpdate(job.asset, field, generated);
			this.pruneCacheIfNeeded();
			this.resourcePathCache.delete(`${job.asset.id}:${job.asset.mtime}:${job.variant}`);
		} catch {
			// 缩略图失败不应影响图库浏览，保留原图资源路径兜底。
		} finally {
			this.trackRebuildJob(job);
		}
	}

	private trackRebuildJob(job: ThumbnailJob): void {
		const tracker = this.rebuildTracker;
		if (!tracker || job.variant !== "small") {
			return;
		}
		tracker.completed += 1;
		this.jobQueue?.updateJob(tracker.jobId, {
			progress: tracker.completed,
			total: Math.max(1, tracker.total),
			details: `已处理 ${tracker.completed}/${tracker.total} 张图片。`,
		});
		if (tracker.completed >= tracker.total) {
			this.jobQueue?.completeJob(tracker.jobId, `已完成 ${tracker.total} 张图片缩略图重建。`);
			this.rebuildTracker = null;
		}
	}

	private queueThumbnailStateUpdate(asset: Asset, field: "thumb300" | "thumb800", generated: GeneratedThumbnail): void {
		const existing = this.pendingThumbnailStateUpdates.get(asset.id);
		const update: PendingThumbnailStateUpdate = existing ?? {
			assetId: asset.id,
			filePath: asset.filePath,
			mtime: asset.mtime,
			thumbnail: {},
		};
		update.thumbnail = {
			...update.thumbnail,
			[field]: generated.relativePath,
			updatedAt: Date.now(),
		};
		if (!asset.width && generated.width > 0) {
			update.width = generated.width;
		}
		if (!asset.height && generated.height > 0) {
			update.height = generated.height;
		}
		this.pendingThumbnailStateUpdates.set(asset.id, update);

		if (this.pendingThumbnailStateUpdates.size >= THUMBNAIL_STATE_FLUSH_BATCH_SIZE) {
			void this.flushThumbnailStateUpdates();
			return;
		}
		this.scheduleThumbnailStateFlush();
	}

	private scheduleThumbnailStateFlush(): void {
		if (this.thumbnailStateFlushTimeout !== null) {
			return;
		}
		this.thumbnailStateFlushTimeout = window.setTimeout(() => {
			this.thumbnailStateFlushTimeout = null;
			void this.flushThumbnailStateUpdates();
		}, THUMBNAIL_STATE_FLUSH_DELAY_MS);
	}

	private async flushThumbnailStateUpdates(): Promise<void> {
		if (this.thumbnailStateFlushTimeout !== null) {
			window.clearTimeout(this.thumbnailStateFlushTimeout);
			this.thumbnailStateFlushTimeout = null;
		}
		if (this.thumbnailStateFlushPromise) {
			await this.thumbnailStateFlushPromise;
			return;
		}
		const updates = [...this.pendingThumbnailStateUpdates.values()];
		if (updates.length === 0) {
			return;
		}
		this.pendingThumbnailStateUpdates.clear();
		const updatesByAssetId = new Map(updates.map((update) => [update.assetId, update]));
		this.thumbnailStateFlushPromise = this.repository.updateAssets(updates.map((update) => update.assetId), (asset) => {
			const update = updatesByAssetId.get(asset.id);
			if (!update || asset.filePath !== update.filePath || asset.mtime !== update.mtime) {
				return asset;
			}
			return {
				...asset,
				width: asset.width ?? update.width,
				height: asset.height ?? update.height,
				thumbnail: {
					...asset.thumbnail,
					...update.thumbnail,
				},
				updatedAt: Date.now(),
			};
		}, {notify: false})
			.catch(() => undefined)
			.finally(() => {
				this.thumbnailStateFlushPromise = null;
				if (this.pendingThumbnailStateUpdates.size > 0) {
					this.scheduleThumbnailStateFlush();
				}
			});
		await this.thumbnailStateFlushPromise;
	}

	private async generateThumbnail(asset: Asset, variant: ThumbnailVariant): Promise<GeneratedThumbnail | null> {
		const file = this.app.vault.getAbstractFileByPath(asset.filePath);
		if (!(file instanceof TFile)) {
			return null;
		}
		const fs = getOptionalModule<FsLike>("node:fs") ?? getOptionalModule<FsLike>("fs");
		if (!fs) {
			return null;
		}

		const canvas = document.createElement("canvas");
		const context = canvas.getContext("2d");
		if (!context) {
			return null;
		}

		const source = await this.app.vault.readBinary(file);
		const objectUrl = URL.createObjectURL(new Blob([source], {type: asset.mimeType || file.extension}));
		try {
			const image = await loadImage(objectUrl);
			const maxEdge = this.getVariantSize(variant);
			const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
			canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
			canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
			context.imageSmoothingEnabled = true;
			context.imageSmoothingQuality = "high";
			context.drawImage(image, 0, 0, canvas.width, canvas.height);

			const blob = await canvasToBlob(canvas, "image/webp", 0.82);
			if (!blob) {
				return null;
			}

			const relativePath = this.getRelativeCachePath(asset, variant);
			const absolutePath = this.toAbsoluteCachePath(relativePath);
			if (!absolutePath) {
				return null;
			}
			const path = getOptionalModule<PathLike>("node:path") ?? getOptionalModule<PathLike>("path");
			const directory = path ? path.dirname(absolutePath) : null;
			if (directory) {
				fs.mkdirSync(directory, {recursive: true});
			}
			fs.writeFileSync(absolutePath, new Uint8Array(await blob.arrayBuffer()));
			return {
				relativePath,
				width: image.naturalWidth,
				height: image.naturalHeight,
			};
		} finally {
			URL.revokeObjectURL(objectUrl);
		}
	}

	private getCachedResourcePath(asset: Asset, variant: ThumbnailVariant): string | null {
		const relativePath = variant === "large" ? asset.thumbnail.thumb800 : asset.thumbnail.thumb300;
		const expectedPath = this.getRelativeCachePath(asset, variant);
		if (relativePath === expectedPath && this.cacheFileExists(relativePath)) {
			return this.toFileResourcePath(relativePath);
		}
		if (this.cacheFileExists(expectedPath)) {
			return this.toFileResourcePath(expectedPath);
		}
		return null;
	}

	private getOriginalResourcePath(asset: Asset): string | null {
		const file = this.app.vault.getAbstractFileByPath(asset.filePath);
		if (!(file instanceof TFile)) {
			return null;
		}

		return this.app.vault.getResourcePath(file);
	}

	private getVariantSize(variant: ThumbnailVariant): number {
		const settings = this.getSettings();
		return variant === "large" ? settings.thumbnailSizes.large : settings.thumbnailSizes.small;
	}

	private getRelativeCachePath(asset: Asset, variant: ThumbnailVariant): string {
		const size = this.getVariantSize(variant);
		const cacheId = `${hashText(asset.id)}-${asset.mtime}-${size}`;
		return [...this.getCacheRelativeRootParts(), `${cacheId}.webp`].join("/");
	}

	private cacheFileExists(relativePath: string): boolean {
		const fs = getOptionalModule<FsLike>("node:fs") ?? getOptionalModule<FsLike>("fs");
		const absolutePath = this.toAbsoluteCachePath(relativePath);
		return Boolean(fs && absolutePath && fs.existsSync(absolutePath));
	}

	private toFileResourcePath(relativePath: string): string | null {
		if (!this.toAbsoluteCachePath(relativePath)) {
			return null;
		}
		return this.app.vault.adapter.getResourcePath(normalizePath(relativePath));
	}

	private toAbsoluteCachePath(relativePath: string): string | null {
		const adapter = this.app.vault.adapter;
		const path = getOptionalModule<PathLike>("node:path") ?? getOptionalModule<PathLike>("path");
		if (!(adapter instanceof FileSystemAdapter) || !path) {
			return null;
		}
		return path.join(adapter.getBasePath(), ...relativePath.split("/"));
	}

	private clearCacheDirectory(): void {
		const fs = getOptionalModule<FsLike>("node:fs") ?? getOptionalModule<FsLike>("fs");
		const path = getOptionalModule<PathLike>("node:path") ?? getOptionalModule<PathLike>("path");
		const root = this.toAbsoluteCachePath(this.getCacheRelativeRootParts().join("/"));
		if (!fs || !path || !root) {
			return;
		}
		fs.rmSync(root, {recursive: true, force: true});
		fs.mkdirSync(root, {recursive: true});
	}

	private pruneCacheIfNeeded(): void {
		const now = Date.now();
		if (now - this.lastPrunedAt < CACHE_PRUNE_INTERVAL_MS) {
			return;
		}
		this.lastPrunedAt = now;

		const fs = getOptionalModule<FsLike>("node:fs") ?? getOptionalModule<FsLike>("fs");
		const path = getOptionalModule<PathLike>("node:path") ?? getOptionalModule<PathLike>("path");
		const root = this.toAbsoluteCachePath(this.getCacheRelativeRootParts().join("/"));
		if (!fs || !path || !root || !fs.existsSync(root)) {
			return;
		}

		const limitBytes = Math.max(1, this.getSettings().thumbnailCacheLimitMb) * 1024 * 1024;
		const files = fs.readdirSync(root)
			.map((name) => {
				const absolutePath = path.join(root, name);
				const stat = fs.statSync(absolutePath);
				return stat.isFile() ? {absolutePath, mtimeMs: stat.mtimeMs, size: stat.size} : null;
			})
			.filter((item): item is {absolutePath: string; mtimeMs: number; size: number} => item !== null)
			.sort((a, b) => a.mtimeMs - b.mtimeMs);
		let total = files.reduce((sum, file) => sum + file.size, 0);
		for (const file of files) {
			if (total <= limitBytes) {
				break;
			}
			fs.unlinkSync(file.absolutePath);
			total -= file.size;
		}
	}

	private canUsePersistentCache(): boolean {
		return Boolean(this.toAbsoluteCachePath(this.getCacheRelativeRootParts().join("/")));
	}

	private getCacheRelativeRootParts(): string[] {
		return [this.app.vault.configDir, "plugins", this.pluginId, ...CACHE_SUBDIR];
	}
}

function getOptionalModule<T>(moduleName: string): T | null {
	try {
		const request = (window as WindowWithOptionalRequire).require;
		if (typeof request !== "function") {
			return null;
		}
		return request(moduleName) as T;
	} catch {
		return null;
	}
}

async function loadImage(src: string): Promise<HTMLImageElement> {
	const image = new Image();
	image.decoding = "async";
	image.src = src;
	try {
		await image.decode();
		return image;
	} catch {
		return new Promise((resolve, reject) => {
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error("Failed to decode image."));
		});
	}
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => {
		canvas.toBlob((blob) => resolve(blob), type, quality);
	});
}

function hashText(text: string): string {
	let hash = 5381;
	for (let index = 0; index < text.length; index += 1) {
		hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
	}
	return (hash >>> 0).toString(36);
}
