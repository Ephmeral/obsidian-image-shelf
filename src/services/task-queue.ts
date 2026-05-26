export type MediaVaultJobType = "index" | "thumbnail" | "color" | "hash" | "references" | "similarity" | "ocr" | "ai" | "asset-note-sync";
export type MediaVaultJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "paused";
export type MediaVaultJobPriority = "low" | "normal" | "high";

export interface MediaVaultJob {
	id: string;
	type: MediaVaultJobType;
	assetId?: string;
	label: string;
	status: MediaVaultJobStatus;
	priority: MediaVaultJobPriority;
	progress: number;
	total: number;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	completedAt?: number;
	error?: string;
	details?: string;
}

export interface CreateMediaVaultJobOptions {
	type: MediaVaultJobType;
	assetId?: string;
	label: string;
	total?: number;
	priority?: MediaVaultJobPriority;
	details?: string;
}

export type JobQueueListener = () => void;

const MAX_JOB_HISTORY = 100;

export class JobQueueService {
	private abortController = new AbortController();
	private jobs: MediaVaultJob[] = [];
	private readonly listeners = new Set<JobQueueListener>();

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	subscribe(listener: JobQueueListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getJobs(): MediaVaultJob[] {
		return [...this.jobs].sort((left, right) => right.createdAt - left.createdAt);
	}

	startJob(options: CreateMediaVaultJobOptions): string {
		const now = Date.now();
		const job: MediaVaultJob = {
			id: createJobId(options.type, now),
			type: options.type,
			assetId: options.assetId,
			label: options.label,
			status: "running",
			priority: options.priority ?? "normal",
			progress: 0,
			total: Math.max(1, options.total ?? 1),
			createdAt: now,
			updatedAt: now,
			startedAt: now,
			details: options.details,
		};
		this.jobs.unshift(job);
		this.pruneHistory();
		this.notify();
		return job.id;
	}

	updateJob(jobId: string, patch: Partial<Pick<MediaVaultJob, "label" | "progress" | "total" | "details">>): void {
		this.updateJobState(jobId, (job) => ({
			...job,
			...patch,
			progress: typeof patch.progress === "number" ? clampProgress(patch.progress, patch.total ?? job.total) : job.progress,
			total: Math.max(1, patch.total ?? job.total),
			updatedAt: Date.now(),
		}));
	}

	completeJob(jobId: string, details?: string): void {
		this.updateJobState(jobId, (job) => ({
			...job,
			status: "succeeded",
			progress: job.total,
			updatedAt: Date.now(),
			completedAt: Date.now(),
			details: details ?? job.details,
		}));
	}

	failJob(jobId: string, error: unknown): void {
		this.updateJobState(jobId, (job) => ({
			...job,
			status: "failed",
			error: getErrorMessage(error),
			updatedAt: Date.now(),
			completedAt: Date.now(),
		}));
	}

	cancelJob(jobId: string): void {
		this.updateJobState(jobId, (job) => ({
			...job,
			status: "canceled",
			updatedAt: Date.now(),
			completedAt: Date.now(),
		}));
	}

	clearCompleted(): void {
		this.jobs = this.jobs.filter((job) => job.status === "running" || job.status === "queued" || job.status === "paused");
		this.notify();
	}

	abortAll(): void {
		this.abortController.abort();
		this.abortController = new AbortController();
		const now = Date.now();
		this.jobs = this.jobs.map((job) => {
			if (job.status !== "running" && job.status !== "queued" && job.status !== "paused") {
				return job;
			}
			return {
				...job,
				status: "canceled",
				updatedAt: now,
				completedAt: now,
			};
		});
		this.notify();
	}

	private updateJobState(jobId: string, updater: (job: MediaVaultJob) => MediaVaultJob): void {
		let updated = false;
		this.jobs = this.jobs.map((job) => {
			if (job.id !== jobId) {
				return job;
			}
			updated = true;
			return updater(job);
		});
		if (updated) {
			this.notify();
		}
	}

	private pruneHistory(): void {
		if (this.jobs.length <= MAX_JOB_HISTORY) {
			return;
		}
		this.jobs = this.jobs.slice(0, MAX_JOB_HISTORY);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

function createJobId(type: MediaVaultJobType, now: number): string {
	return `${type}-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampProgress(value: number, total: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(Math.max(0, Math.round(value)), Math.max(1, total));
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
