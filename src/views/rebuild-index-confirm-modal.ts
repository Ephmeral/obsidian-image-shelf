import {App, Modal, Notice} from "obsidian";

export interface RebuildIndexConfirmStats {
	assets: number;
	references: number;
}

export class RebuildIndexConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly stats: RebuildIndexConfirmStats,
		private readonly onConfirm: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("media-vault-confirm-modal");
		this.contentEl.createEl("h3", {text: "重建图片索引"});
		this.contentEl.createDiv({
			text: `将重新扫描 vault 中的图片和 Markdown 引用。当前索引包含 ${this.stats.assets} 张图片、${this.stats.references} 个引用。大型 vault 可能需要一些时间。`,
		});
		const warning = this.contentEl.createDiv({
			cls: "media-vault-confirm-warning",
			text: "重建过程中图库仍可浏览，但任务中心会显示新的索引任务；请避免频繁重复触发。",
		});
		warning.setAttr("role", "note");

		const actions = this.contentEl.createDiv({cls: "media-vault-detail-actions"});
		const cancel = actions.createEl("button", {text: "取消"});
		cancel.addEventListener("click", () => this.close());
		const confirm = actions.createEl("button", {cls: "mod-warning", text: "确认重建"});
		confirm.addEventListener("click", () => {
			confirm.disabled = true;
			void this.onConfirm()
				.then(() => this.close())
				.catch((error) => {
					confirm.disabled = false;
					new Notice(`重建索引失败：${getErrorMessage(error)}`);
				});
		});
	}
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return "未知错误";
}
