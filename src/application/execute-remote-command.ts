export interface RemoteCommandInput {
	name: string;
	args: string[];
	rawArgs: string;
}

export type RemoteCommandHandler<TCommand extends RemoteCommandInput = RemoteCommandInput> = (
	command: TCommand,
) => Promise<void> | void;

export type RemoteCommandHandlers<TCommand extends RemoteCommandInput = RemoteCommandInput> = Readonly<
	Record<string, RemoteCommandHandler<TCommand>>
>;

/** Dispatch a parsed remote command without depending on QQ or Pi adapters. */
export async function executeRemoteCommand<TCommand extends RemoteCommandInput>(
	command: TCommand,
	handlers: RemoteCommandHandlers<TCommand>,
): Promise<boolean> {
	const handler = handlers[command.name];
	if (!handler) return false;
	await handler(command);
	return true;
}
