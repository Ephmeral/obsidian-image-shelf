import type {AssetReference} from "../types/asset";

export function formatReferenceLocation(reference: Pick<AssetReference, "sourceNotePath" | "lineStart">): string {
	return typeof reference.lineStart === "number" && Number.isFinite(reference.lineStart)
		? `${reference.sourceNotePath}:${reference.lineStart}`
		: reference.sourceNotePath;
}
