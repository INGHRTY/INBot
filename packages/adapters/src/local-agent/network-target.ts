import { parse as parseShellCommand } from "shell-quote";

/**
 * Programs that reach the network on purpose. A shell command that runs one of these can
 * send anything on this computer to the target, so the task grant judges it separately.
 */
const NETWORK_COMMANDS = new Set([
  "aria2c",
  "curl",
  "ftp",
  "httpie",
  "https",
  "http",
  "nc",
  "ncat",
  "netcat",
  "scp",
  "sftp",
  "socat",
  "ssh",
  "telnet",
  "wget",
]);

/**
 * Programs whose subcommands decide whether they reach the network, where the target is a
 * remote rather than a literal host: `git push` talks to a server while `git status` does
 * not, and a registry name cannot be preapproved like a host can.
 */
const REMOTE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set([
    "clone",
    "fetch",
    "ls-remote",
    "pull",
    "push",
    "remote",
    "submodule",
    "archive",
    "send-email",
  ]),
  hg: new Set(["clone", "pull", "push", "incoming", "outgoing"]),
  svn: new Set(["checkout", "commit", "update", "export", "import", "switch"]),
  npm: new Set([
    "add",
    "audit",
    "ci",
    "deprecate",
    "dist-tag",
    "exec",
    "install",
    "login",
    "logout",
    "outdated",
    "owner",
    "pack",
    "publish",
    "search",
    "uninstall",
    "update",
    "view",
    "whoami",
  ]),
  npx: new Set(["*"]),
  pnpm: new Set([
    "add",
    "audit",
    "deploy",
    "fetch",
    "install",
    "login",
    "outdated",
    "publish",
    "remove",
    "update",
    "view",
  ]),
  yarn: new Set(["add", "audit", "install", "login", "outdated", "publish", "remove", "upgrade"]),
  pip: new Set(["download", "install", "list", "search", "uninstall"]),
  pip3: new Set(["download", "install", "list", "search", "uninstall"]),
  poetry: new Set(["add", "install", "publish", "update"]),
  uv: new Set(["add", "pip", "sync", "tool", "run"]),
  gem: new Set(["install", "push", "search", "update", "sources"]),
  cargo: new Set(["add", "install", "publish", "search", "update"]),
  go: new Set(["get", "install"]),
};

/** Programs that always talk to a remote, whichever subcommand they run. */
const ALWAYS_REMOTE = new Set([
  "docker",
  "kubectl",
  "helm",
  "gh",
  "aws",
  "gcloud",
  "az",
  "rsync",
  "brew",
  "nix",
  "bazel",
]);

/** Programs that run whatever command they are given as their own argument. */
const COMMAND_WRAPPERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "env",
  "eval",
  "xargs",
  "nohup",
  "sudo",
  "time",
  "command",
  "exec",
]);

/**
 * Programs whose `-c` argument is code, which can reach the network without naming it.
 * A command that passes code to one of these is never assumed to be local.
 */
const CODE_RUNNERS = new Set([
  "python",
  "python3",
  "perl",
  "ruby",
  "node",
  "php",
  "osascript",
  "swift",
]);

/** Commands whose target is the first argument rather than a URL. */
const HOST_AS_FIRST_ARGUMENT = new Set([
  "ftp",
  "nc",
  "ncat",
  "netcat",
  "scp",
  "sftp",
  "ssh",
  "telnet",
]);

export interface NetworkTarget {
  /** Hosts the command names literally. */
  hosts: string[];
  /** The command reaches the network but its target is not statically known. */
  unknown: boolean;
}

/**
 * Finds the network targets of a shell command. Anything it cannot read statically is
 * reported as unknown, so the caller can decide instead of assuming the command is local.
 */
export function networkTargets(command: string, depth = 0): NetworkTarget {
  let words: string[];
  try {
    words = parseShellCommand(command)
      .filter((word): word is string => typeof word === "string")
      .map((word) => word.trim())
      .filter(Boolean);
  } catch {
    // A command the tokenizer cannot read may hide anything, so treat it as reaching out.
    return { hosts: [], unknown: true };
  }
  const hosts = new Set<string>();
  let unknown = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const name = basename(word);
    if (!name) continue;
    // A wrapper's argument is itself a command, so judge it as one. `bash -c "curl …"`
    // would otherwise look like a local command.
    if (COMMAND_WRAPPERS.has(name) && depth < 4) {
      const inner = words.slice(index + 1).join(" ");
      if (inner) {
        const nested = networkTargets(inner, depth + 1);
        for (const host of nested.hosts) hosts.add(host);
        if (nested.unknown) unknown = true;
      }
      continue;
    }
    if (CODE_RUNNERS.has(name) && depth < 4) {
      const inner = words.slice(index + 1).join(" ");
      if (inner) {
        const nested = networkTargets(inner, depth + 1);
        for (const host of nested.hosts) hosts.add(host);
        // Code can build a URL at run time, so a code runner always reaches out.
        unknown = true;
      }
      continue;
    }
    const subcommands = REMOTE_SUBCOMMANDS[name];
    if (subcommands) {
      const subcommand = firstArgument(words, index) ?? "";
      if (subcommands.has("*") || subcommands.has(subcommand.toLowerCase())) {
        // The remote is not a literal host, so nothing can be preapproved for it.
        unknown = true;
      }
      continue;
    }
    if (ALWAYS_REMOTE.has(name)) {
      unknown = true;
      continue;
    }
    if (!NETWORK_COMMANDS.has(name)) continue;
    const before = hosts.size;
    for (const candidate of words.slice(index + 1)) {
      const host = hostFromUrl(candidate);
      if (host) hosts.add(host);
    }
    if (HOST_AS_FIRST_ARGUMENT.has(name)) {
      const argument = firstArgument(words, index);
      const host = argument ? hostFromUserHost(argument) : undefined;
      if (host) hosts.add(host);
    }
    if (hosts.size === before) unknown = true;
  }
  return { hosts: [...hosts], unknown };
}

function firstArgument(words: readonly string[], index: number): string | undefined {
  for (const word of words.slice(index + 1)) {
    if (word.startsWith("-")) continue;
    return word;
  }
  return undefined;
}

function basename(word: string): string {
  const name = word.split("/").at(-1) ?? word;
  return name.toLowerCase();
}

function hostFromUrl(value: string): string | undefined {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/\s?#@]+)/i.exec(value);
  if (!match) return undefined;
  const authority = match[1] ?? "";
  const host = authority.split(":")[0] ?? "";
  return host ? host.toLowerCase() : undefined;
}

function hostFromUserHost(value: string): string | undefined {
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = withoutScheme.split("@").at(-1) ?? withoutScheme;
  const withoutPort = host.split(":")[0] ?? "";
  return withoutPort ? withoutPort.toLowerCase() : undefined;
}
