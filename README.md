# LLM Wiki

`@autocut-cli/llm-wiki` builds a local, citation-aware wiki from an explicitly
approved project scope. It can be used directly or by any MCP client, including
AutoCut, Claude Code, Codex, and Hermes.

## Public surface

- CLI: `llm-wiki`
- MCP server: `llm-wiki serve --root <project>`
- MCP transport: stdio
- MCP tools: `wiki_explore` only
- Runtime: Node.js 24 or newer

The management CLI owns initialization, building, provider profiles, and
structured knowledge updates. Agents querying over MCP cannot mutate the wiki.

## Quick start

```sh
npm install --global @autocut-cli/llm-wiki
llm-wiki catalog --root /path/to/project --json
llm-wiki init --root /path/to/project --select README.md --yes --json
llm-wiki provider set wiki-generation \
  --kind anthropic --model YOUR_MODEL_ID
llm-wiki provider set-key wiki-generation --key-stdin
llm-wiki provider use wiki-generation --root /path/to/project
llm-wiki build --root /path/to/project --json
llm-wiki serve --root /path/to/project
```

`provider set-key` accepts the credential only on stdin, never in process
arguments. The default keyring profile persists until a project selects a
different profile. For headless environments, use
`--credential-store env --env-name YOUR_VARIABLE` when creating the profile
instead.

`init` shows only eligible first-level entries and defaults all of them to
selected. Selected directories are traversed recursively. Any path segment that
starts with `.` and every Git-ignored file are excluded.

If Git metadata is present but Git cannot verify the repository scope,
cataloging, status verification, and builds fail closed with
`GIT_SCOPE_UNAVAILABLE`; they never fall back to broader filesystem traversal.
Consent also records whether Git or filesystem filtering was confirmed. If that
strategy later changes, source enumeration stops with `SOURCE_SCOPE_CHANGED`
until the user re-runs `init`. State created before this field existed must
likewise be reconfirmed once (`SOURCE_SCOPE_RECONFIRM_REQUIRED`).
If a build process is interrupted, the next status check reclaims its
dead-owner lock and reports `BUILD_INTERRUPTED`, so rebuilding can resume
automatically. Lock recovery is serialized with a cross-platform process lock,
including recovery from a process that exits during the recovery operation.

Interactive `init` uses a first-level checklist: Up/Down moves, Space toggles,
Enter confirms, and Escape cancels. Non-interactive callers must pass both
`--yes` and one or more explicit `--select` values.

## Local files

The only project file intended for commit is `llm-wiki.json`. Local consent,
credentials references, build state, source proxies, and immutable generations
live under `.llm-wiki/`. In Git projects, `init` adds `/.llm-wiki/` to the
repository-local `.git/info/exclude`; it does not edit the shared `.gitignore`.

Provider secrets are never written to either location. They are read from a
system credential store or an explicitly named environment variable.

## Compiler adapter

Production builds use an exact-pinned reviewed `llm-wiki-compiler` fork.
It adds native `compile({ embeddings: false, systemPolicy })` support and source
deletion reconciliation. Tests inject a deterministic engine.

Semantic retrieval is off by default. When enabled, it uses a private SQLite
derived cache over compiled Wiki pages only; raw source proxies are never the
search corpus. Completed page batches are committed immediately, so a later
provider failure or cancelled build can resume without resending completed
pages. The embedding client supports OpenAI-compatible and Voyage endpoints.

During an incremental build, the remote embedding provider may receive a
strictly length-bounded query containing the topic, source locator, and a short
new-evidence excerpt from the user-confirmed source scope. This query is used
only to recall existing compiled pages and is not added to the searchable
corpus. No automatic secret-pattern redaction is claimed: enabling semantic
retrieval authorizes this bounded query egress to the selected independent
provider.

Semantic mode requires an explicit embedding profile whose name and credential
both differ from the Wiki generation profile and credential. The generation key
is never passed to the embedding client. A successful build records only the
embedding profile, provider kind, model, availability, and a reason code in its
manifest—never a credential.

```sh
llm-wiki provider set wiki-generation \
  --kind openai-compatible --model generation-model \
  --credential-store env --env-name WIKI_GENERATION_KEY
llm-wiki provider set wiki-embedding \
  --kind voyage --model voyage-3 \
  --credential-store env --env-name WIKI_EMBEDDING_KEY
llm-wiki provider use wiki-generation --root /project
llm-wiki provider use-embedding wiki-embedding --root /project
llm-wiki semantic enable --root /project
llm-wiki build --root /project
```

At build and query time, a missing or changed embedding profile, missing
credential, bad index, or provider failure produces a stable semantic reason
code and falls back to lexical retrieval from compiled Wiki pages in the last
good generation.

`serve` is strictly read-only and exits with its stdio client. Automatic builds
run only under the explicit `llm-wiki watch --root <project>` process; a query
never starts a build.

`status` verifies the approved source scope by default. Polling integrations can
use `status --fast` to read the committed generation and runtime state without
rescanning or hashing project files; their watcher remains responsible for
marking source changes stale.

## Client registration

`llm-wiki install` and `llm-wiki uninstall` delegate registration to the
installed Claude Code, Codex, and Hermes CLIs. They do not edit those clients'
configuration files directly. Missing clients produce stable reason codes;
Hermes keeps its required interactive discovery flow.

## Management JSON contract

With `--json`, stdout is exactly one JSON envelope:

```json
{"ok":true,"command":"status","data":{}}
```

Failures use:

```json
{"ok":false,"command":"build","error":{"code":"ERROR_CODE","message":"..."}}
```

Structured knowledge never travels in process arguments:

```sh
printf '%s' '{"id":"decision-1","title":"Decision","text":"Use stdio."}' |
  llm-wiki upsert --root /project --json
```

`delete` likewise reads `{"id":"decision-1"}` from stdin.
