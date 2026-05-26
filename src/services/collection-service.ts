import type {AssetOrigin} from "../types/asset";
import type {AssetQuery} from "../types/query";

export type SmartCollectionMode = "visual" | "dsl";
export type SmartConditionField = "tag" | "rating" | "linked" | "used-in-folder" | "format" | "width" | "height" | "size" | "collection" | "color" | "unused" | "source" | "has-ocr" | "has-annotation";
export type SmartConditionOperator = "contains" | "equals" | "gte" | "lte" | "exists";

export interface SmartCondition {
	id: string;
	field: SmartConditionField;
	operator: SmartConditionOperator;
	value: string;
}

export interface SmartCollectionDraft {
	id?: string;
	name: string;
	description: string;
	icon: string;
	color: string;
	mode: SmartCollectionMode;
	conditions: SmartCondition[];
	dsl: string;
}

export interface SmartDslParseResult {
	query: AssetQuery;
	errors: string[];
}

const VALID_ORIGINS = new Set<AssetOrigin>(["local-note", "library", "screenshot", "web", "imported"]);

export class CollectionService {
	createDraft(query: AssetQuery = {}, defaults?: Partial<SmartCollectionDraft>): SmartCollectionDraft {
		const conditions = assetQueryToConditions(query);
		return {
			name: defaults?.name ?? "",
			description: defaults?.description ?? "",
			icon: defaults?.icon ?? "▧",
			color: defaults?.color ?? "#6655e8",
			mode: defaults?.mode ?? "visual",
			conditions,
			dsl: defaults?.dsl ?? stringifySmartQuery(conditionsToAssetQuery(conditions)),
			id: defaults?.id,
		};
	}

	conditionsToAssetQuery(conditions: SmartCondition[]): AssetQuery {
		return conditionsToAssetQuery(conditions);
	}

	assetQueryToConditions(query: AssetQuery): SmartCondition[] {
		return assetQueryToConditions(query);
	}

	stringifySmartQuery(query: AssetQuery): string {
		return stringifySmartQuery(query);
	}

	parseSmartQueryDsl(dsl: string): SmartDslParseResult {
		return parseSmartQueryDsl(dsl);
	}
}

export function createEmptySmartCondition(field: SmartConditionField = "tag"): SmartCondition {
	return {
		id: `condition-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		field,
		operator: getDefaultOperator(field),
		value: getDefaultValue(field),
	};
}

export function getDefaultOperator(field: SmartConditionField): SmartConditionOperator {
	if (field === "rating" || field === "width" || field === "height" || field === "size") {
		return "gte";
	}
	if (field === "unused" || field === "has-ocr" || field === "has-annotation") {
		return "equals";
	}
	if (field === "linked") {
		return "exists";
	}
	return "contains";
}

export function getDefaultValue(field: SmartConditionField): string {
	if (field === "unused" || field === "has-ocr" || field === "has-annotation") {
		return "true";
	}
	return "";
}

function conditionsToAssetQuery(conditions: SmartCondition[]): AssetQuery {
	const query: AssetQuery = {};
	for (const condition of conditions) {
		const value = condition.value.trim();
		if (!value && condition.operator !== "exists" && condition.field !== "unused") {
			continue;
		}
		if (condition.field === "tag") {
			query.tags = mergeValues(query.tags, splitValues(value));
		} else if (condition.field === "collection") {
			query.collections = mergeValues(query.collections, splitValues(value));
		} else if (condition.field === "format") {
			query.formats = mergeValues(query.formats, splitValues(value).map((item) => item.toLowerCase()));
		} else if (condition.field === "color") {
			query.colors = mergeValues(query.colors, splitValues(value));
		} else if (condition.field === "source") {
			const origins = splitValues(value).filter((item): item is AssetOrigin => VALID_ORIGINS.has(item as AssetOrigin));
			if (origins.length > 0) {
				query.origin = [...new Set([...(query.origin ?? []), ...origins])];
			}
		} else if (condition.field === "rating") {
			query.ratingGte = toNumber(value);
		} else if (condition.field === "width") {
			applyNumericCondition(query, "minWidth", "maxWidth", condition.operator, value);
		} else if (condition.field === "height") {
			applyNumericCondition(query, "minHeight", "maxHeight", condition.operator, value);
		} else if (condition.field === "size") {
			applyNumericCondition(query, "minSizeKb", "maxSizeKb", condition.operator, value);
		} else if (condition.field === "linked") {
			query.referenced = true;
			if (value) {
				query.linkedByNote = stripWikiLink(value);
			}
		} else if (condition.field === "used-in-folder") {
			query.linkedByFolder = value;
		} else if (condition.field === "unused") {
			query.referenced = value.toLowerCase() !== "false";
			query.referenced = !query.referenced;
		} else if (condition.field === "has-ocr") {
			query.hasOcr = condition.operator === "exists" || value.toLowerCase() !== "false";
		} else if (condition.field === "has-annotation") {
			query.hasAnnotation = condition.operator === "exists" || value.toLowerCase() !== "false";
		}
	}
	return query;
}

function assetQueryToConditions(query: AssetQuery): SmartCondition[] {
	const conditions: SmartCondition[] = [];
	pushListCondition(conditions, "tag", query.tags);
	pushListCondition(conditions, "collection", query.collections);
	pushListCondition(conditions, "format", query.formats);
	pushListCondition(conditions, "color", query.colors);
	pushListCondition(conditions, "source", query.origin);
	if (typeof query.ratingGte === "number") {
		conditions.push(createCondition("rating", "gte", String(query.ratingGte)));
	}
	pushRangeCondition(conditions, "width", query.minWidth, query.maxWidth);
	pushRangeCondition(conditions, "height", query.minHeight, query.maxHeight);
	pushRangeCondition(conditions, "size", query.minSizeKb, query.maxSizeKb);
	if (query.linkedByNote) {
		conditions.push(createCondition("linked", "contains", query.linkedByNote));
	} else if (query.referenced === true) {
		conditions.push(createCondition("linked", "exists", ""));
	}
	if (query.linkedByFolder) {
		conditions.push(createCondition("used-in-folder", "contains", query.linkedByFolder));
	}
	if (query.referenced === false) {
		conditions.push(createCondition("unused", "equals", "true"));
	}
	if (typeof query.hasOcr === "boolean") {
		conditions.push(createCondition("has-ocr", "equals", String(query.hasOcr)));
	}
	if (typeof query.hasAnnotation === "boolean") {
		conditions.push(createCondition("has-annotation", "equals", String(query.hasAnnotation)));
	}
	return conditions;
}

function stringifySmartQuery(query: AssetQuery): string {
	const parts: string[] = [];
	for (const tag of query.tags ?? []) {
		parts.push(`tag:${escapeDslValue(tag)}`);
	}
	for (const collection of query.collections ?? []) {
		parts.push(`collection:${escapeDslValue(collection)}`);
	}
	for (const format of query.formats ?? []) {
		parts.push(`format:${format}`);
	}
	for (const color of query.colors ?? []) {
		parts.push(`color:${color}`);
	}
	for (const origin of query.origin ?? []) {
		parts.push(`source:${origin}`);
	}
	if (typeof query.ratingGte === "number") {
		parts.push(`rating>=${query.ratingGte}`);
	}
	appendRangeDsl(parts, "width", query.minWidth, query.maxWidth);
	appendRangeDsl(parts, "height", query.minHeight, query.maxHeight);
	appendRangeDsl(parts, "size", query.minSizeKb, query.maxSizeKb);
	if (query.linkedByNote) {
		parts.push(`linked:[[${query.linkedByNote}]]`);
	} else if (query.referenced === true) {
		parts.push("linked:true");
	}
	if (query.linkedByFolder) {
		parts.push(`used-in-folder:${escapeDslValue(query.linkedByFolder)}`);
	}
	if (query.referenced === false) {
		parts.push("unused:true");
	}
	if (typeof query.hasOcr === "boolean") {
		parts.push(`has-ocr:${query.hasOcr}`);
	}
	if (typeof query.hasAnnotation === "boolean") {
		parts.push(`has-annotation:${query.hasAnnotation}`);
	}
	return parts.join(" ");
}

function parseSmartQueryDsl(dsl: string): SmartDslParseResult {
	const query: AssetQuery = {};
	const errors: string[] = [];
	const tokens = tokenizeSmartDsl(dsl);
	for (const token of tokens) {
		if (token.startsWith("-")) {
			errors.push(`暂不支持排除条件：${token}`);
			continue;
		}
		const ratingMatch = token.match(/^rating>=(\d+)$/i);
		if (ratingMatch) {
			query.ratingGte = Number(ratingMatch[1]);
			continue;
		}
		const rangeMatch = token.match(/^(width|height|size)(>=|<=)(\d+)$/i);
		if (rangeMatch) {
			const field = rangeMatch[1];
			const operator = rangeMatch[2];
			const value = rangeMatch[3];
			if (!field || !operator || !value) {
				continue;
			}
			const condition = createCondition(field.toLowerCase() as SmartConditionField, operator === ">=" ? "gte" : "lte", value);
			Object.assign(query, conditionsToAssetQuery([condition]));
			continue;
		}
		const separatorIndex = token.indexOf(":");
		if (separatorIndex < 0) {
			errors.push(`无法识别条件：${token}`);
			continue;
		}
		const key = token.slice(0, separatorIndex).toLowerCase();
		const value = unescapeDslValue(token.slice(separatorIndex + 1));
		if (key === "tag") {
			query.tags = mergeValues(query.tags, [value]);
		} else if (key === "collection") {
			query.collections = mergeValues(query.collections, [value]);
		} else if (key === "format") {
			query.formats = mergeValues(query.formats, [value.toLowerCase()]);
		} else if (key === "color") {
			query.colors = mergeValues(query.colors, [value]);
		} else if (key === "source") {
			if (VALID_ORIGINS.has(value as AssetOrigin)) {
				query.origin = [...new Set([...(query.origin ?? []), value as AssetOrigin])];
			} else {
				errors.push(`未知来源：${value}`);
			}
		} else if (key === "linked") {
			query.referenced = value.toLowerCase() !== "false";
			if (value.startsWith("[[")) {
				query.linkedByNote = stripWikiLink(value);
			}
		} else if (key === "used-in-folder" || key === "folder") {
			query.linkedByFolder = value;
		} else if (key === "unused") {
			query.referenced = value.toLowerCase() === "true" ? false : undefined;
		} else if (key === "has-ocr") {
			query.hasOcr = value.toLowerCase() !== "false";
		} else if (key === "has-annotation") {
			query.hasAnnotation = value.toLowerCase() !== "false";
		} else if (key === "imported" && value.startsWith("last-")) {
			const days = Number(value.slice(5, -1));
			if (Number.isFinite(days)) {
				query.origin = [...new Set<AssetOrigin>([...(query.origin ?? []), "imported"])];
				query.modifiedAfter = Date.now() - days * 24 * 60 * 60 * 1000;
			}
		} else {
			errors.push(`未知字段：${key}`);
		}
	}
	return {query, errors};
}

function tokenizeSmartDsl(dsl: string): string[] {
	return dsl.match(/(?:[^\s:]+:\[\[[^\]]+\]\]|[^\s:]+:"[^"]+"|"[^"]+"|\S+)/g) ?? [];
}

function applyNumericCondition(query: AssetQuery, minField: "minWidth" | "minHeight" | "minSizeKb", maxField: "maxWidth" | "maxHeight" | "maxSizeKb", operator: SmartConditionOperator, value: string): void {
	const parsed = toNumber(value);
	if (typeof parsed !== "number") {
		return;
	}
	if (operator === "lte") {
		query[maxField] = parsed;
	} else {
		query[minField] = parsed;
	}
}

function pushListCondition(conditions: SmartCondition[], field: SmartConditionField, values: readonly string[] | undefined): void {
	if (values && values.length > 0) {
		conditions.push(createCondition(field, "contains", values.join(", ")));
	}
}

function pushRangeCondition(conditions: SmartCondition[], field: SmartConditionField, min?: number, max?: number): void {
	if (typeof min === "number") {
		conditions.push(createCondition(field, "gte", String(min)));
	}
	if (typeof max === "number") {
		conditions.push(createCondition(field, "lte", String(max)));
	}
}

function createCondition(field: SmartConditionField, operator: SmartConditionOperator, value: string): SmartCondition {
	return {
		id: `condition-${field}-${operator}-${Math.random().toString(36).slice(2, 7)}`,
		field,
		operator,
		value,
	};
}

function mergeValues(current: string[] | undefined, next: string[]): string[] {
	return [...new Set([...(current ?? []), ...next.filter(Boolean)])];
}

function splitValues(value: string): string[] {
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function toNumber(value: string): number | undefined {
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? parsed : undefined;
}

function stripWikiLink(value: string): string {
	return value.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
}

function escapeDslValue(value: string): string {
	return /\s/.test(value) ? `"${value.split("\"").join("\\\"")}"` : value;
}

function unescapeDslValue(value: string): string {
	const stripped = value.trim().replace(/^"/, "").replace(/"$/, "");
	return stripped.replace(/\\"/g, "\"");
}

function appendRangeDsl(parts: string[], label: string, min?: number, max?: number): void {
	if (typeof min === "number") {
		parts.push(`${label}>=${min}`);
	}
	if (typeof max === "number") {
		parts.push(`${label}<=${max}`);
	}
}
