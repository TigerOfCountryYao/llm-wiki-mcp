import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type McpClient = "claude" | "codex" | "hermes";

export interface ClientInstallResult {
  client: McpClient;
  status: "installed" | "removed" | "unavailable" | "failed" | "interactive-required";
  reasonCode: string;
  message: string;
}

export function installForClients(
  clients: McpClient[],
  interactive: boolean,
): ClientInstallResult[] {
  return clients.map((client) => changeClientRegistration(client, "install", interactive));
}

export function uninstallForClients(
  clients: McpClient[],
  interactive: boolean,
): ClientInstallResult[] {
  return clients.map((client) => changeClientRegistration(client, "uninstall", interactive));
}

function changeClientRegistration(
  client: McpClient,
  operation: "install" | "uninstall",
  interactive: boolean,
): ClientInstallResult {
  const executable = findExecutable(client);
  if (executable === null) {
    return {
      client,
      status: "unavailable",
      reasonCode: "CLIENT_NOT_FOUND",
      message: `${client} is not available on PATH.`,
    };
  }
  if (client === "hermes" && !interactive) {
    return {
      client,
      status: "interactive-required",
      reasonCode: "CLIENT_INTERACTIVE_REQUIRED",
      message: "Hermes requires its own interactive discovery/confirmation flow.",
    };
  }

  const command = registrationCommand(client, operation);
  const result = runExecutable(executable, command, interactive);
  if (result.error !== undefined || result.status !== 0) {
    return {
      client,
      status: "failed",
      reasonCode: "CLIENT_COMMAND_FAILED",
      message:
        result.error?.message ??
        result.stderr?.toString("utf8").trim() ??
        `${client} exited with ${String(result.status)}.`,
    };
  }
  return {
    client,
    status: operation === "install" ? "installed" : "removed",
    reasonCode: operation === "install" ? "CLIENT_INSTALLED" : "CLIENT_REMOVED",
    message: `${client} MCP registration ${operation === "install" ? "installed" : "removed"}.`,
  };
}

function registrationCommand(
  client: McpClient,
  operation: "install" | "uninstall",
): string[] {
  if (operation === "uninstall") {
    switch (client) {
      case "claude":
        return ["mcp", "remove", "llm-wiki", "--scope", "user"];
      case "codex":
        return ["mcp", "remove", "llm-wiki"];
      case "hermes":
        return ["mcp", "remove", "llm-wiki"];
    }
  }

  const node = process.execPath;
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  switch (client) {
    case "claude":
      return [
        "mcp",
        "add-json",
        "--scope",
        "user",
        "llm-wiki",
        JSON.stringify({ type: "stdio", command: node, args: [cli, "serve"] }),
      ];
    case "codex":
      return ["mcp", "add", "llm-wiki", "--", node, cli, "serve"];
    case "hermes":
      return ["mcp", "add", "llm-wiki", "--command", node, "--args", cli, "serve"];
  }
}

function findExecutable(command: McpClient): string | null {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  const first = result.stdout
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find((item) => item !== "");
  return first === undefined ? null : path.resolve(first);
}

function runExecutable(
  executable: string,
  args: string[],
  interactive: boolean,
): ReturnType<typeof spawnSync> {
  const stdio = interactive ? "inherit" : "pipe";
  if (
    process.platform === "win32" &&
    (executable.toLocaleLowerCase("en-US").endsWith(".cmd") ||
      executable.toLocaleLowerCase("en-US").endsWith(".bat"))
  ) {
    const commandLine = [executable, ...args].map(quoteWindowsArgument).join(" ");
    return spawnSync(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", commandLine], {
      stdio,
      windowsHide: !interactive,
    });
  }
  return spawnSync(executable, args, {
    stdio,
    windowsHide: !interactive,
  });
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replaceAll(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}
