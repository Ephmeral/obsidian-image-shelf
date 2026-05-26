import {normalizePath} from "obsidian";
import {SUPPORTED_IMAGE_EXTENSIONS} from "../constants";

export function getFileExtension(filePath: string): string {
	const filename = filePath.split("/").pop() ?? filePath;
	const dotIndex = filename.lastIndexOf(".");
	if (dotIndex < 0) {
		return "";
	}
	return filename.slice(dotIndex + 1).toLowerCase();
}

export function isSupportedImagePath(filePath: string): boolean {
	return SUPPORTED_IMAGE_EXTENSIONS.has(getFileExtension(filePath));
}

export function getFilename(filePath: string): string {
	return filePath.split("/").pop() ?? filePath;
}

export function getParentPath(filePath: string): string {
	const index = filePath.lastIndexOf("/");
	return index >= 0 ? filePath.slice(0, index) : "";
}

export function joinVaultPath(...parts: string[]): string {
	return normalizePath(parts.filter((part) => part.length > 0).join("/"));
}

export function stripLeadingSlash(filePath: string): string {
	return filePath.startsWith("/") ? filePath.slice(1) : filePath;
}
