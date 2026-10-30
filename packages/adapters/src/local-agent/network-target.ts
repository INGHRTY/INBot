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
export function networkTargets(command: string): NetworkTarget {
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
    if (!name || !NETWORK_COMMANDS.has(name)) continue;
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
