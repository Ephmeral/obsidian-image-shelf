import {App, normalizePath} from "obsidian";
import type {Asset, AssetReference, ReferenceLinkType} from "../types/asset";
import {getFilename, getParentPath, stripLeadingSlash} from "../utils/path-utils";
import type {AssetRepository} from "./asset-repository";

interface ParsedImageLink {
	rawLink: string;
	target: string;
	linkType: ReferenceLinkType;
	offset: number;
}

export interface ReferenceRebuildResult {
	references: number;
	notesScanned: number;
}

export class LinkGraphService {
	private readonly app: App;
	private readonly repository: AssetRepository;

	constructor(app: App, repository: AssetRepository) {
		this.app = app;
		this.repository = repository;
	}

	async rebuildReferences(): Promise<ReferenceRebuildResult> {
		const assets = this.repository.getAssets();
		const references: AssetReference[] = [];
		const notes = this.app.vault.getMarkdownFiles();

		for (let i = 0; i < notes.length; i += 1) {
			const note = notes[i];
			if (!note) {
				continue;
			}

			const content = await this.app.vault.read(note);
			const parsedLinks = parseImageLinks(content);
			for (const parsedLink of parsedLinks) {
				const asset = resolveAsset(parsedLink.target, note.path, assets);
				if (!asset) {
					continue;
				}

				const lineStart = getLineNumber(content, parsedLink.offset);
				const heading = getHeadingPathAtOffset(content, parsedLink.offset);
				references.push({
					assetId: asset.id,
					sourceNotePath: note.path,
					linkType: parsedLink.linkType,
					rawLink: parsedLink.rawLink,
					resolvedPath: asset.filePath,
					lineStart,
					lineEnd: lineStart,
					heading,
					contextPreview: getContextPreview(content, lineStart),
				});
			}

			if (i > 0 && i % 25 === 0) {
				await yieldToMainThread();
			}
		}

		await this.repository.replaceReferences(references);
		return {
			references: references.length,
			notesScanned: notes.length,
		};
	}
}

function parseImageLinks(content: string): ParsedImageLink[] {
	const links: ParsedImageLink[] = [];
	const wikiPattern = /!\[\[([^\]]+)\]\]/g;
	const markdownPattern = /!\[[^\]]*]\(([^)]+)\)/g;
	const htmlPattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

	for (const match of content.matchAll(wikiPattern)) {
		const rawLink = match[0] ?? "";
		const target = cleanWikiTarget(match[1] ?? "");
		links.push({
			rawLink,
			target,
			linkType: "embed",
			offset: match.index ?? 0,
		});
	}

	for (const match of content.matchAll(markdownPattern)) {
		const rawLink = match[0] ?? "";
		const target = cleanMarkdownTarget(match[1] ?? "");
		if (!isExternalTarget(target)) {
			links.push({
				rawLink,
				target,
				linkType: "markdown-image",
				offset: match.index ?? 0,
			});
		}
	}

	for (const match of content.matchAll(htmlPattern)) {
		const rawLink = match[0] ?? "";
		const target = cleanMarkdownTarget(match[1] ?? "");
		if (!isExternalTarget(target)) {
			links.push({
				rawLink,
				target,
				linkType: "html-img",
				offset: match.index ?? 0,
			});
		}
	}

	return links;
}

function cleanWikiTarget(target: string): string {
	return target
		.split("|")[0]
		?.split("#")[0]
		?.trim() ?? "";
}

function cleanMarkdownTarget(target: string): string {
	const withoutTitle = target.trim().split(/\s+["'][^"']*["']$/)[0] ?? target.trim();
	try {
		return decodeURIComponent(withoutTitle);
	} catch {
		return withoutTitle;
	}
}

function isExternalTarget(target: string): boolean {
	return /^(https?:|data:|file:)/i.test(target);
}

function resolveAsset(target: string, sourceNotePath: string, assets: Asset[]): Asset | undefined {
	const cleanTarget = normalizePath(stripLeadingSlash(target));
	const exact = assets.find((asset) => asset.filePath === cleanTarget);
	if (exact) {
		return exact;
	}

	const relativePath = normalizePath(`${getParentPath(sourceNotePath)}/${cleanTarget}`);
	const relative = assets.find((asset) => asset.filePath === relativePath);
	if (relative) {
		return relative;
	}

	const basenameMatches = assets.filter((asset) => getFilename(asset.filePath) === getFilename(cleanTarget));
	return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
}

function getLineNumber(content: string, offset: number): number {
	return content.slice(0, offset).split("\n").length;
}

function getLineAt(content: string, lineNumber: number): string {
	const line = content.split(/\r?\n/)[lineNumber - 1] ?? "";
	return line.trim().slice(0, 180);
}

function getContextPreview(content: string, lineNumber: number): string {
	const lines = content.split(/\r?\n/);
	const start = Math.max(0, lineNumber - 2);
	const end = Math.min(lines.length, lineNumber + 1);
	const snippets: string[] = [];
	for (let index = start; index < end; index += 1) {
		const line = lines[index]?.trim();
		if (line) {
			snippets.push(`${index + 1}: ${line}`);
		}
	}
	return (snippets.join(" / ") || getLineAt(content, lineNumber)).slice(0, 260);
}

function getHeadingPathAtOffset(content: string, offset: number): string | undefined {
	const headingStack: Array<{level: number; text: string}> = [];
	let cursor = 0;
	for (const line of content.split(/\r?\n/)) {
		if (cursor > offset) {
			break;
		}

		const heading = parseMarkdownHeading(line);
		if (heading) {
			while (headingStack.length > 0 && (headingStack.at(-1)?.level ?? 0) >= heading.level) {
				headingStack.pop();
			}
			headingStack.push(heading);
		}
		cursor += line.length + 1;
	}

	const path = headingStack.map((heading) => heading.text).join(" / ");
	return path || undefined;
}

function parseMarkdownHeading(line: string): {level: number; text: string} | null {
	const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
	if (!match) {
		return null;
	}
	const text = match[2]?.trim();
	if (!text) {
		return null;
	}
	return {
		level: match[1]?.length ?? 1,
		text,
	};
}

function yieldToMainThread(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}
