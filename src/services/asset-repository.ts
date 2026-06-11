import type {Plugin} from "obsidian";
import {INDEX_SCHEMA_VERSION} from "../constants";
import {createEmptyIndexSnapshot, type Annotation, type Asset, type AssetReference, type Collection, type ImageGalleryIndexSnapshot} from "../types/asset";
import {loadPluginData, savePluginData} from "../storage/plugin-data-store";

type RepositoryListener = () => void;

interface RepositoryWriteOptions {
	notify?: boolean;
}

function normalizeSnapshot(snapshot: Partial<ImageGalleryIndexSnapshot> | undefined): ImageGalleryIndexSnapshot {
	if (!snapshot) {
		return createEmptyIndexSnapshot();
	}

	return {
		schemaVersion: INDEX_SCHEMA_VERSION,
		assets: Array.isArray(snapshot.assets) ? snapshot.assets : [],
			references: Array.isArray(snapshot.references) ? snapshot.references : [],
			collections: Array.isArray(snapshot.collections) ? snapshot.collections : [],
			annotations: Array.isArray(snapshot.annotations) ? snapshot.annotations : [],
			updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : Date.now(),
		};
	}

export class AssetRepository {
	private readonly plugin: Plugin;
	private readonly assets = new Map<string, Asset>();
	private references: AssetReference[] = [];
	private collections: Collection[] = [];
	private annotations: Annotation[] = [];
	private readonly listeners = new Set<RepositoryListener>();

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	async loadSnapshot(): Promise<void> {
		const data = await loadPluginData(this.plugin);
		this.applySnapshot(normalizeSnapshot(data.index));
	}

	getSnapshot(): ImageGalleryIndexSnapshot {
		return {
			schemaVersion: INDEX_SCHEMA_VERSION,
			assets: this.getAssets(),
				references: [...this.references],
				collections: [...this.collections],
				annotations: [...this.annotations],
				updatedAt: Date.now(),
			};
	}

	getAssets(): Asset[] {
		return [...this.assets.values()].sort((a, b) => b.mtime - a.mtime);
	}

	getActiveAssets(): Asset[] {
		return this.getAssets().filter((asset) => asset.status === "active");
	}

	getAssetById(assetId: string | null | undefined): Asset | undefined {
		if (!assetId) {
			return undefined;
		}
		return this.assets.get(assetId);
	}

	getAssetByPath(filePath: string): Asset | undefined {
		return this.getAssets().find((asset) => asset.filePath === filePath);
	}

	getReferencesForAsset(assetId: string): AssetReference[] {
		return this.references.filter((reference) => reference.assetId === assetId);
	}

	getReferences(): AssetReference[] {
		return [...this.references];
	}

	getReferencesForNote(notePath: string): AssetReference[] {
		return this.references.filter((reference) => reference.sourceNotePath === notePath);
	}

	getAnnotationsForAsset(assetId: string): Annotation[] {
		return this.annotations
			.filter((annotation) => annotation.assetId === assetId)
			.sort((a, b) => a.label.localeCompare(b.label));
	}

	getAnnotations(): Annotation[] {
		return [...this.annotations];
	}

	getCollections(): Collection[] {
		return [...this.collections].sort((a, b) => a.name.localeCompare(b.name));
	}

	getCollectionById(collectionId: string | null | undefined): Collection | undefined {
		if (!collectionId) {
			return undefined;
		}
		return this.collections.find((collection) => collection.id === collectionId);
	}

	subscribe(listener: RepositoryListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async replaceAssets(assets: Asset[]): Promise<void> {
		this.assets.clear();
		for (const asset of assets) {
			this.assets.set(asset.id, asset);
		}
		await this.persistAndNotify();
	}

	async upsertAsset(asset: Asset): Promise<void> {
		this.assets.set(asset.id, asset);
		await this.persistAndNotify();
	}

	async updateAssets(assetIds: string[], updater: (asset: Asset) => Asset, options: RepositoryWriteOptions = {}): Promise<void> {
		let changed = false;
		for (const assetId of assetIds) {
			const asset = this.assets.get(assetId);
			if (!asset) {
				continue;
			}
			this.assets.set(assetId, updater(asset));
			changed = true;
		}
		if (changed) {
			await this.persistAndNotify(options);
		}
	}

	async markMissingByPath(filePath: string): Promise<void> {
		const asset = this.getAssetByPath(filePath);
		if (!asset) {
			return;
		}
		if (asset.status !== "active") {
			return;
		}

		this.assets.set(asset.id, {
			...asset,
			status: "missing",
			updatedAt: Date.now(),
		});
		await this.persistAndNotify();
	}

	async replaceReferences(references: AssetReference[]): Promise<void> {
		this.references = references;
		const counts = new Map<string, number>();
		for (const reference of references) {
			counts.set(reference.assetId, (counts.get(reference.assetId) ?? 0) + 1);
		}

		for (const asset of this.assets.values()) {
			this.assets.set(asset.id, {
				...asset,
				referenceCount: counts.get(asset.id) ?? 0,
				updatedAt: Date.now(),
			});
		}

		await this.persistAndNotify();
	}

	async migrateNotePath(oldPath: string, newPath: string): Promise<boolean> {
		if (oldPath === newPath) {
			return false;
		}

		let changed = false;
		const now = Date.now();
		this.references = this.references.map((reference) => {
			if (reference.sourceNotePath !== oldPath) {
				return reference;
			}

			changed = true;
			return {
				...reference,
				sourceNotePath: newPath,
			};
		});

		for (const [assetId, asset] of this.assets.entries()) {
			if (asset.notePath !== oldPath) {
				continue;
			}

			changed = true;
			this.assets.set(assetId, {
				...asset,
				notePath: newPath,
				updatedAt: now,
			});
		}

		this.collections = this.collections.map((collection) => {
			if (collection.type !== "smart" || !collection.query || Array.isArray(collection.query)) {
				return collection;
			}

			if (collection.query.linkedByNote !== oldPath) {
				return collection;
			}

			changed = true;
			return {
				...collection,
				query: {
					...collection.query,
					linkedByNote: newPath,
				},
				updatedAt: now,
			};
		});

		this.annotations = this.annotations.map((annotation) => {
			if (annotation.linkedNotePath !== oldPath) {
				return annotation;
			}

			changed = true;
			return {
				...annotation,
				linkedNotePath: newPath,
				updatedAt: now,
			};
		});

		if (!changed) {
			return false;
		}

		await this.persistAndNotify();
		return true;
	}

	async migrateFolderPath(oldPath: string, newPath: string): Promise<boolean> {
		const oldPrefix = normalizeFolderPrefix(oldPath);
		const newPrefix = normalizeFolderPrefix(newPath);
		if (!oldPrefix || oldPrefix === newPrefix) {
			return false;
		}

		let changed = false;
		const now = Date.now();
		this.references = this.references.map((reference) => {
			const nextPath = replacePathPrefix(reference.sourceNotePath, oldPrefix, newPrefix);
			if (!nextPath) {
				return reference;
			}

			changed = true;
			return {
				...reference,
				sourceNotePath: nextPath,
			};
		});

		for (const [assetId, asset] of this.assets.entries()) {
			if (!asset.notePath) {
				continue;
			}
			const nextNotePath = replacePathPrefix(asset.notePath, oldPrefix, newPrefix);
			if (!nextNotePath) {
				continue;
			}

			changed = true;
			this.assets.set(assetId, {
				...asset,
				notePath: nextNotePath,
				updatedAt: now,
			});
		}

		this.collections = this.collections.map((collection) => {
			if (collection.type !== "smart" || !collection.query || Array.isArray(collection.query)) {
				return collection;
			}

			const nextQuery = {...collection.query};
			let collectionChanged = false;
			if (typeof nextQuery.linkedByFolder === "string") {
				const nextFolder = replacePathPrefix(nextQuery.linkedByFolder, oldPrefix, newPrefix);
				if (nextFolder) {
					nextQuery.linkedByFolder = nextFolder;
					collectionChanged = true;
				}
			}
			if (typeof nextQuery.linkedByNote === "string") {
				const nextNote = replacePathPrefix(nextQuery.linkedByNote, oldPrefix, newPrefix);
				if (nextNote) {
					nextQuery.linkedByNote = nextNote;
					collectionChanged = true;
				}
			}
			if (!collectionChanged) {
				return collection;
			}

			changed = true;
			return {
				...collection,
				query: nextQuery,
				updatedAt: now,
			};
		});

		this.annotations = this.annotations.map((annotation) => {
			if (!annotation.linkedNotePath) {
				return annotation;
			}
			const nextPath = replacePathPrefix(annotation.linkedNotePath, oldPrefix, newPrefix);
			if (!nextPath) {
				return annotation;
			}

			changed = true;
			return {
				...annotation,
				linkedNotePath: nextPath,
				updatedAt: now,
			};
		});

		if (!changed) {
			return false;
		}

		await this.persistAndNotify();
		return true;
	}

	async upsertCollection(collection: Collection): Promise<void> {
		const nextCollections = this.collections.filter((item) => item.id !== collection.id);
		nextCollections.push(collection);
		this.collections = nextCollections;
		await this.persistAndNotify();
	}

	async deleteCollection(collectionId: string): Promise<void> {
		const nextCollections = this.collections.filter((item) => item.id !== collectionId);
		if (nextCollections.length === this.collections.length) {
			return;
		}
		this.collections = nextCollections;
		await this.persistAndNotify();
	}

	async upsertAnnotation(annotation: Annotation): Promise<void> {
		const nextAnnotations = this.annotations.filter((item) => item.id !== annotation.id);
		nextAnnotations.push(annotation);
		this.annotations = nextAnnotations;
		await this.persistAndNotify();
	}

	async replaceAssetNoteAnnotations(assetId: string, annotations: Annotation[]): Promise<void> {
		await this.replaceAssetNoteAnnotationsForAssets(new Map([[assetId, annotations]]));
	}

	async replaceAssetNoteAnnotationsForAssets(assetAnnotations: Map<string, Annotation[]>): Promise<void> {
		if (assetAnnotations.size === 0) {
			return;
		}
		const affectedAssetIds = new Set(assetAnnotations.keys());
		this.annotations = this.annotations.filter((annotation) => {
			if (!affectedAssetIds.has(annotation.assetId)) {
				return true;
			}
			return annotation.storageMode === "index";
		});
		for (const annotations of assetAnnotations.values()) {
			this.annotations.push(...annotations);
		}
		await this.persistAndNotify();
	}

	async deleteAnnotation(annotationId: string): Promise<void> {
		const nextAnnotations = this.annotations.filter((item) => item.id !== annotationId);
		if (nextAnnotations.length === this.annotations.length) {
			return;
		}
		this.annotations = nextAnnotations;
		await this.persistAndNotify();
	}

	private applySnapshot(snapshot: ImageGalleryIndexSnapshot): void {
		this.assets.clear();
		for (const asset of snapshot.assets) {
			this.assets.set(asset.id, asset);
		}
		this.references = snapshot.references;
		this.collections = snapshot.collections;
		this.annotations = snapshot.annotations;
		this.notify();
	}

	private async persistAndNotify(options: RepositoryWriteOptions = {}): Promise<void> {
		const data = await loadPluginData(this.plugin);
		data.index = this.getSnapshot();
		await savePluginData(this.plugin, data);
		if (options.notify !== false) {
			this.notify();
		}
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

function normalizeFolderPrefix(folderPath: string): string {
	return folderPath.trim().replace(/\/+$/, "");
}

function replacePathPrefix(pathValue: string, oldPrefix: string, newPrefix: string): string | null {
	if (pathValue === oldPrefix) {
		return newPrefix;
	}
	if (!pathValue.startsWith(`${oldPrefix}/`)) {
		return null;
	}
	return `${newPrefix}${pathValue.slice(oldPrefix.length)}`;
}
