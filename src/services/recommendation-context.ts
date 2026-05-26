import {App, Editor, MarkdownView, TFile} from "obsidian";
import type {AssetRepository} from "./asset-repository";
import type {RecommendationContext} from "./recommendation-service";
import {getParentPath} from "../utils/path-utils";

export async function buildRecommendationContext(app: App, repository: AssetRepository, note: TFile, editor?: Editor): Promise<RecommendationContext> {
	const content = await app.vault.cachedRead(note);
	const cache = app.metadataCache.getFileCache(note);
	const frontmatterTags = normalizeFrontmatterTags(cache?.frontmatter?.tags);
	const headingText = (cache?.headings ?? []).map((heading) => heading.heading).join(" ");
	const activeEditor = editor ?? app.workspace.getActiveViewOfType(MarkdownView)?.editor;
	const cursorLine = activeEditor?.getLine(activeEditor.getCursor().line) ?? "";
	return {
		notePath: note.path,
		noteTitle: note.basename,
		noteFolder: getParentPath(note.path),
		noteText: `${headingText} ${cursorLine} ${content.slice(0, 4000)}`,
		frontmatterTags,
		referencedAssetIds: new Set(repository.getReferencesForNote(note.path).map((reference) => reference.assetId)),
	};
}

function normalizeFrontmatterTags(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map(String).map(cleanTag).filter(Boolean);
	}
	if (typeof value === "string") {
		return value.split(/[,\s]+/).map(cleanTag).filter(Boolean);
	}
	return [];
}

function cleanTag(value: string): string {
	return value.trim().replace(/^#/, "");
}
