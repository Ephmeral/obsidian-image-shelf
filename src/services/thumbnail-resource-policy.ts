export type ThumbnailResourceVariant = "small" | "large";

export interface ThumbnailResourcePolicyInput {
	variant: ThumbnailResourceVariant;
	cached: string | null;
	cachedSmall?: string | null;
	original: string | null;
	allowOriginalFallback: boolean;
}

export interface ThumbnailResourcePolicyResult {
	resourcePath: string | null;
	requestedVariants: ThumbnailResourceVariant[];
}

export function resolveThumbnailResourcePolicy(input: ThumbnailResourcePolicyInput): ThumbnailResourcePolicyResult {
	if (input.cached) {
		return {
			resourcePath: input.cached,
			requestedVariants: [],
		};
	}

	const requestedVariants: ThumbnailResourceVariant[] = [input.variant];
	if (input.variant === "large" && input.cachedSmall) {
		return {
			resourcePath: input.cachedSmall,
			requestedVariants,
		};
	}

	if (input.variant === "large") {
		requestedVariants.push("small");
	}

	return {
		resourcePath: input.allowOriginalFallback ? input.original : null,
		requestedVariants,
	};
}
