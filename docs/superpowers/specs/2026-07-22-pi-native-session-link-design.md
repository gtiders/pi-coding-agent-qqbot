# Pi Native Session Link Design

Date: 2026-07-22
Status: Approved for implementation planning
Package: `pi-agent-qqbot`
Pi SDK baseline: `@earendil-works/pi-coding-agent` 0.81.1
Rollback point: `pre-native-session-link-20260722` (`34bf6fe`)

## 1. Purpose

Replace the independent QQ Agent session architecture with a single-user C2C bridge into the currently active native Pi session.

A QQ message must behave like another person typing into the same Pi runtime. The extension must not create or persist a second Agent session, working directory, model state, or conversation history for QQ.

## 2. Design Principles

### 2.1 Minimum viable behavior

Implement only the behavior required for one person to operate one active Pi runtime from one QQ C2C conversation.

Do not add multi-user routing, group support, multiple concurrent Pi runtime endpoints, a background message broker, pairing codes, or automatic startup.

### 2.2 Native Pi integration

Use Pi's current session, context, model, tools, working directory, and session lifecycle. QQ-originated ordinary messages enter through Pi's native extension input API. QQ-originated Pi control commands invoke native Pi session actions.

Do not create an independent `AgentSessionRuntime` or QQ-specific session storage.

### 2.3 Maintainable state boundaries

Model these concerns separately:

- Gateway transport: whether the QQ network connection is running.
- Logical link: whether the configured QQ C2C conversation is bound to this Pi runtime.
- Active Pi session: the session currently selected in that runtime.
- Turn origin: whether the current Agent run began from QQ or the terminal.

A command that changes one concern must not implicitly destroy another unless the lifecycle table explicitly requires it.

### 2.4 Necessary tests only

Test required behavior and important ownership boundaries. Do not build a combinatorial matrix for every message ordering, network timing, malformed payload, or unsupported multi-user scenario.

Delete tests whose only purpose was the removed independent QQ session architecture. Keep existing transport, media, platform, packaging, and identity tests where the behavior remains in scope.

### 2.5 Pi core change approval

The implementation must use the public Pi 0.81.1 extension contract by default.

If any required behavior would need a change to `@earendil-works/pi-coding-agent` internals, a patch to installed Pi files, or reliance on a non-public Pi API, implementation must stop at that boundary. The implementer must explain the missing public capability, the proposed Pi-side change, its compatibility impact, and available alternatives, then wait for explicit approval before modifying Pi core.

## 3. Scope

### 3.1 In scope

- One QQ Bot `appId`.
- Exactly one allowed QQ user OpenID.
- C2C messages only.
- One active logical QQ link per Pi runtime.
- Manual Gateway startup through local `/qqbot-start`.
- Gateway stop/start without losing the in-process logical link.
- Native Pi session transitions through terminal or supported QQ commands.
- Source-aware reply routing.
- Local-only link, unlink, stop, start, and takeover controls.
- A minimal single-owner mechanism for transferring Gateway ownership to another Pi process.

### 3.2 Out of scope

- Multiple allowed users.
- QQ groups or channels.
- Multiple QQ conversations linked concurrently.
- Multiple Pi runtimes concurrently serving different QQ conversations.
- Persistent logical links across Pi process exit.
- Automatic QQ startup.
- QQ-initiated Gateway control or ownership takeover.
- Full cross-process message broker behavior.
- Pairing or verification codes.
- Guaranteed replay of QQ messages received while the Gateway is stopped.

## 4. Identity and Access

One `appId` identifies one QQ Bot. The QQ Gateway may technically receive events from multiple users or groups, but this package accepts only one configured C2C user.

The effective conversation identity is:

```text
(appId, "c2c", allowUsers[0])
```

Configuration validation must require:

- `appId` is present.
- `clientSecret` is present.
- `allowUsers` contains exactly one non-empty OpenID.
- `allowGroups` is empty.
- Group command handling is disabled.

Messages from any other user or any group must not enter Pi. They may be ignored or receive a fixed unauthorized response according to existing transport policy, but they must not create state, request access, or invoke Agent work.

Because the conversation is uniquely derived from configuration, `/qqbot-link` takes no pairing code and does not need the QQ user to respond to a challenge.

## 5. State Model

The process-level runtime owns the following state:

```ts
type GatewayState = "stopped" | "starting" | "running" | "stopping" | "failed";

type LogicalLink = {
  appId: string;
  userOpenId: string;
  runtimeId: string;
  currentSessionId: string;
  currentSessionFile?: string;
  generation: number;
  linkedAt: number;
};
```

`runtimeId` identifies the current Pi process/runtime instance. `currentSessionId` and `currentSessionFile` are updated whenever Pi changes its active session. They do not define ownership by themselves.

The useful combinations are:

| Gateway | Link | Meaning |
| --- | --- | --- |
| stopped | absent | QQ is inactive and unbound |
| running | absent | Gateway is connected but QQ is not yet attached to Pi |
| running | present | QQ is connected to the current Pi session |
| stopped | present | QQ transport is paused; the in-process binding is retained |

## 6. Lifecycle

### 6.1 Pi startup

Loading the extension must never start the QQ Gateway. The extension may validate configuration and register commands and lifecycle handlers, but it must not authenticate, open a socket, or reconnect automatically.

The old automatic startup path and `startup.mode = "auto"` behavior are removed. Manual startup is a fixed product rule, not a configurable preference.

### 6.2 `/qqbot-start`

This local terminal command:

1. Captures the current command-capable Pi context.
2. Validates the single-user C2C configuration.
3. Acquires or takes over Gateway ownership according to the configured conflict policy.
4. Starts the Gateway if it is stopped.
5. Reuses an existing in-process logical link if one exists.
6. Leaves the runtime unlinked if this process has never executed `/qqbot-link` and did not receive a link through takeover.

It never asks the QQ user for a code.

### 6.3 `/qqbot-link`

This local terminal command binds the sole configured C2C conversation to the current Pi runtime and active session.

It takes no user ID or pairing code because configuration already contains exactly one allowed user. Repeating it for the same runtime and conversation is idempotent.

The first implementation requires the Gateway to be running before link, keeping the state transition surface small.

### 6.4 `/qqbot-stop`

This local terminal command stops only the Gateway transport.

It must retain:

- The current Pi session.
- The logical QQ link.
- The runtime ownership record needed to resume or transfer that link.

A later `/qqbot-start` in the same Pi process reconnects the Gateway and resumes the existing logical link without another `/qqbot-link`.

Messages sent while the Gateway is stopped may be missed. No replay guarantee is provided.

### 6.5 `/qqbot-unlink`

This local terminal command clears the logical link and increments its generation so that stale asynchronous QQ-originated work cannot send a reply.

It does not have to stop the Gateway. A running but unlinked Gateway may remain available for a later local `/qqbot-link`.

### 6.6 Pi session transitions

`/new`, `/resume`, `/fork`, and native session switching do not release the logical link.

When Pi emits the replacement lifecycle events, the extension updates the link's `currentSessionId` and `currentSessionFile`. The Gateway remains unchanged.

This applies regardless of whether the transition was initiated from the terminal or through an allowed QQ command.

### 6.7 Process exit

A real Pi process exit stops the Gateway, releases process ownership, and clears the logical link. Reopening Pi requires manual `/qqbot-start` and `/qqbot-link` unless a live owner explicitly transfers a link during takeover.

## 7. Pi Command Bridge

Pi 0.81.1 implements `ExtensionAPI.sendUserMessage()` by calling the Agent prompt path with command expansion disabled. Injecting the text `/new` would therefore send it to the model instead of invoking Pi's slash command.

The mandatory local `/qqbot-start` command supplies an `ExtensionCommandContext`. The extension creates a narrow command bridge from that context containing only the native actions required by supported QQ commands.

```ts
type PiCommandBridge = {
  newSession(name?: string): Promise<void>;
  listSessions(query?: string): Promise<ReadonlyArray<NativeSessionInfo>>;
  resumeSession(selector: string): Promise<void>;
  setSessionName(name: string): void;
  compact(instructions?: string): Promise<void>;
  setModel(selector: string): Promise<void>;
  setThinking(level?: string): void;
  stopCurrentTurn(): void;
};
```

The bridge does not expose arbitrary terminal commands, shell execution, Gateway controls, or extension takeover. It maps the existing QQ session commands to Pi's native session manager and current runtime instead of maintaining QQ-owned session metadata.

The MVP keeps the existing remote command semantics for `/new`, `/sessions`, `/resume`, `/name`, `/compact`, `/model`, `/thinking`, `/stop`, `/status`, and `/help`. QQ `/fork` is not added because it was not an existing remote command and is not required for the single-user MVP. Terminal `/fork` remains a native Pi lifecycle transition and the logical link follows it.

Session replacement actions use Pi's `withSession` callback where available to refresh the active context immediately after replacement. Normal `session_start` events remain the source of truth for the current session identity.

The implementation plan must begin with a focused integration spike proving that a command context captured by local `/qqbot-start` remains valid for deferred QQ `/new`, `/resume`, and `/name` invocation and after one native session replacement. This spike is necessary because Pi documents session actions as command-context-only. It must not introduce another Agent session as a workaround.

If that public Pi contract cannot support deferred invocation, implementation stops for an API decision rather than restoring the independent QQ session architecture.

## 8. QQ Command Policy

### 8.1 Allowed from QQ

The MVP supports these existing commands against the current native Pi runtime:

- `/new [name]`
- `/sessions [query]`
- `/resume <short-id|name>`
- `/name <name>`
- `/compact [instructions]`
- `/model [query|provider/model]`
- `/thinking [level]`
- `/stop`
- `/status`
- `/help`

The QQ command surface remains an explicit allowlist. Interactive commands use QQ Keyboard cards instead of terminal TUI components: `/help` provides the command menu, `/model` provides paginated model selection, `/thinking` provides level selection, and session listing provides `/resume` actions. Every button submits an allowlisted slash command back through the same parser and authorization path; button payloads never bypass command policy.

### 8.2 Local terminal only

These controls must never be accepted from QQ:

- `/qqbot-start`
- `/qqbot-stop`
- `/qqbot-link`
- `/qqbot-unlink`
- `/qqbot-takeover`
- Access approval or configuration mutation

A QQ message matching a local-only command receives a fixed denial and performs no action.

## 9. Ordinary Message Flow

### 9.1 QQ-originated input

1. Validate app identity, C2C scene, user OpenID, active link, and generation.
2. Convert text and supported attachments using existing normalization and media policies.
3. Mark the input as QQ-originated before injection.
4. Call Pi's native `sendUserMessage()`.
5. If Pi is busy, enqueue with `deliverAs: "followUp"`; do not steer an active terminal turn.
6. Let Pi render the user message, tool activity, streaming assistant output, and final reply in the terminal.
7. When the Agent run settles, send the final assistant reply and supported outbound media to QQ only if the origin and generation still match.

### 9.2 Terminal-originated input

Pi handles terminal input normally. The extension observes that the input source is interactive and marks that Agent run as terminal-originated.

The assistant output remains visible in the terminal and is never mirrored to QQ.

### 9.3 Origin correlation

Pi's input event distinguishes `interactive`, `rpc`, and `extension`, but another extension could also submit extension input. This package therefore keeps a small FIFO of its own pending QQ injections rather than treating every `source = "extension"` event as QQ.

Each accepted Agent run receives one origin record:

```ts
type TurnOrigin =
  | { source: "terminal" }
  | { source: "qq"; generation: number; messageId: string };
```

The origin is consumed when the corresponding Agent run settles. Only a matching QQ origin can produce an outbound QQ reply.

## 10. Concurrent Input

The current Pi runtime remains the sole serializer of Agent work.

- QQ arriving while Pi is idle starts a native Agent run.
- QQ arriving while Pi is busy is queued as a follow-up.
- Terminal input remains under Pi's native steering/follow-up behavior.
- Reply routing follows the origin of each accepted Agent run, not the fact that a link exists.

The MVP does not attempt to merge, reorder, or fairly schedule terminal and QQ traffic beyond Pi's native queue behavior.

## 11. Ownership and Takeover

Only a local Pi process may request Gateway takeover. QQ cannot initiate or approve takeover.

Configuration exposes:

```json
{
  "link": {
    "conflictPolicy": "ask"
  },
  "outboundMedia": {
    "enabled": false,
    "deniedRoots": []
  }
}
```

Supported values:

- `ask`: the claiming Pi asks its local user for confirmation.
- `takeover`: the claiming Pi proceeds immediately after a local `/qqbot-start`.

The old Pi process never needs human approval. A minimal local ownership channel tells the live old owner to stop its Gateway and invalidate its link. The old process returns transferable link identity only when app identity and single allowed user match. The new process increments generation before starting its Gateway.

The ownership mechanism consists only of:

- An owner record scoped by app ID.
- Process ID and random owner nonce.
- A loopback/local control endpoint for release and handoff.
- Stale owner detection when the process no longer exists.

It is not a message broker and does not route ordinary QQ messages between Pi processes.

If a live owner is unresponsive, the new process fails safely with a clear error. It does not terminate the old Pi process. A dead owner's record may be reclaimed.

## 12. Configuration Direction

The effective MVP configuration is:

```json
{
  "enabled": true,
  "appId": "...",
  "clientSecret": "...",
  "allowUsers": ["one-user-openid"],
  "allowGroups": [],
  "commands": {
    "allowInGroups": false
  },
  "link": {
    "conflictPolicy": "ask"
  }
}
```

Independent session fields such as mode, scope, restore, resident capacity, and idle disposal are removed from the domain model because QQ no longer owns sessions.

Automatic startup settings are removed from behavior. Unknown legacy fields may be ignored by the config reader, but no code path may use them to auto-start QQ or create QQ session storage.

Outbound local-file paths use a denylist after the outbound feature and sender checks pass. An empty `deniedRoots` allows every regular file readable by the Pi process. A candidate is rejected when its canonical real path is equal to or below a canonical denied root. Symlink/junction resolution, hard-link rejection, open-handle identity checks, rename-race checks, size limits, and reply-budget limits remain mandatory. Legacy `allowedRoots` is ignored by schema 4 and must never be interpreted as a denylist.

## 13. Error Behavior

- Invalid single-user configuration: `/qqbot-start` fails locally before network access.
- Unauthorized or group message: silently ignore the message; no Agent work or access-request state is created.
- Gateway stopped: no Agent work is created; no replay promise is made.
- Gateway running but unlinked: send the sole allowed user a fixed message telling them to ask the local operator to run `/qqbot-link`; no Agent work is created.
- Pi busy: QQ input becomes a follow-up unless queue capacity is reached.
- Queue full: return a fixed busy response.
- Session replacement failure: retain the current link and current native Pi session.
- Link generation mismatch: suppress the QQ reply while retaining native terminal output.
- Takeover failure: leave the old owner untouched and report the failure locally.

## 14. Code Removal Direction

The implementation is expected to delete or collapse:

- `QQAgentSession` and its fake SDK.
- `ConversationRegistry` and QQ session directories.
- Dynamic SDK loading used only to create independent sessions.
- Session eviction, restore, and resident-capacity behavior.
- QQ-owned model and session state that duplicates the current Pi runtime.
- Terminal observer output that duplicates Pi's native rendering.

Existing QQ authentication, Gateway, API, inbound normalization, outbound formatting, media, access filtering, and package/platform boundaries remain unless the native bridge makes a specific adapter obsolete.

## 15. Test Strategy

Add focused tests for these required behaviors:

1. Configuration accepts exactly one C2C user and rejects zero, multiple users, and groups.
2. Loading Pi never starts QQ; local `/qqbot-start` is required.
3. `/qqbot-start -> /qqbot-link -> /qqbot-stop -> /qqbot-start` retains the logical link and current session.
4. Terminal and QQ `/new` both move the link to the replacement native session.
5. A QQ-originated Agent reply is visible through Pi's native events and sent to QQ.
6. A terminal-originated Agent reply is not sent to QQ.
7. `/qqbot-unlink` and generation changes suppress stale outbound replies.
8. Local `ask` and direct `takeover` transfer ownership without QQ approval.
9. The command-context bridge can invoke native `/new` after deferred QQ input.

Do not add exhaustive tests for unsupported users, all network race permutations, all command selectors, or multi-process message routing. Use one representative failure test for each important boundary.

Verification before completion remains:

```text
npm run verify
npm run test:package
npm run smoke:pi -- .
```

A real QQ manual smoke verifies start, link, ordinary prompt, terminal-only prompt routing, QQ `/new`, stop/start continuity, and unlink.

## 16. Acceptance Criteria

The phase is complete when:

- Pi startup performs no QQ network work.
- A local user can start and link the sole configured QQ C2C conversation.
- QQ ordinary messages enter the current native Pi session.
- QQ `/new` changes the same native Pi runtime to a new session and the link follows it.
- Terminal `/new` also preserves the link.
- QQ-originated replies appear in terminal and QQ.
- Terminal-originated replies never appear in QQ.
- Stop/start in one Pi process preserves the logical link and current active session.
- Unlink or process exit clears the logical link.
- Another local Pi can take over according to `ask` or `takeover` without QQ approval.
- No independent QQ Agent session, QQ session directory, or QQ session registry remains.
- Focused required tests and package/Pi smoke checks pass.
