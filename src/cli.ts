#!/usr/bin/env node

import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import { pathToFileURL } from "node:url";
import { buildProject } from "./build.js";
import { readProjectConfig, writeProjectConfig } from "./config.js";
import { doctorProject } from "./doctor.js";
import { asLlmWikiError, LlmWikiError } from "./errors.js";
import { pathExists, resolveProjectRoot } from "./fs-utils.js";
import {
  deleteKnowledge,
  parseDeleteKnowledge,
  parseUpsertKnowledge,
  upsertKnowledge,
} from "./managed.js";
import {
  installForClients,
  uninstallForClients,
  type McpClient,
} from "./installer.js";
import { startMcpServer } from "./mcp.js";
import { projectPaths } from "./paths.js";
import {
  deleteProviderCredential,
  listProviderProfiles,
  setProviderCredential,
  setProviderProfile,
  useProviderProfile,
} from "./provider.js";
import { initializeProject, uninitializeProject } from "./project.js";
import { catalogProject } from "./scope.js";
import { selectFirstLevelSources } from "./selection.js";
import { markStale } from "./state.js";
import { getProjectStatus } from "./status.js";
import { startWatcherLeader } from "./watcher.js";
import type { CommandEnvelope, ProviderKind } from "./types.js";

export interface CliIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  environment: NodeJS.ProcessEnv;
}

const defaultIo: CliIo = {
  stdin: processStdin,
  stdout: processStdout,
  stderr: processStderr,
  environment: process.env,
};

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const command = argv[0] ?? "help";
  const parsed = parseArguments(argv.slice(1));
  const json = parsed.flags.has("json");
  try {
    requireNode24();
    const root = await resolveProjectRoot(parsed.single("root") ?? process.cwd());
    let data: unknown;
    switch (command) {
      case "catalog":
        data = await catalogProject(root);
        break;
      case "init": {
        const selected = parsed.multiple("select");
        let selections: string[] | undefined = selected.length === 0 ? undefined : selected;
        if (parsed.flags.has("yes")) {
          if (!isTty(io.stdin) && selections === undefined) {
            throw new LlmWikiError(
              "EXPLICIT_SCOPE_REQUIRED",
              "Non-interactive init requires --yes and at least one explicit --select.",
            );
          }
        } else {
          if (json) {
            throw new LlmWikiError(
              "CONFIRMATION_REQUIRED",
              "JSON initialization requires --yes and explicit --select values.",
            );
          }
          const catalog = await catalogProject(root);
          const entries = catalog.entries.map((entry) => entry.path);
          const initiallySelected = new Set(
            selections ??
              catalog.entries.filter((entry) => entry.selected).map((entry) => entry.path),
          );
          selections = await selectFirstLevelSources(
            entries,
            initiallySelected,
            io.stdin,
            io.stdout,
          );
        }
        data = await initializeProject(root, selections);
        break;
      }
      case "uninit":
        data = await uninitializeProject(root);
        break;
      case "status":
        data = await getProjectStatus(root);
        break;
      case "build":
        data = await buildProject(root, { environment: io.environment });
        break;
      case "doctor":
        data = await doctorProject(root, io.environment);
        break;
      case "install":
        data = {
          clients: installForClients(
            parseClients(parsed.multiple("client")),
            !json && isTty(io.stdin),
          ),
        };
        break;
      case "uninstall":
        data = {
          clients: uninstallForClients(
            parseClients(parsed.multiple("client")),
            !json && isTty(io.stdin),
          ),
        };
        break;
      case "upsert": {
        await requireInitialized(root);
        const result = await upsertKnowledge(
          root,
          parseUpsertKnowledge(await readStdinJson(io.stdin)),
        );
        if (result.changed) {
          await markStale(root, "MANAGED_KNOWLEDGE_CHANGED", "Structured project knowledge changed.");
        }
        data = result;
        break;
      }
      case "delete": {
        await requireInitialized(root);
        const result = await deleteKnowledge(
          root,
          parseDeleteKnowledge(await readStdinJson(io.stdin)),
        );
        if (result.deleted) {
          await markStale(root, "MANAGED_KNOWLEDGE_CHANGED", "Structured project knowledge changed.");
        }
        data = result;
        break;
      }
      case "provider":
        data = await runProviderCommand(parsed, root, io);
        break;
      case "semantic":
        data = await runSemanticCommand(parsed, root);
        break;
      case "serve":
        await startMcpServer(root);
        return 0;
      case "watch":
        await runWatcherCommand(root, io);
        return 0;
      case "help":
      case "--help":
      case "-h":
        writeText(io.stdout, helpText());
        return 0;
      case "version":
      case "--version":
      case "-v":
        writeText(io.stdout, "0.1.0\n");
        return 0;
      default:
        throw new LlmWikiError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
    }
    writeSuccess(io.stdout, command, data, json);
    return 0;
  } catch (error) {
    const normalized = asLlmWikiError(error);
    if (json) {
      writeEnvelope(io.stdout, {
        ok: false,
        command,
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.details === undefined ? {} : { details: normalized.details }),
        },
      });
    } else {
      writeText(io.stderr, `${normalized.code}: ${normalized.message}\n`);
    }
    return 1;
  }
}

class ParsedArguments {
  readonly positionals: string[] = [];
  readonly options = new Map<string, string[]>();
  readonly flags = new Set<string>();

  single(name: string): string | undefined {
    const values = this.options.get(name) ?? [];
    if (values.length > 1) {
      throw new LlmWikiError("DUPLICATE_OPTION", `--${name} may only be supplied once.`);
    }
    return values[0];
  }

  multiple(name: string): string[] {
    return this.options.get(name) ?? [];
  }
}

function parseArguments(argv: string[]): ParsedArguments {
  const parsed = new ParsedArguments();
  const booleanFlags = new Set(["json", "yes", "key-stdin"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      parsed.positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (booleanFlags.has(name)) {
      parsed.flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new LlmWikiError("MISSING_OPTION_VALUE", `--${name} requires a value.`);
    }
    const values = parsed.options.get(name) ?? [];
    values.push(value);
    parsed.options.set(name, values);
    index += 1;
  }
  return parsed;
}

async function runProviderCommand(
  parsed: ParsedArguments,
  root: string,
  io: CliIo,
): Promise<unknown> {
  const subcommand = parsed.positionals[0] ?? "list";
  switch (subcommand) {
    case "list":
      return { profiles: await listProviderProfiles(io.environment) };
    case "set": {
      const name = requirePositional(parsed, 1, "provider profile name");
      const kind = requireOption(parsed, "kind");
      if (kind !== "anthropic" && kind !== "openai-compatible" && kind !== "voyage") {
        throw new LlmWikiError(
          "INVALID_PROVIDER_KIND",
          "--kind must be anthropic, openai-compatible, or voyage.",
        );
      }
      const credentialStore = parsed.single("credential-store") ?? "keyring";
      if (credentialStore !== "keyring" && credentialStore !== "env") {
        throw new LlmWikiError(
          "INVALID_CREDENTIAL_STORE",
          "--credential-store must be keyring or env.",
        );
      }
      return setProviderProfile(
        {
          name,
          kind: kind as ProviderKind,
          model: requireOption(parsed, "model"),
          ...(parsed.single("base-url") === undefined
            ? {}
            : { baseUrl: parsed.single("base-url")! }),
          credentialStore,
          ...(parsed.single("env-name") === undefined
            ? {}
            : { envName: parsed.single("env-name")! }),
        },
        io.environment,
      );
    }
    case "set-key": {
      const name = requirePositional(parsed, 1, "provider profile name");
      if (!parsed.flags.has("key-stdin")) {
        throw new LlmWikiError(
          "KEY_INPUT_REQUIRED",
          "Provider secrets are accepted only through --key-stdin.",
        );
      }
      const secret = (await readStdinText(io.stdin, 1024 * 1024)).replace(/\r?\n$/u, "");
      return setProviderCredential(name, secret, io.environment);
    }
    case "delete-key":
      return deleteProviderCredential(
        requirePositional(parsed, 1, "provider profile name"),
        io.environment,
      );
    case "use": {
      await requireInitialized(root);
      const result = await useProviderProfile(
        root,
        requirePositional(parsed, 1, "provider profile name"),
        io.environment,
      );
      await markStale(root, "PROVIDER_PROFILE_CHANGED", "Wiki provider profile changed.");
      return result;
    }
    case "use-embedding": {
      await requireInitialized(root);
      const name = requirePositional(parsed, 1, "embedding profile name");
      const profiles = await listProviderProfiles(io.environment);
      const selected = profiles.find((profile) => profile.name === name);
      if (selected === undefined) {
        throw new LlmWikiError("PROVIDER_PROFILE_NOT_FOUND", `Provider profile not found: ${name}`);
      }
      if (selected.kind !== "openai-compatible" && selected.kind !== "voyage") {
        throw new LlmWikiError(
          "INVALID_EMBEDDING_PROVIDER_KIND",
          "Embedding profiles must use openai-compatible or voyage.",
        );
      }
      const config = await readProjectConfig(root);
      await writeProjectConfig(root, { ...config, embeddingProfile: name });
      await markStale(root, "EMBEDDING_PROFILE_CHANGED", "Embedding profile changed.");
      return { root, embeddingProfile: name };
    }
    default:
      throw new LlmWikiError("UNKNOWN_PROVIDER_COMMAND", `Unknown provider command: ${subcommand}`);
  }
}

async function runSemanticCommand(parsed: ParsedArguments, root: string): Promise<unknown> {
  await requireInitialized(root);
  const subcommand = parsed.positionals[0] ?? "status";
  const config = await readProjectConfig(root);
  if (subcommand === "status") {
    return {
      enabled: config.semantic.enabled,
      providerProfile: config.providerProfile,
      embeddingProfile: config.embeddingProfile,
    };
  }
  if (subcommand !== "enable" && subcommand !== "disable") {
    throw new LlmWikiError("UNKNOWN_SEMANTIC_COMMAND", `Unknown semantic command: ${subcommand}`);
  }
  if (subcommand === "enable" && config.embeddingProfile === null) {
    throw new LlmWikiError(
      "EMBEDDING_PROFILE_REQUIRED",
      "Select an explicit embedding profile before enabling semantic retrieval.",
    );
  }
  const enabled = subcommand === "enable";
  await writeProjectConfig(root, { ...config, semantic: { enabled } });
  await markStale(root, "SEMANTIC_CONFIG_CHANGED", "Semantic retrieval configuration changed.");
  return {
    enabled,
    providerProfile: config.providerProfile,
    embeddingProfile: config.embeddingProfile,
  };
}

async function requireInitialized(root: string): Promise<void> {
  if (!(await pathExists(projectPaths(root).consent))) {
    throw new LlmWikiError("NOT_INITIALIZED", "Run llm-wiki init first.");
  }
}

function isTty(stream: NodeJS.ReadableStream): boolean {
  return "isTTY" in stream && stream.isTTY === true;
}

function parseClients(values: string[]): McpClient[] {
  const requested = values.length === 0 || values.includes("all")
    ? ["claude", "codex", "hermes"]
    : values;
  const valid = new Set<McpClient>(["claude", "codex", "hermes"]);
  for (const value of requested) {
    if (!valid.has(value as McpClient)) {
      throw new LlmWikiError("INVALID_CLIENT", `Unknown MCP client: ${value}`);
    }
  }
  return [...new Set(requested as McpClient[])];
}

async function readStdinJson(stream: NodeJS.ReadableStream): Promise<unknown> {
  const text = await readStdinText(stream, 10 * 1024 * 1024);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new LlmWikiError(
      "INVALID_STDIN_JSON",
      `stdin must contain one JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readStdinText(stream: NodeJS.ReadableStream, maximumBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > maximumBytes) {
      throw new LlmWikiError("STDIN_TOO_LARGE", `stdin exceeds ${maximumBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requireOption(parsed: ParsedArguments, name: string): string {
  const value = parsed.single(name);
  if (value === undefined || value === "") {
    throw new LlmWikiError("MISSING_REQUIRED_OPTION", `--${name} is required.`);
  }
  return value;
}

function requirePositional(parsed: ParsedArguments, index: number, description: string): string {
  const value = parsed.positionals[index];
  if (value === undefined || value === "") {
    throw new LlmWikiError("MISSING_ARGUMENT", `Missing ${description}.`);
  }
  return value;
}

function requireNode24(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 24) {
    throw new LlmWikiError(
      "NODE_TOO_OLD",
      `Node.js 24 or newer is required; current version is ${process.versions.node}.`,
    );
  }
}

function writeSuccess(
  output: NodeJS.WritableStream,
  command: string,
  data: unknown,
  json: boolean,
): void {
  if (json) {
    writeEnvelope(output, { ok: true, command, data });
  } else {
    writeText(output, `${JSON.stringify(data, null, 2)}\n`);
  }
}

function writeEnvelope(output: NodeJS.WritableStream, envelope: CommandEnvelope): void {
  writeText(output, `${JSON.stringify(envelope)}\n`);
}

function writeText(output: NodeJS.WritableStream, text: string): void {
  output.write(text);
}

function helpText(): string {
  return `llm-wiki 0.1.0

Usage:
  llm-wiki catalog --root <project> [--json]
  llm-wiki install|uninstall [--client claude|codex|hermes|all] [--json]
  llm-wiki init --root <project> [--select <first-level>]... [--yes] [--json]
  llm-wiki status|build|doctor|uninit --root <project> [--json]
  llm-wiki upsert|delete --root <project> --json < input.json
  llm-wiki provider list [--json]
  llm-wiki provider set <name> --kind <kind> --model <model>
  llm-wiki provider set-key <name> --key-stdin
  llm-wiki provider delete-key <name>
  llm-wiki provider use <name> --root <project>
  llm-wiki provider use-embedding <name> --root <project>
  llm-wiki semantic status|enable|disable --root <project>
  llm-wiki watch --root <project>
  llm-wiki serve --root <project>
`;
}

async function runWatcherCommand(root: string, io: CliIo): Promise<void> {
  await requireInitialized(root);
  const watcher = await startWatcherLeader(root, {
    onWarning: (message) => writeText(io.stderr, `${message}\n`),
  });
  if (!watcher.leader) {
    throw new LlmWikiError("WATCHER_ALREADY_RUNNING", "Another watcher already owns this project.");
  }
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await watcher.close();
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
