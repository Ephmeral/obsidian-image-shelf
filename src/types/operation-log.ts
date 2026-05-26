export type OperationLogType = "move" | "rename" | "delete" | "batch-update" | "convert";
export type OperationLogStatus = "planned" | "committed" | "rolled-back" | "failed";
export type OperationStepStatus = "planned" | "committed" | "failed";

export interface OperationStep {
	id: string;
	action: string;
	status: OperationStepStatus;
	createdAt: number;
	details: Record<string, unknown>;
}

export interface OperationError {
	createdAt: number;
	message: string;
	details?: Record<string, unknown>;
}

export interface OperationLog {
	id: string;
	type: OperationLogType;
	status: OperationLogStatus;
	createdAt: number;
	updatedAt: number;
	dryRun: Record<string, unknown>;
	steps: OperationStep[];
	rollbackSteps: OperationStep[];
	errors: OperationError[];
}
