export interface PathApi {
	readonly sep: string;
	isAbsolute(path: string): boolean;
	relative(from: string, to: string): string;
	resolve(...paths: string[]): string;
}

export class LocalPathError extends Error {
	constructor(readonly code: "path_invalid") {
		super("Local path is invalid");
		this.name = "LocalPathError";
	}
}

export function normalizeLocalPath(input: string, cwd: string, pathApi: PathApi): string {
	const value = input.trim().replace(/^@(?=.)/, "");
	if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new LocalPathError("path_invalid");
	return pathApi.resolve(pathApi.isAbsolute(value) ? value : pathApi.resolve(cwd, value));
}

export function isWithinRoot(candidate: string, root: string, pathApi: PathApi): boolean {
	const relative = pathApi.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}
