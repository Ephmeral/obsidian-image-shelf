import esbuild from "esbuild";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawn} from "node:child_process";

const testDir = new URL("../tests/", import.meta.url);
const files = (await readdir(testDir))
	.filter((file) => file.endsWith(".test.ts"))
	.map((file) => new URL(file, testDir).pathname);

if (files.length === 0) {
	console.log("No test files found.");
	process.exit(0);
}

const outdir = await mkdtemp(join(tmpdir(), "media-vault-tests-"));

try {
	await esbuild.build({
		entryPoints: files,
		bundle: true,
		platform: "node",
		format: "esm",
		outdir,
		outExtension: {
			".js": ".mjs",
		},
		logLevel: "silent",
	});

	const result = await runNodeTest(outdir);
	process.exitCode = result;
} finally {
	await rm(outdir, {recursive: true, force: true});
}

async function runNodeTest(outdir) {
	const testFiles = (await readdir(outdir))
		.filter((file) => file.endsWith(".mjs"))
		.map((file) => join(outdir, file));

	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--test", ...testFiles], {
			stdio: "inherit",
		});
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", () => resolve(1));
	});
}
