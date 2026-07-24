import type {
	ExtensionUIDialogOptions,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

export interface RemoteUIInteractionHandle<T> {
	result: Promise<T>;
	cancel(): void;
}

export interface RemoteUIInteractionPort {
	openConfirm(title: string, message: string): RemoteUIInteractionHandle<boolean> | undefined;
	openSelect(title: string, options: string[]): RemoteUIInteractionHandle<string | undefined> | undefined;
	openInput(title: string, placeholder?: string): RemoteUIInteractionHandle<string | undefined> | undefined;
}

/** Fan standard Pi dialogs out to TUI and QQ; the first completed side wins. */
export class DualUIBridge {
	private readonly bound = new WeakSet<ExtensionUIContext>();

	constructor(private readonly remote: RemoteUIInteractionPort) {}

	bind(ui: ExtensionUIContext): void {
		if (this.bound.has(ui)) return;
		this.bound.add(ui);

		const originalConfirm = ui.confirm.bind(ui);
		const originalSelect = ui.select.bind(ui);
		const originalInput = ui.input.bind(ui);

		ui.confirm = (title, message, options) => this.race(
			() => this.remote.openConfirm(title, message),
			(raceOptions) => originalConfirm(title, message, raceOptions),
			options,
		);
		ui.select = (title, options, dialogOptions) => this.race(
			() => this.remote.openSelect(title, options),
			(raceOptions) => originalSelect(title, options, raceOptions),
			dialogOptions,
		);
		ui.input = (title, placeholder, options) => this.race(
			() => this.remote.openInput(title, placeholder),
			(raceOptions) => originalInput(title, placeholder, raceOptions),
			options,
		);
	}

	private race<T>(
		openRemote: () => RemoteUIInteractionHandle<T> | undefined,
		runTerminal: (options?: ExtensionUIDialogOptions) => Promise<T>,
		options?: ExtensionUIDialogOptions,
	): Promise<T> {
		if (options?.signal?.aborted) return runTerminal(options);
		const remote = openRemote();
		if (!remote) return runTerminal(options);

		const terminalAbort = new AbortController();
		const terminalOptions = mergeSignal(options, terminalAbort.signal);
		let terminal: Promise<T>;
		try {
			terminal = runTerminal(terminalOptions);
		} catch (error) {
			remote.cancel();
			throw error;
		}

		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const externalSignal = options?.signal;
			const onExternalAbort = () => remote.cancel();
			externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
			const cleanup = () => externalSignal?.removeEventListener("abort", onExternalAbort);

			terminal.then(
				(value) => {
					if (settled) return;
					settled = true;
					cleanup();
					remote.cancel();
					resolve(value);
				},
				(error: unknown) => {
					if (settled) return;
					settled = true;
					cleanup();
					remote.cancel();
					reject(error);
				},
			);
			remote.result.then(
				(value) => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve(value);
					terminalAbort.abort(new Error("QQ completed the Pi interaction"));
				},
				() => undefined,
			);
		});
	}
}

function mergeSignal(
	options: ExtensionUIDialogOptions | undefined,
	localSignal: AbortSignal,
): ExtensionUIDialogOptions {
	return {
		...options,
		signal: options?.signal
			? AbortSignal.any([options.signal, localSignal])
			: localSignal,
	};
}
