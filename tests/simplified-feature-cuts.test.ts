import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import assert from "node:assert/strict";
import {test} from "node:test";

function readSource(path: string): string {
	return readFileSync(join(process.cwd(), path), "utf8");
}

function sourceExists(path: string): boolean {
	return existsSync(join(process.cwd(), path));
}

void test("OCR and AI feature code is removed from entry points", () => {
	for (const removedPath of [
		"src/services/ai-metadata-service.ts",
		"src/services/ocr-service.ts",
		"src/services/recommendation-context.ts",
		"src/services/recommendation-preference-service.ts",
		"src/services/recommendation-service.ts",
		"src/types/ai.ts",
		"src/types/ocr.ts",
		"src/views/ai-suggestion-modal.ts",
		"src/views/media-vault-recommendations-view.ts",
	]) {
		assert.equal(sourceExists(removedPath), false, `${removedPath} should be removed`);
	}

	const commands = readSource("src/commands/index.ts");
	const services = readSource("src/services/index.ts");
	const main = readSource("src/main.ts");
	const gallery = readSource("src/views/media-vault-view.ts");
	const inspector = readSource("src/views/media-vault-inspector-view.ts");
	const settings = readSource("src/settings/defaults.ts") + readSource("src/settings/settings-tab.ts");

	assert.doesNotMatch(commands, /open-ocr-panel|generate-ai-tag-suggestions|show-recommended-images-for-current-note/);
	assert.doesNotMatch(services, /AiMetadataService|OcrService|Recommendation(Service|PreferenceService)|aiMetadataService|ocrService|recommendation/);
	assert.doesNotMatch(main, /AiSuggestionModal|MEDIA_VAULT_RECOMMENDATIONS_VIEW_TYPE|openRecommendations|openAiSuggestions|openCommandTargetAiSuggestions|applyAiMetadataSuggestion|copyAssetOcrText|writeOcrResultToAssetNote/);
	assert.doesNotMatch(gallery, /has-ocr|OCR|AI 标签|ocrService|renderOcr|openAiSuggestionsForAsset/);
	assert.doesNotMatch(inspector, /OCR|AI 标签|ocrService|openAiSuggestionsForAsset/);
	assert.doesNotMatch(settings, /enableOcr|enableAiTagging|enableCloudAiUploads|本地 AI|云端 AI|OCR/);
});
