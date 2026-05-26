import {normalizePath, type Plugin} from "obsidian";
import type {OperationLog, OperationLogType, OperationStep} from "../types/operation-log";

interface StepInput {
	action: string;
	details: Record<string, unknown>;
}

export class TransactionLogService {
	private readonly plugin: Plugin;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	async create(type: OperationLogType, dryRun: Record<string, unknown>, rollbackSteps: OperationStep[] = []): Promise<OperationLog> {
		const now = Date.now();
		const log: OperationLog = {
			id: `${new Date(now).toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${type}-${randomId()}`,
			type,
			status: "planned",
			createdAt: now,
			updatedAt: now,
			dryRun,
			steps: [],
			rollbackSteps,
			errors: [],
		};
		await this.write(log);
		return log;
	}

	async appendStep(log: OperationLog, input: StepInput): Promise<void> {
		log.steps.push(createStep(input.action, "committed", input.details));
		log.updatedAt = Date.now();
		await this.write(log);
	}

	async appendRollbackStep(log: OperationLog, input: StepInput): Promise<void> {
		log.rollbackSteps.push(createStep(input.action, "planned", input.details));
		log.updatedAt = Date.now();
		await this.write(log);
	}

	async commit(log: OperationLog): Promise<void> {
		log.status = "committed";
		log.updatedAt = Date.now();
		await this.write(log);
	}

	async fail(log: OperationLog, message: string, details?: Record<string, unknown>): Promise<void> {
		log.status = "failed";
		log.errors.push({
			createdAt: Date.now(),
			message,
			details,
		});
		log.updatedAt = Date.now();
		await this.write(log);
	}

	getPath(log: OperationLog): string {
		return normalizePath(`${this.getLogDirectory()}/${log.id}.json`);
	}

	private async write(log: OperationLog): Promise<void> {
		const directory = this.getLogDirectory();
		await this.ensureFolder(directory);
		await this.plugin.app.vault.adapter.write(this.getPath(log), `${JSON.stringify(log, null, 2)}\n`);
	}

	private getLogDirectory(): string {
		const pluginDir = this.plugin.manifest.dir ?? `.obsidian/plugins/${this.plugin.manifest.id}`;
		return normalizePath(`${pluginDir}/transactions`);
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const parts = normalizePath(folderPath).split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const stat = await this.plugin.app.vault.adapter.stat(current);
			if (!stat) {
				await this.plugin.app.vault.adapter.mkdir(current);
			}
		}
	}
}

function createStep(action: string, status: OperationStep["status"], details: Record<string, unknown>): OperationStep {
	return {
		id: `step-${Date.now()}-${randomId()}`,
		action,
		status,
		createdAt: Date.now(),
		details,
	};
}

function randomId(): string {
	return Math.random().toString(36).slice(2, 8);
}
