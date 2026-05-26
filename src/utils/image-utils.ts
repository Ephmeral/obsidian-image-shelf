export function mimeTypeFromExtension(ext: string): string {
	switch (ext.toLowerCase()) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "svg":
			return "image/svg+xml";
		default:
			return "application/octet-stream";
	}
}

export function formatFileSize(sizeBytes: number): string {
	if (sizeBytes < 1024) {
		return `${sizeBytes} B`;
	}

	const sizeKb = sizeBytes / 1024;
	if (sizeKb < 1024) {
		return `${sizeKb.toFixed(1)} KB`;
	}

	return `${(sizeKb / 1024).toFixed(1)} MB`;
}

export function formatDateTime(timestamp: number): string {
	if (!timestamp) {
		return "-";
	}

	return new Date(timestamp).toLocaleString();
}

export function formatDate(timestamp: number): string {
	if (!timestamp) {
		return "-";
	}

	const date = new Date(timestamp);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}/${month}/${day}`;
}
