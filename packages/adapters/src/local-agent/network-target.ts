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
const HOST_AS_FIRST_ARGUMENT = new Set(["ftp", "nc", "ncat", "netcat", "ssh", "telnet"]);

/** Commands whose every `host:path` operand is a remote, as in `scp a:1 b:2`. */
const HOST_IN_EVERY_OPERAND = new Set(["scp", "sftp"]);

/** Programs a shell can reach the network with, beyond a literal request. */
const REMOTE_TOOLS: Readonly<Record<string, true>> = {
  dig: true,
  host: true,
  nslookup: true,
  ping: true,
};

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
  // A substitution or a variable builds its command at run time, and the tokenizer throws
  // the text away (`bash -c "$CMD"` reads as an empty string). Nothing inside it can be
  // judged, so the whole command is treated as reaching somewhere unknown.
  if (DYNAMIC_SHELL.test(command)) return { hosts: [], unknown: true };
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
  // A raw socket through a redirection needs no network program at all: `cat secret >
  // /dev/tcp/host/443`. The device path names the host, so it counts as one.
  for (const match of command.matchAll(/\/dev\/(?:tcp|udp)\/([^/\s'"]+)/g)) {
    const host = match[1];
    if (host) hosts.add(host.toLowerCase());
  }
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
    if (name === "open") {
      // Opening a URL hands it to a browser, which reaches the host in it. Opening a
      // file stays local.
      for (const candidate of operands(words, index)) {
        const host = hostFromUrl(candidate);
        if (host) hosts.add(host);
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
    if (ALWAYS_REMOTE.has(name) || REMOTE_TOOLS[name]) {
      unknown = true;
      continue;
    }
    if (!NETWORK_COMMANDS.has(name)) continue;
    const before = hosts.size;
    const after = words.slice(index + 1);
    for (let position = 0; position < after.length; position += 1) {
      const candidate = after[position] ?? "";
      const host = hostFromUrl(candidate);
      if (host) hosts.add(host);
      const redirect = redirectionHosts(candidate, after[position + 1]);
      for (const target of redirect) hosts.add(target);
      if (HOST_IN_EVERY_OPERAND.has(name)) {
        const remote = hostFromRemoteOperand(candidate);
        if (remote) hosts.add(remote);
      }
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

/** Text that turns the command it is in into something only known at run time. */
const DYNAMIC_SHELL = /\$\(|\$\{|\$[A-Za-z_]|`|<\(|>\(/;

/**
 * Hosts a curl option redirects the request to, which the URL itself does not name.
 * `--connect-to a:443:b:443 https://a/` talks to b, and `--resolve a:443:1.2.3.4` to that
 * address, so neither is judged by the host in the URL.
 */
function redirectionHosts(value: string, next?: string): string[] {
  const flag = /^--(connect-to|resolve)(?:=(.*))?$/.exec(value);
  if (!flag) return [];
  const given = flag[2] ?? next ?? "";
  const fields = given.split(":");
  // `--connect-to from:port:to:port` and `--resolve host:port:address` both name a host
  // other than the one in the URL.
  return (flag[1] === "resolve" ? [fields[0], fields[2]] : [fields[2], fields[1]]).filter(
    (field): field is string => Boolean(field && !/^\d+$/.test(field)),
  );
}

/** `host:path` as scp and sftp write a remote, without a scheme. */
function hostFromRemoteOperand(value: string): string | undefined {
  if (value.includes("://") || value.startsWith("-")) return undefined;
  const match = /^(?:[^@/\s]+@)?([^:/\s]+):/.exec(value);
  return match?.[1] ? match[1].toLowerCase() : undefined;
}

/** Everything after a command, without the operands of `-p 22`-style options. */
function operands(words: readonly string[], index: number): string[] {
  return words.slice(index + 1).filter((word) => !word.startsWith("-"));
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
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/\s?#]+)/i.exec(value);
  if (!match) return undefined;
  // Everything before the last `@` is a username, not the host: `https://api.example.com@evil.com`
  // connects to evil.com.
  const authority = match[1] ?? "";
  const host = (authority.split("@").at(-1) ?? "").split(":")[0] ?? "";
  return host ? host.toLowerCase() : undefined;
}

function hostFromUserHost(value: string): string | undefined {
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = withoutScheme.split("@").at(-1) ?? withoutScheme;
  const withoutPort = host.split(":")[0] ?? "";
  // A bare number is an argument, not a host: `nc -p 22` is not `nc 22`.
  return withoutPort && !/^\d+$/.test(withoutPort) ? withoutPort.toLowerCase() : undefined;
}
