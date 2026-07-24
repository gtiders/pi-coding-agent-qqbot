# QQ Bot Schema 5 Configuration Design

Date: 2026-07-23
Status: Approved and implemented
Package baseline: `pi-agent-qqbot` 0.7.0

## Principles

- Persist only user identity, environment, conflict policy, deny policies, optional STT, and logging level.
- Omitted or empty deny lists mean that the extension adds no corresponding restriction.
- QQ protocol limits, model capabilities, network behavior, parsing budgets, and layout dimensions are derived at runtime and are not user configuration.
- Commands use a fixed code-level allowlist and QQ Markdown/Keyboard with plain-text fallback.
- Any future requirement to modify Pi core must be explained and approved separately before implementation.

## Schema

```json
{
  "schemaVersion": 5,
  "appId": "app-id",
  "clientSecret": "secret",
  "sandbox": false,
  "ownerOpenId": "user-openid",
  "link": { "conflictPolicy": "ask" },
  "inboundMedia": {
    "deniedKinds": [],
    "deniedExtensions": []
  },
  "outboundMedia": {
    "enabled": true,
    "deniedRoots": [],
    "deniedKinds": [],
    "deniedExtensions": []
  },
  "logging": { "level": "info" }
}
```

`deniedKinds` accepts `image`, `video`, `voice`, and `file`. Extensions are normalized to lower-case values beginning with a dot. An empty `deniedRoots` permits every regular file readable by the Pi process after canonical-path and opened-file identity checks.

## Runtime-Derived Behavior

- Inbound attachment count and bytes are not capped by the extension. Downloads stream to private temporary storage and unknown formats are passed to Pi as local paths and metadata.
- Extracted document text is bounded by the active model's remaining context reported by `ExtensionContext.getContextUsage()`.
- Inbound temporary files live until the corresponding agent turn settles and are then removed.
- Pi's native `deliverAs: "followUp"` queue owns busy-session ordering; the extension has no configurable queue length.
- QQ Keyboard rows, model pages, message chunks, passive reply sequences, and endpoint throttling follow QQ protocol constraints.
- Local outbound files use QQ `upload_prepare`, presigned chunk PUT, `upload_part_finish`, and final `/files` merge. `upload_config` controls concurrency and retry timing.
- QQ rich media uses its documented soft limits and automatically falls back to ordinary files. The platform's 200 MB hard limit remains mandatory.

## Removed Schema 4 Fields

The extension ignores the old enable flag, user/group arrays, command rendering options, reply formatting options, progress options, queue size, media counts, byte totals, parser limits, upload/download timeouts, format allowlists, and redundant private/group/admin switches. Schema 4 identity, deny roots, disabled media kinds, STT, link policy, sandbox selection, and debug logging are migrated in memory where meaningful.

## Security Invariants

HTTPS-only inbound URLs, SSRF protection, redirect bounds, download-stall cancellation, canonical deny-root checks, symlink/junction handling, hard-link rejection, regular-file validation, opened-handle identity checks, and mutation-race detection are implementation invariants. They are not product quotas and cannot be disabled by an empty deny list.
