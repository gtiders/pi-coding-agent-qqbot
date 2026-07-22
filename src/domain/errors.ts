export class DomainError extends Error {
	constructor(readonly code: string, readonly safeMessage: string, readonly cause?: unknown) {
		super(safeMessage);
		this.name = "DomainError";
	}
}
