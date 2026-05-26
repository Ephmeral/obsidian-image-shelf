import {getFrontMatterInfo, normalizePath, parseYaml} from "obsidian";
import {DEFAULT_ANNOTATION_COLOR, type Annotation, type Asset} from "../types/asset";

export interface AssetNoteMetadataPatch {
	tags?: string[];
	collections?: string[];
	rating?: Asset["rating"];
	favorite?: boolean;
	dominantColors?: string[];
}

export interface ParsedAssetNoteAnnotation {
	id?: string;
	label: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
	text?: string;
	linkedNotePath?: string;
	linkedHeading?: string;
	linkedBlockId?: string;
}

export interface ParsedAssetNoteMetadata extends AssetNoteMetadataPatch {
	assetId?: string;
	filePath?: string;
	isAssetNote: boolean;
	notePath?: string;
	annotations?: ParsedAssetNoteAnnotation[];
}

export function parseAssetNoteMetadata(content: string): ParsedAssetNoteMetadata {
	const info = getFrontMatterInfo(content);
	if (!info.exists) {
		return {isAssetNote: false};
	}

	try {
		return parseAssetNoteFrontmatter(parseYaml(info.frontmatter));
	} catch {
		return {isAssetNote: false};
	}
}

export function parseAssetNoteFrontmatter(frontmatter: unknown): ParsedAssetNoteMetadata {
	if (!isRecord(frontmatter)) {
		return {isAssetNote: false};
	}

	const parsed: ParsedAssetNoteMetadata = {
		isAssetNote: frontmatter.type === "asset",
	};
	const assetId = parseOptionalString(frontmatter.asset_id ?? frontmatter.assetId);
	if (assetId) {
		parsed.assetId = assetId;
		parsed.isAssetNote = true;
	}
	const filePath = parseOptionalString(frontmatter.file);
	if (filePath) {
		parsed.filePath = normalizePath(filePath);
		parsed.isAssetNote = true;
	}
	if (hasOwn(frontmatter, "tags")) {
		parsed.tags = parseFrontmatterStringList(frontmatter.tags, true);
	}
	if (hasOwn(frontmatter, "collections")) {
		parsed.collections = parseFrontmatterStringList(frontmatter.collections, false);
	}
	if (hasOwn(frontmatter, "rating")) {
		const rating = parseAssetNoteRating(frontmatter.rating);
		if (typeof rating === "number") {
			parsed.rating = rating;
		}
	}
	if (hasOwn(frontmatter, "favorite")) {
		const favorite = parseAssetNoteBoolean(frontmatter.favorite);
		if (typeof favorite === "boolean") {
			parsed.favorite = favorite;
		}
	}
	if (hasOwn(frontmatter, "colors") || hasOwn(frontmatter, "dominant_colors")) {
		parsed.dominantColors = parseFrontmatterStringList(frontmatter.colors ?? frontmatter.dominant_colors, false)
			.filter(isHexColor);
	}
	if (hasOwn(frontmatter, "annotations")) {
		parsed.annotations = parseAssetNoteAnnotations(frontmatter.annotations);
	}
	return parsed;
}

export function getAssetNoteSyncedFieldLabels(patch: AssetNoteMetadataPatch): string[] {
	const labels: string[] = [];
	if (patch.tags) {
		labels.push("标签");
	}
	if (patch.collections) {
		labels.push("Collection");
	}
	if (typeof patch.rating === "number") {
		labels.push("评分");
	}
	if (typeof patch.favorite === "boolean") {
		labels.push("收藏状态");
	}
	if (patch.dominantColors) {
		labels.push("主色");
	}
	return labels;
}

export function toAssetNoteMetadataPatch(metadata: AssetNoteMetadataPatch): AssetNoteMetadataPatch {
	const patch: AssetNoteMetadataPatch = {};
	if (metadata.tags) {
		patch.tags = [...metadata.tags];
	}
	if (metadata.collections) {
		patch.collections = [...metadata.collections];
	}
	if (typeof metadata.rating === "number") {
		patch.rating = metadata.rating;
	}
	if (typeof metadata.favorite === "boolean") {
		patch.favorite = metadata.favorite;
	}
	if (metadata.dominantColors) {
		patch.dominantColors = [...metadata.dominantColors];
	}
	return patch;
}

export function toAssetNoteAnnotations(metadata: ParsedAssetNoteMetadata, assetId: string, existingAnnotations: Annotation[] = [], now = Date.now()): Annotation[] {
	if (!metadata.annotations) {
		return [];
	}
	const existingById = new Map(existingAnnotations.map((annotation) => [annotation.id, annotation]));
	return metadata.annotations.map((entry, index) => {
		const id = entry.id ?? `ann-${assetId}-${index + 1}`;
		const existing = existingById.get(id);
		return {
			id,
			assetId,
			label: entry.label || `A${index + 1}`,
			x: entry.x,
			y: entry.y,
			width: entry.width,
			height: entry.height,
			color: entry.color,
			text: entry.text,
			linkedNotePath: entry.linkedNotePath,
			linkedHeading: entry.linkedHeading,
			linkedBlockId: entry.linkedBlockId,
			storageMode: "asset-note",
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
	});
}

function parseAssetNoteAnnotations(value: unknown): ParsedAssetNoteAnnotation[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const annotations: ParsedAssetNoteAnnotation[] = [];
	value.forEach((entry, index) => {
		const annotation = parseAssetNoteAnnotation(entry, index);
		if (annotation) {
			annotations.push(annotation);
		}
	});
	return annotations;
}

function parseAssetNoteAnnotation(value: unknown, index: number): ParsedAssetNoteAnnotation | null {
	if (!isRecord(value)) {
		return null;
	}

	const rect = parseAnnotationRect(value);
	if (!rect) {
		return null;
	}
	const linkTarget = parseAnnotationLinkFields(value);
	const id = parseOptionalString(value.id);
	return {
		id: id || undefined,
		label: parseOptionalString(value.label) || id || `A${index + 1}`,
		...rect,
		color: parseAnnotationColor(value.color),
		text: parseOptionalString(value.text ?? value.note ?? value.description) || undefined,
		...linkTarget,
	};
}

function parseAnnotationRect(value: Record<string, unknown>): Pick<ParsedAssetNoteAnnotation, "x" | "y" | "width" | "height"> | null {
	const rect = value.rect;
	let x: number | undefined;
	let y: number | undefined;
	let width: number | undefined;
	let height: number | undefined;
	if (Array.isArray(rect)) {
		x = parseAnnotationNumber(rect[0]);
		y = parseAnnotationNumber(rect[1]);
		width = parseAnnotationNumber(rect[2]);
		height = parseAnnotationNumber(rect[3]);
	} else if (isRecord(rect)) {
		x = parseAnnotationNumber(rect.x);
		y = parseAnnotationNumber(rect.y);
		width = parseAnnotationNumber(rect.width);
		height = parseAnnotationNumber(rect.height);
	} else {
		x = parseAnnotationNumber(value.x);
		y = parseAnnotationNumber(value.y);
		width = parseAnnotationNumber(value.width);
		height = parseAnnotationNumber(value.height);
	}

	if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") {
		return null;
	}
	return {
		x: clamp01(x),
		y: clamp01(y),
		width: clamp01(width),
		height: clamp01(height),
	};
}

function parseAnnotationLinkFields(value: Record<string, unknown>): Pick<ParsedAssetNoteAnnotation, "linkedNotePath" | "linkedHeading" | "linkedBlockId"> {
	const target = value.target ?? value.link;
	const linkedNote = parseOptionalString(value.linked_note ?? value.linkedNote ?? value.linkedNotePath);
	const linkedHeading = parseOptionalString(value.linked_heading ?? value.linkedHeading);
	const linkedBlockId = parseOptionalString(value.linked_block ?? value.linkedBlock ?? value.linkedBlockId);
	if (isRecord(target)) {
		return {
			linkedNotePath: parseOptionalString(target.path ?? target.note ?? target.file) || linkedNote || undefined,
			linkedHeading: parseOptionalString(target.heading) || linkedHeading || undefined,
			linkedBlockId: parseOptionalString(target.blockId ?? target.block_id ?? target.block) || linkedBlockId || undefined,
		};
	}

	const parsedTarget = parseAnnotationLinkText(parseOptionalString(target));
	return {
		linkedNotePath: linkedNote || parsedTarget.linkedNotePath,
		linkedHeading: linkedHeading || parsedTarget.linkedHeading,
		linkedBlockId: linkedBlockId || parsedTarget.linkedBlockId,
	};
}

function parseAnnotationLinkText(value: string): Pick<ParsedAssetNoteAnnotation, "linkedNotePath" | "linkedHeading" | "linkedBlockId"> {
	if (!value) {
		return {};
	}
	const linkText = value
		.replace(/^!?\[\[/, "")
		.replace(/\]\]$/, "")
		.split("|")[0]
		?.trim() ?? "";
	const blockSplit = linkText.split("^");
	const beforeBlock = blockSplit[0] ?? "";
	const blockId = parseOptionalString(blockSplit[1]);
	const headingSplit = beforeBlock.split("#");
	const path = parseOptionalString(headingSplit[0]);
	const heading = parseOptionalString(headingSplit.slice(1).join("#"));
	return {
		linkedNotePath: path || undefined,
		linkedHeading: heading || undefined,
		linkedBlockId: blockId || undefined,
	};
}

function parseFrontmatterStringList(value: unknown, stripTagPrefix: boolean): string[] {
	const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const unique = new Set<string>();
	for (const item of source) {
		const text = parseOptionalString(item);
		if (!text) {
			continue;
		}
		unique.add(stripTagPrefix ? text.replace(/^#+/, "") : text);
	}
	return Array.from(unique);
}

function parseOptionalString(value: unknown): string {
	return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function parseAssetNoteRating(value: unknown): Asset["rating"] | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
	if (parsed === 0 || parsed === 1 || parsed === 2 || parsed === 3 || parsed === 4 || parsed === 5) {
		return parsed;
	}
	return undefined;
}

function parseAssetNoteBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (["true", "yes", "1"].includes(normalized)) {
		return true;
	}
	if (["false", "no", "0"].includes(normalized)) {
		return false;
	}
	return undefined;
}

function parseAnnotationNumber(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAnnotationColor(value: unknown): string | undefined {
	const color = parseOptionalString(value);
	if (!color) {
		return undefined;
	}
	return isHexColor(color) ? color : DEFAULT_ANNOTATION_COLOR;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function isHexColor(value: string): boolean {
	return /^#[0-9a-f]{6}$/i.test(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
