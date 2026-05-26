export function stableHash8(input: string): string {
	let hash = 0x811c9dc5;

	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}

	return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

export function generateAssetId(filePath: string, ctime: number, sizeBytes: number): string {
	const date = new Date(ctime || Date.now());
	const yyyy = String(date.getFullYear());
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	const hash = stableHash8(`${filePath}:${ctime}:${sizeBytes}`);
	return `img_${yyyy}${mm}${dd}_${hash}`;
}
