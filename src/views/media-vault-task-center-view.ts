import {ItemView, Notice, WorkspaceLeaf} from "obsidian";
import {MEDIA_VAULT_TASK_CENTER_VIEW_TYPE} from "../constants";
import type MediaVaultPlugin from "../main";
import type {MediaVaultJob, MediaVaultJobStatus, MediaVaultJobType} from "../services/task-queue";

const SUMMARY_TYPES: Array<{type: MediaVaultJobType; label: string}> = [
	{type: "thumbnail", label: "缩略图"},
	{type: "color", label: "颜色索引"},
	{type: "hash", label: "Hash"},
	{type: "references", label: "引用索引"},
	{type: "similarity", label: "相似度"},
	{type: "ocr", label: "OCR"},
	{type: "ai", label: "AI 标签"},
	{type: "asset-note-sync", label: "Asset Note"},
	{type: "index", label: "图片索引"},
];

const STATUS_LABELS: Record<MediaVaultJobStatus, string> = {
	queued: "排队中",
	running: "运行中",
	succeeded: "已完成",
	failed: "失败",
	canceled: "已取消",
	paused: "已暂停",
};

export class MediaVaultTaskCenterView extends ItemView {
	private readonly plugin: MediaVaultPlugin;
	private unsubscribeJobs: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MediaVaultPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return MEDIA_VAULT_TASK_CENTER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "任务中心";
	}

	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		this.unsubscribeJobs = this.plugin.services.jobQueue.subscribe(() => this.render());
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribeJobs?.();
		this.unsubscribeJobs = null;
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("media-vault-task-center-root");

		const jobs = this.plugin.services.jobQueue.getJobs();
		this.renderHeader(root, jobs);
		this.renderSummary(root, jobs);
		this.renderQueue(root, jobs);
	}

	private renderHeader(root: HTMLElement, jobs: MediaVaultJob[]): void {
		const head = root.createDiv({cls: "media-vault-task-center-head"});
		const titleGroup = head.createDiv();
		titleGroup.createDiv({cls: "media-vault-logo", text: "索引任务中心"});
		titleGroup.createDiv({
			cls: "media-vault-task-subtitle",
			text: `后台任务 ${jobs.length} 个，运行中 ${jobs.filter(isActiveJob).length} 个，失败 ${jobs.filter((job) => job.status === "failed").length} 个。`,
		});

		const actions = head.createDiv({cls: "media-vault-task-actions"});
		const rebuild = actions.createEl("button", {text: "重建索引"});
		rebuild.addEventListener("click", () => {
			this.plugin.confirmRebuildIndex();
		});
		const clear = actions.createEl("button", {text: "清除完成"});
		clear.addEventListener("click", () => {
			this.plugin.services.jobQueue.clearCompleted();
		});
	}

	private renderSummary(root: HTMLElement, jobs: MediaVaultJob[]): void {
		const summary = root.createDiv({cls: "media-vault-task-summary"});
		for (const type of SUMMARY_TYPES) {
			const scoped = jobs.filter((job) => job.type === type.type);
			const total = scoped.reduce((sum, job) => sum + job.total, 0);
			const completed = scoped.reduce((sum, job) => sum + getCompletedUnits(job), 0);
			const card = summary.createDiv({cls: "media-vault-task-summary-card"});
			card.createDiv({cls: "media-vault-task-summary-title", text: type.label});
			card.createDiv({
				cls: "media-vault-task-summary-meta",
				text: total > 0 ? `完成 ${completed} / ${total}` : "未运行",
			});
		}
	}

	private renderQueue(root: HTMLElement, jobs: MediaVaultJob[]): void {
		const queue = root.createDiv({cls: "media-vault-task-queue"});
		const queueHead = queue.createDiv({cls: "media-vault-task-queue-head"});
		queueHead.createDiv({cls: "media-vault-section-title", text: "任务队列"});
		const state = queueHead.createSpan({
			cls: `media-vault-job-badge ${jobs.some(isActiveJob) ? "is-running" : "is-idle"}`,
			text: jobs.some(isActiveJob) ? "运行中" : "空闲",
		});
		state.setAttr("aria-label", "任务队列状态");

		if (jobs.length === 0) {
			queue.createDiv({cls: "media-vault-empty", text: "暂无后台任务。"});
			return;
		}

		const list = queue.createDiv({cls: "media-vault-job-list"});
		for (const job of jobs) {
			this.renderJobCard(list, job);
		}
	}

	private renderJobCard(list: HTMLElement, job: MediaVaultJob): void {
		const progress = getProgressPercent(job);
		const card = list.createDiv({cls: `media-vault-job-card is-${job.status}`});
		card.addEventListener("click", () => this.openJobTarget(job));

		const top = card.createDiv({cls: "media-vault-job-row"});
		top.createDiv({cls: "media-vault-job-title", text: job.label});
		top.createSpan({cls: `media-vault-job-badge is-${job.status}`, text: STATUS_LABELS[job.status]});

		const meta = card.createDiv({cls: "media-vault-job-meta"});
		meta.createSpan({text: getJobTypeLabel(job.type)});
		meta.createSpan({text: `优先级 ${job.priority}`});
		meta.createSpan({text: formatTime(job.updatedAt)});

		const bar = card.createDiv({cls: "media-vault-job-progress"});
		bar.createDiv({cls: "media-vault-job-progress-fill"}).style.width = `${progress}%`;
		card.createDiv({cls: "media-vault-job-progress-text", text: `${job.progress} / ${job.total}`});

		if (job.details) {
			card.createDiv({cls: "media-vault-job-details", text: job.details});
		}
		if (job.error) {
			card.createDiv({cls: "media-vault-job-error", text: job.error});
		}

		if (job.status === "failed") {
			const retry = card.createEl("button", {cls: "media-vault-job-retry", text: "重试"});
			retry.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.retryJob(job);
			});
		}
	}

	private openJobTarget(job: MediaVaultJob): void {
		if (job.assetId) {
			const asset = this.plugin.services.assetRepository.getAssetById(job.assetId);
			if (job.type === "ai" && asset) {
				void this.plugin.openAiSuggestionsForAsset(asset);
				return;
			}
			void this.plugin.openAssetDetailInGallery(job.assetId, job.type === "ocr" ? "ocr" : "detail");
			return;
		}
		if (job.error) {
			new Notice(job.error);
		}
	}

	private retryJob(job: MediaVaultJob): void {
		if (job.type === "thumbnail") {
			void this.plugin.rebuildThumbnailCache(true);
			return;
		}
		if (job.type === "index" || job.type === "references") {
			void this.plugin.rebuildIndex(true);
			return;
		}
		if (job.type === "ai" && job.assetId) {
			const asset = this.plugin.services.assetRepository.getAssetById(job.assetId);
			if (asset) {
				void this.plugin.openAiSuggestionsForAsset(asset);
				return;
			}
		}
		new Notice("该任务类型暂未接入重试。");
	}
}

function getJobTypeLabel(type: MediaVaultJobType): string {
	return SUMMARY_TYPES.find((item) => item.type === type)?.label ?? type;
}

function isActiveJob(job: MediaVaultJob): boolean {
	return job.status === "running" || job.status === "queued" || job.status === "paused";
}

function getCompletedUnits(job: MediaVaultJob): number {
	if (job.status === "succeeded") {
		return job.total;
	}
	return Math.min(job.progress, job.total);
}

function getProgressPercent(job: MediaVaultJob): number {
	if (job.total <= 0) {
		return 0;
	}
	return Math.min(100, Math.round((getCompletedUnits(job) / job.total) * 100));
}

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}
