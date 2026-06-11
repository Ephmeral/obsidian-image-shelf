import {readFileSync} from "node:fs";
import {join} from "node:path";
import assert from "node:assert/strict";
import {test} from "node:test";

function readSource(path: string): string {
	return readFileSync(join(process.cwd(), path), "utf8");
}

void test("annotation entry points are removed from primary UI surfaces", () => {
	const main = readSource("src/main.ts");
	const gallery = readSource("src/views/media-vault-view.ts");
	const inspector = readSource("src/views/media-vault-inspector-view.ts");
	const settingsTab = readSource("src/settings/settings-tab.ts");

	assert.doesNotMatch(main, /toolbar\.createEl\("button", \{text: "标注"\}\)/);
	assert.doesNotMatch(main, /\.setTitle\("创建区域标注"\)/);
	assert.doesNotMatch(main, /\.setTitle\("创建 \/ 编辑区域标注"\)/);
	assert.doesNotMatch(main, /openAssetAnnotationInGallery/);
	assert.doesNotMatch(readSource("src/commands/index.ts"), /create-annotation-for-current-image/);

	assert.doesNotMatch(gallery, /has-annotation/);
	assert.doesNotMatch(gallery, /renderBooleanFilterSegment\(parent, "区域标注"/);
	assert.doesNotMatch(gallery, /createEl\("button", \{text: "新建区域标注"\}/);
	assert.doesNotMatch(gallery, /\.setTitle\("创建区域标注"\)/);
	assert.doesNotMatch(gallery, /chips\.push\(\{label: query\.hasAnnotation \? "有标注" : "无标注"/);

	assert.doesNotMatch(inspector, /id: "annotations"/);
	assert.doesNotMatch(inspector, /panelId === "annotations"/);
	assert.doesNotMatch(inspector, /label: this\.plugin\.getDetailMode\(\).*"标注"/);
	assert.doesNotMatch(inspector, /新建区域标注/);

	assert.doesNotMatch(settingsTab, /默认同步标注到素材笔记/);
	assert.doesNotMatch(settingsTab, /区域标注/);
});
