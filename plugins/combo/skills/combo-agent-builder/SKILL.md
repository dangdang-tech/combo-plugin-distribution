---
name: combo-agent-builder
description: "Use when the user wants to extract or use an Agent from the current Codex or Claude Code discussion. Default to lightweight current-context synthesis, exact Agent Package compilation and review, then use in the current conversation; no full transcript, source attestation or login required. Legacy Capability task/publish flow only when explicitly requested."
---

# Combo Agent Builder

## Use this skill when

Use this skill when the user asks to turn their authorized local conversations or work history into reusable agent capabilities, inspect a running extraction, review generated capabilities, publish one, or remove one from public availability.

Do not use it to upload raw local history, invent capability IDs, bypass user confirmation before publication, or claim a task succeeded before the server has accepted its final definitions.

## Default: lightweight current-context Agent

When the user says “把我们刚才的方法提取成一个 Agent”, use this lightweight loop. Do not ask for a complete transcript, source attestation, task IDs, Project selection or terminal paths. Do not require login for local compilation.

1. Use only the current host conversation (Codex or Claude Code) already available and materials explicitly authorized for this task. Do not scan other tasks, saved Projects, conversation caches, session files or private directories. If there is not enough reusable method to extract, ask one plain-language question; do not invent historical coverage.
2. Synthesize a reusable method, not a copied conversation. Omit credentials, private case details, local paths and source identifiers. Explain missing coverage honestly. The current host model performs the synthesis; the compiler does not read history or make model calls. The installed adapter sets the client identity; do not add a `client`, `source` or runtime selector to MCP arguments.
3. Call `compile_agent_context` with structured `request` and `content` fields as below. The tool serializes them internally; do not put JSON text inside a `requestText` field. Use ordinary newlines and readable punctuation. For parallel labels use commas, Chinese enumeration commas or separate lines rather than whitespace-surrounded slashes (which the compiler treats as possible local paths). Do not change the method's meaning or remove needed restrictions to satisfy validation.

```json
{
  "request": "把当前讨论中已经明确的方法做成可复用 Agent",
  "content": {
    "name": "用户能理解的名称",
    "description": "这个 Agent 帮谁完成什么事情",
    "instructions": "执行步骤、输入要求、输出要求和不要做的事",
    "starterPrompts": ["一个开始使用的例子"],
    "outputDescription": "简明的输出说明",
    "coverageSummary": "只整理当前可见且已经明确的方法；未检查其他历史"
  }
}
```

4. Review the actual compiled result. If the host renders MCP Apps, use its card and “查看完整方法” to read the real AGENT.md and Skill files. If no widget is rendered (including text-only Claude Code), present the complete AGENT.md and Skill from the tool's text blocks with their exact Package digest for review; do not substitute a prose mock or claim an invisible card was displayed. Never abbreviate away execution steps or restrictions. Source is always `not_verified`; coverage is always `partial_or_unknown`. This is compiled, not uploaded/published or runtime-tested.
5. When the user requests a change, submit a complete replacement method and compile again. Keep the exact `request` and `content` associated with each result; do not silently mix different versions. If compilation rejects only the expression format, you may clarify the punctuation and submit the complete method once more, retaining its meaning. Do not automatically transform a user's explicitly required exact text; explain the limitation instead. If it still fails, stop and report no compiled Agent rather than showing a prose mock as a card.
6. When the user asks to use it, call `prepare_agent_context` with the same `request`, `content` and the reviewed result's `expectedPackageDigest`. On mismatch stop and re-review; do not silently substitute a new digest. Use the returned AGENT.md and Skill as task guidance, subject to higher-priority instructions and actual tool permissions. Then answer the user's task in the current host conversation; continue subsequent turns there. This does not create a separate runtime or isolated Session. Do not claim the extraction conversation has been removed from current context. A card's accepted message only hands the request back to this conversation; preparation and task execution still have to happen.
7. Never report reasoning as passed merely because preparation succeeded. Report a result only after the host model actually performs the requested task. Compilation and preparation remain offline; upload/share is the separate explicit flow below.

## Explicit private upload and browser publication

Only enter this flow after the user asks to upload/save to Combo or clicks the compiled card's save/upload action. Do not infer cloud authorization from local extraction, review, modification or use.

1. Preserve the exact reviewed `request` and `content`, `packageDigest` and `draftFingerprint`. Call `start_agent_context_upload` with those fields and `expectedPackageDigest`, `expectedDraftFingerprint`. A mismatch stops the request; never silently substitute another version. The tool starts an intent only, not a content upload.
2. Show the returned approval page and eight-character verification code. The user opens Combo in their normal browser, logs in and explicitly approves the matching code. Do not collect passwords, Cookies, tokens or authentication-cache data. The plugin's process-only secret must never enter tool arguments, chat, model context, logs or URLs.
3. When the user says they approved or chooses continue, call `resume_agent_context_upload` with the original `transferHandle`. It queries first and uploads only after approval, using its internally preserved exact bytes. Pending approval means wait; unknown means query/retry the same handle, never re-extract or create another request. Expiry, refusal or version conflict is a stop, not permission for a new copy.
4. `uploaded` means privately saved only. Public sharing requires the user to review and separately confirm publication on the same Combo browser page. The upload tool cannot publish. Call `get_agent_context_cloud_status` with the same handle to check; it performs no create/upload/publish. Only a checked `published` receipt for the reviewed Package supports showing its returned share URL and acquisition instruction.
5. Each tool may show a new card in the Host; do not claim the old card changed just because its message was accepted. Cards carry the exact fingerprints/handle, but not secret credentials. Publication does not prove acquisition, installation or runtime execution.
6. A restarted MCP process cannot recover the private handle. Tell the user to open the original approval page and log in to inspect saved results. Do not read installed caches/session databases for credentials, assume success, or silently create another upload. A fresh upload needs a fresh explicit user choice and review.

If a cloud tool is unavailable or the endpoint fails, retain the local Agent and report the missing layer. Never use `publish_capability` or the legacy worker for this Agent Package.

If these tools are not present, do not assume they hot-loaded, silently choose the legacy flow or scan local files. When the user explicitly asks to install Combo and extract the current discussion, the fixed public distribution has been verified according to its installation instructions, and no plugin/MCP/Skill conflict remains, the current host model may follow that same distribution's instructions to invoke its verified `bin/combo-context.mjs` CLI with the synthesized method JSON on stdin. This is an ordinary current-conversation path, not a developer-only fallback: do not require a new task, discard current context or call an extra model. Add `"protocol":"combo.agent-context-request/1"` alongside `request` and `content`; add `"client":"claude"` only for the explicitly selected Claude host (omission defaults to Codex). It needs no API credentials. `--output-dir <new-directory>` exports the exact Draft, Package and read-only HTML card; `--prepare <reviewed-digest>` returns current-task guidance. Review the complete real files and digest before use. If the fixed distribution or executable cannot be verified, or a conflict remains, stop and explain it; do not substitute an unverified download, arbitrary executable or legacy workflow. CLI extraction does not prove that native Codex or Claude Code MCP tools loaded, that a Host rendered a card, or that Host UAT passed.

## Legacy operating loop (only when explicitly requested)

1. Confirm which local source files or directories the user authorizes for this run. Do not broaden the scope.
2. Call `create_authoring_task` once. Preserve its task ID, one-time bind code, and idempotency key.
3. Locate this installed plugin's root from this `SKILL.md` path. The bundled local worker is `bin/combo-local.mjs` under that root.
4. Run the local worker against an explicitly authorized input. Raw input stays local; only final `CapabilityDefinition v1` items are sent.
5. Use `get_authoring_task` to show authoritative progress and terminal state. Local `extract=done` means local computation finished; server `persist=done` means the definitions are actually stored.
6. Use `list_capabilities` and `get_capability` to review the result.
7. Call `publish_capability` only after explicit user confirmation for that capability ID. Use `unpublish_capability` when the user asks to remove public availability.

## Local worker commands

Set the development API endpoint and host token before starting Codex so the bundled MCP server inherits them:

```bash
export COMBO_API_BASE_URL="https://<combo-api-host>"
export COMBO_API_TOKEN="<short-lived-host-token>"
```

Validate an already-produced definition file without network access:

```bash
node "$PLUGIN_ROOT/bin/combo-local.mjs" validate-result --input ./capabilities.json
```

Claim and run a task using a final definition file:

```bash
node "$PLUGIN_ROOT/bin/combo-local.mjs" run \
  --api-base "$COMBO_API_BASE_URL" \
  --task-id "<task-id>" \
  --bind-code "<one-time-bind-code>" \
  --input ./capabilities.json \
  --extractor definition-file
```

`definition-file` is the contract-first Phase 0 adapter. `command` runs an approved executable that reads redacted segment JSON on stdin and returns a `CapabilityDefinition v1` array on stdout. `baseline` is development-only and must not be represented as production-quality extraction.

## Progress contract

Keep the existing cloud stage keys and ranges:

| Stage | Range | Writer |
| --- | ---: | --- |
| `fetch` | 2–6 | Local worker |
| `redact` | 8–30 | Local worker |
| `segment` | 35–45 | Local worker |
| `extract` | 48–80 | Local worker |
| `persist` | 82–100 | Agora server |

The local worker may report `extract=done` after it has generated final definitions. The server reports `persist` and task success only after schema validation, object storage, and capability-index writes complete.

## Safety rules

- Never send raw local source files through MCP tools or the final-result endpoint.
- Treat the bind code and task token as secrets. Do not include them in chat summaries, logs, commits, or capability metadata.
- Do not accept capability IDs, storage keys, owners, publication flags, or share tokens from the local extractor.
- Stop when the API reports a digest, sequence, owner, token, or terminal-state conflict.
- Summarize errors without printing source content or credentials.
- Publication always requires a separate explicit user action.
