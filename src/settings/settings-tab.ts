import {App, PluginSettingTab, Setting} from "obsidian";
import type MediaVaultPlugin from "../main";
import {normalizeGalleryPageSize, type GalleryPageSize} from "../utils/gallery-pagination";
import {getThumbnailPresetConfig, type ThumbnailQualityPreset} from "../services/thumbnail-presets";

const ASSET_NOTE_DIRECTORY_PLACEHOLDER = "Assets/Asset Notes/";
const THUMBNAIL_QUALITY_LABELS: Record<ThumbnailQualityPreset, string> = {
	space: "省空间",
	balanced: "均衡",
	quality: "高清",
};
const GALLERY_PAGE_SIZE_LABELS: Record<GalleryPageSize, string> = {
	0: "全部",
	100: "100",
	200: "200",
	500: "500",
};

export class MediaVaultSettingTab extends PluginSettingTab {
	private readonly plugin: MediaVaultPlugin;

	constructor(app: App, plugin: MediaVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("图片库设置")
			.setHeading();

		new Setting(containerEl)
			.setName("全局素材目录")
			.setDesc("从图库导入或提升为全局素材后的默认保存位置。")
			.addText((text) => text
				.setPlaceholder("Assets/Images/{{YYYY}}/{{MM}}/")
				.setValue(this.plugin.settings.globalAssetDirectoryTemplate)
				.onChange(async (value) => {
					this.plugin.settings.globalAssetDirectoryTemplate = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("素材笔记目录")
			.setDesc("按需创建素材笔记时使用。")
			.addText((text) => text
				.setPlaceholder(ASSET_NOTE_DIRECTORY_PLACEHOLDER)
				.setValue(this.plugin.settings.assetNoteDirectory)
				.onChange(async (value) => {
					this.plugin.settings.assetNoteDirectory = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("局部附件目录模板")
			.setDesc("笔记局部图片默认存放目录。")
			.addText((text) => text
				.setPlaceholder("{{noteName}}.assets/")
				.setValue(this.plugin.settings.localAttachmentDirectoryTemplate)
				.onChange(async (value) => {
					this.plugin.settings.localAttachmentDirectoryTemplate = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("缩略图缓存上限")
			.setDesc("单位兆字节。缩略图缓存写入插件目录，超过上限后自动清理最旧缓存。")
			.addText((text) => text
				.setPlaceholder("1024")
				.setValue(String(this.plugin.settings.thumbnailCacheLimitMb))
				.onChange(async (value) => {
					const parsed = Number(value);
					if (Number.isFinite(parsed) && parsed > 0) {
						this.plugin.settings.thumbnailCacheLimitMb = parsed;
						await this.plugin.saveSettings();
					}
				}))
			.addButton((button) => button
				.setButtonText("重建缓存")
				.onClick(() => {
					void this.plugin.rebuildThumbnailCache(true);
				}));

		new Setting(containerEl)
			.setName("缩略图清晰度")
			.setDesc("影响首页缩略图清晰度和缓存体积；切换后会按新设置懒生成缓存。")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(THUMBNAIL_QUALITY_LABELS)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.plugin.settings.thumbnailQualityPreset)
					.onChange(async (value) => {
						const preset = value as ThumbnailQualityPreset;
						const config = getThumbnailPresetConfig(preset);
						this.plugin.settings.thumbnailQualityPreset = preset;
						this.plugin.settings.thumbnailSizes = {
							small: config.small,
							large: config.large,
						};
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("每页图片数量")
			.setDesc("限制首页单页图片数量，降低大图库的布局和预热开销。")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(GALLERY_PAGE_SIZE_LABELS)) {
					dropdown.addOption(value, value === "0" ? label : `${label} 张`);
				}
				dropdown
					.setValue(String(this.plugin.settings.galleryPageSize))
					.onChange(async (value) => {
						this.plugin.settings.galleryPageSize = normalizeGalleryPageSize(Number(value));
						await this.plugin.saveSettings();
					});
			});

			new Setting(containerEl)
				.setName("移动端只读降级")
				.setDesc("开启后，移动端不执行批量移动、删除、压缩等写操作。")
				.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.mobileReadOnlyMode)
					.onChange(async (value) => {
						this.plugin.settings.mobileReadOnlyMode = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName("默认同步标注到素材笔记")
				.setDesc("关闭时，新建区域标注默认只写入插件索引；仍可在单条标注里手动选择写入素材笔记。")
				.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.syncAnnotationsToAssetNote)
					.onChange(async (value) => {
						this.plugin.settings.syncAnnotationsToAssetNote = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName("主色提取")
				.setDesc("后续元数据任务使用。")
				.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.enableDominantColor)
					.onChange(async (value) => {
						this.plugin.settings.enableDominantColor = value;
						await this.plugin.saveSettings();
					}));

				new Setting(containerEl)
					.setName("本地 AI 标签建议")
					.setDesc("默认关闭。开启后只基于文件名、路径、已保存识别文本和引用上下文生成本地建议，不上传图片或文本。")
					.addToggle((toggle) => toggle
						.setValue(this.plugin.settings.enableAiTagging)
						.onChange(async (value) => {
							this.plugin.settings.enableAiTagging = value;
							await this.plugin.saveSettings();
							this.display();
						}));

				new Setting(containerEl)
					.setName("云端 AI 上传")
					.setDesc("当前固定关闭。云端上传必须单独设计隐私确认后再接入。")
					.addToggle((toggle) => toggle
						.setValue(false)
						.setDisabled(true));
	}
}
