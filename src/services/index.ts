import {App, Plugin} from "obsidian";
import {AssetIndexer} from "./asset-indexer";
import {AssetRepository} from "./asset-repository";
import {AiMetadataService} from "./ai-metadata-service";
import {CollectionService} from "./collection-service";
import {LinkGraphService} from "./link-graph-service";
import {OcrService} from "./ocr-service";
import {RecommendationPreferenceService} from "./recommendation-preference-service";
import {RecommendationService} from "./recommendation-service";
import {SearchService} from "./search-service";
import {SimilarityService} from "./similarity-service";
import {JobQueueService} from "./task-queue";
import {ThumbnailService} from "./thumbnail-service";
import {TransactionLogService} from "./transaction-log-service";
import type {MediaVaultSettings} from "../settings";

export interface MediaVaultServices {
	assetRepository: AssetRepository;
	assetIndexer: AssetIndexer;
	aiMetadataService: AiMetadataService;
	collectionService: CollectionService;
	linkGraphService: LinkGraphService;
	ocrService: OcrService;
	recommendationPreferenceService: RecommendationPreferenceService;
	recommendationService: RecommendationService;
	searchService: SearchService;
	similarityService: SimilarityService;
	taskQueue: JobQueueService;
	jobQueue: JobQueueService;
	thumbnailService: ThumbnailService;
	transactionLogService: TransactionLogService;
}

export function createMediaVaultServices(app: App, plugin: Plugin & {settings: MediaVaultSettings}): MediaVaultServices {
	const assetRepository = new AssetRepository(plugin);
	const jobQueue = new JobQueueService();
	return {
		assetRepository,
		assetIndexer: new AssetIndexer(app, assetRepository),
		aiMetadataService: new AiMetadataService(assetRepository, jobQueue),
		collectionService: new CollectionService(),
			linkGraphService: new LinkGraphService(app, assetRepository),
			ocrService: new OcrService(assetRepository, jobQueue),
			recommendationPreferenceService: new RecommendationPreferenceService(plugin),
			recommendationService: new RecommendationService(),
		searchService: new SearchService(assetRepository),
		similarityService: new SimilarityService(),
		taskQueue: jobQueue,
		jobQueue,
		thumbnailService: new ThumbnailService(app, assetRepository, () => plugin.settings, plugin.manifest.id, jobQueue),
		transactionLogService: new TransactionLogService(plugin),
	};
}
