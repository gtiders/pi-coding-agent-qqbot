export interface FakeSessionManagerRecord {
	kind: "memory" | "recent" | "new";
	cwd: string;
	sessionDir?: string;
}

export interface FakeSdkOptions {
	servicesGate?: Promise<void>;
	failBindCount?: number;
}

export interface FakeSdkState {
	abortCalls: number;
	bindCalls: number;
	definedTools: unknown[];
	filteredExtensions: Array<{ path?: string; resolvedPath?: string }>;
	hostExtensionSettings: string[];
	promptCalls: Array<{ prompt: string; options: unknown }>;
	runtimeDisposeCalls: number;
	runtimesCreated: number;
	sessionDisposeCalls: number;
	sessionManagers: FakeSessionManagerRecord[];
}

interface FakeSessionManager {
	appendSessionInfo(name: string): void;
	getEntries(): Array<{ type: string }>;
	getSessionName(): string | undefined;
}

interface FakeSession {
	abort(): Promise<void>;
	bindExtensions(options: object): Promise<void>;
	dispose(): void;
	isStreaming: boolean;
	model: { provider: string; id: string; name: string; input: string[]; reasoning: boolean };
	prompt(prompt: string, options: unknown): Promise<void>;
	sessionId: string;
	sessionManager: FakeSessionManager;
	subscribe(observer: (event: unknown) => void): () => void;
}

export function createFakePiSdk(options: FakeSdkOptions = {}): { sdk: Record<string, unknown>; state: FakeSdkState } {
	let failBindCount = options.failBindCount ?? 0;
	let nextSessionId = 1;
	const state: FakeSdkState = {
		abortCalls: 0,
		bindCalls: 0,
		definedTools: [],
		filteredExtensions: [],
		hostExtensionSettings: [],
		promptCalls: [],
		runtimeDisposeCalls: 0,
		runtimesCreated: 0,
		sessionDisposeCalls: 0,
		sessionManagers: [],
	};

	function createManager(kind: FakeSessionManagerRecord["kind"], cwd: string, sessionDir?: string): FakeSessionManager {
		state.sessionManagers.push({ kind, cwd, ...(sessionDir ? { sessionDir } : {}) });
		let name: string | undefined;
		return {
			appendSessionInfo(value: string) {
				name = value;
			},
			getEntries: () => [],
			getSessionName: () => name,
		};
	}

	function createSession(sessionManager: FakeSessionManager): FakeSession {
		const observers = new Set<(event: unknown) => void>();
		const session: FakeSession = {
			async abort() {
				state.abortCalls++;
			},
			async bindExtensions() {
				state.bindCalls++;
				if (failBindCount > 0) {
					failBindCount--;
					throw new Error("fake extension bind failure");
				}
			},
			dispose() {
				state.sessionDisposeCalls++;
			},
			isStreaming: false,
			model: { provider: "fake", id: "fake-model", name: "Fake Model", input: ["text", "image"], reasoning: true },
			async prompt(prompt: string, promptOptions: unknown) {
				state.promptCalls.push({ prompt, options: promptOptions });
				session.isStreaming = true;
				for (const observer of observers) observer({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
				for (const observer of observers) observer({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
				for (const observer of observers) observer({ type: "message_update", assistantMessageEvent: { type: "text_end" } });
				for (const observer of observers) observer({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a.txt" } });
				for (const observer of observers) observer({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false });
				for (const observer of observers) observer({
					type: "agent_end",
					messages: [{ role: "assistant", content: [{ type: "text", text: "hello world" }] }],
				});
				session.isStreaming = false;
			},
			sessionId: `fake-session-${nextSessionId++}`,
			sessionManager,
			subscribe(observer: (event: unknown) => void) {
				observers.add(observer);
				return () => observers.delete(observer);
			},
		};
		return session;
	}

	const sdk = {
		SessionManager: {
			continueRecent(cwd: string, sessionDir: string) {
				return createManager("recent", cwd, sessionDir);
			},
			create(cwd: string, sessionDir: string) {
				return createManager("new", cwd, sessionDir);
			},
			inMemory(cwd: string) {
				return createManager("memory", cwd);
			},
			async list() {
				return [];
			},
		},
		SettingsManager: {
			create() {
				return {
					getGlobalSettings: () => ({ extensions: ["host-extension"] }),
				};
			},
			inMemory(settings: { extensions?: string[] }) {
				state.hostExtensionSettings = settings.extensions ?? [];
				return settings;
			},
		},
		async createAgentSessionServices(serviceOptions: {
			resourceLoaderOptions?: {
				extensionsOverride?: (base: {
					extensions: Array<{ path?: string; resolvedPath?: string }>;
					errors: Array<{ path: string; error: string }>;
					runtime: unknown;
				}) => { extensions: Array<{ path?: string; resolvedPath?: string }> };
			};
		}) {
			await options.servicesGate;
			const base = {
				extensions: [
					{ path: "C:/extensions/keep/index.ts" },
					{ path: "C:/extensions/pi-agent-qqbot/src/index.ts" },
					{ resolvedPath: "C:\\extensions\\pi-agent-qqbot\\index.ts" },
				],
				errors: [],
				runtime: {},
			};
			state.filteredExtensions = serviceOptions.resourceLoaderOptions?.extensionsOverride?.(base).extensions ?? base.extensions;
			return {
				diagnostics: [],
				modelRegistry: {
					find: () => undefined,
					getAvailable: () => [],
				},
			};
		},
		async createAgentSessionFromServices(createOptions: { services: unknown; sessionManager: FakeSessionManager }) {
			return { session: createSession(createOptions.sessionManager) };
		},
		async createAgentSessionRuntime(
			factory: (factoryOptions: {
				cwd: string;
				agentDir: string;
				sessionManager: FakeSessionManager;
			}) => Promise<{ session: FakeSession; services: unknown; diagnostics: unknown }>,
			runtimeOptions: { cwd: string; agentDir: string; sessionManager: FakeSessionManager },
		) {
			const created = await factory(runtimeOptions);
			state.runtimesCreated++;
			return {
				...created,
				setRebindSession() {},
				async dispose() {
					state.runtimeDisposeCalls++;
					created.session.dispose();
				},
			};
		},
		defineTool(tool: unknown) {
			state.definedTools.push(tool);
			return tool;
		},
		getAgentDir: () => "C:/fake-agent",
		resizeImage: async () => null,
	};
	return { sdk, state };
}
