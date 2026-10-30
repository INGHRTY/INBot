import path from "node:path";
import { parse as parseShellCommand } from "shell-quote";
import { isAllowedDesktopPath } from "../desktop-sandbox-paths.js";
import { networkTargets } from "./network-target.js";

/**
 * What a task may do on this computer. Every list starts empty, so a grant that names
 * nothing allows nothing. The device enforces it on every action; the cloud only uses it
 * to reject a task before dispatching it.
 */
export interface TaskGrant {
  preapproved: {
    /** Applications the task may work in, by bundle id or application name. */
    apps?: string[];
    /** Paths the task may read. */
    readPaths?: string[];
    /** Paths the task may write. */
    writePaths?: string[];
    /** Shell commands the task may run. */
    shell?: { allow: boolean; commands?: string[] };
    /** Hosts the task may reach. */
    hosts?: string[];
  };
  /** What happens to an action that is neither denied nor preapproved. */
  onDemand: "ask" | "deny";
  /** Actions that never run, whatever else the grant says. */
  denied: { apps?: string[]; paths?: string[]; hosts?: string[] };
  /** The grant stops applying at this moment. */
  expiresAt: string;
}

/** One action, in the terms the grant can judge. */
export type GrantSubject =
  | { kind: "observe" }
  | { kind: "pointer"; app?: string }
  | { kind: "scroll"; app?: string }
  | { kind: "type"; app?: string; text: string }
  | { kind: "key"; app?: string; key: string; modifiers?: string[] }
  | { kind: "launch"; application: string }
  | { kind: "focus"; application: string }
  | { kind: "open"; path: string }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string }
  | { kind: "shell"; command: string }
  | { kind: "network"; host: string };

export type GrantDecision =
  | { outcome: "allowed" }
  | { outcome: "denied"; reason: string }
  | { outcome: "ask"; reason: string };

/**
 * Judges one action against a task grant.
 *
 * Denials come first, then preapproval, then the on-demand setting. The order matters:
 * a denied path stays denied even when the same path is also preapproved.
 */
export function checkGrant(
  grant: TaskGrant,
  subject: GrantSubject,
  options: { now?: Date; cwd?: string } = {},
): GrantDecision {
  const now = options.now ?? new Date();
  const cwd = options.cwd ?? process.cwd();
  const expiresAt = Date.parse(grant.expiresAt);
  if (Number.isFinite(expiresAt) && now.getTime() >= expiresAt) {
    return { outcome: "denied", reason: "This task's authorization has expired." };
  }
  const denied = deniedDecision(grant, subject, cwd);
  if (denied) return denied;
  const allowed = preapprovedDecision(grant, subject, cwd);
  if (allowed) return allowed;
  return onDemandDecision(grant, askReason(grant, subject));
}

/** A grant that allows nothing at all, used when a task arrives without one. */
export function emptyTaskGrant(expiresAt: string): TaskGrant {
  return {
    preapproved: {},
    onDemand: "ask",
    denied: {},
    expiresAt,
  };
}

function deniedDecision(
  grant: TaskGrant,
  subject: GrantSubject,
  cwd: string,
): GrantDecision | undefined {
  const denied = grant.denied ?? {};
  if (denied.apps?.length) {
    for (const application of subjectApplications(subject)) {
      if (matchesName(denied.apps, application)) {
        return { outcome: "denied", reason: `${application} is blocked by this task's policy.` };
      }
    }
  }
  if (denied.paths?.length) {
    for (const target of subjectPaths(subject)) {
      if (matchesPath(denied.paths, target, cwd)) {
        return { outcome: "denied", reason: `${target} is blocked by this task's policy.` };
      }
    }
  }
  if (denied.hosts?.length) {
    for (const host of subjectHosts(subject)) {
      if (matchesHost(denied.hosts, host)) {
        return { outcome: "denied", reason: `${host} is blocked by this task's policy.` };
      }
    }
  }
  return undefined;
}

function preapprovedDecision(
  grant: TaskGrant,
  subject: GrantSubject,
  cwd: string,
): GrantDecision | undefined {
  const preapproved = grant.preapproved ?? {};
  switch (subject.kind) {
    case "observe":
      // Reading pixels changes nothing; where they go is the model tier's business.
      return { outcome: "allowed" };
    case "pointer":
    case "scroll": {
      const application = subject.app;
      if (!application) return undefined;
      return matchesName(preapproved.apps ?? [], application) ? { outcome: "allowed" } : undefined;
    }
    case "type":
      // Typing is how data leaves the screen, so it is never preapproved.
      return undefined;
    case "key": {
      if (subject.modifiers?.length) return undefined;
      const application = subject.app;
      if (!application) return undefined;
      return matchesName(preapproved.apps ?? [], application) ? { outcome: "allowed" } : undefined;
    }
    case "launch":
    case "focus":
      return matchesName(preapproved.apps ?? [], subject.application)
        ? { outcome: "allowed" }
        : undefined;
    case "open":
      return matchesPath(preapproved.readPaths ?? [], subject.path, cwd) ||
        matchesPath(preapproved.writePaths ?? [], subject.path, cwd)
        ? { outcome: "allowed" }
        : undefined;
    case "read":
      return matchesPath(preapproved.readPaths ?? [], subject.path, cwd)
        ? { outcome: "allowed" }
        : undefined;
    case "write":
      return matchesPath(preapproved.writePaths ?? [], subject.path, cwd)
        ? { outcome: "allowed" }
        : undefined;
    case "shell": {
      const shell = preapproved.shell;
      if (!shell?.allow) return undefined;
      const programs = commandProgramNames(subject.command);
      if (!programs) return undefined;
      const allowed = shell.commands;
      if (allowed?.length && programs.some((program) => !matchesName(allowed, program))) {
        return undefined;
      }
      const target = networkTargets(subject.command);
      if (target.unknown) return undefined;
      if (target.hosts.some((host) => !matchesHost(preapproved.hosts ?? [], host)))
        return undefined;
      return { outcome: "allowed" };
    }
    case "network":
      return matchesHost(preapproved.hosts ?? [], subject.host)
        ? { outcome: "allowed" }
        : undefined;
  }
}

function onDemandDecision(grant: TaskGrant, reason: string): GrantDecision {
  return grant.onDemand === "deny"
    ? { outcome: "denied", reason: `${reason} This task may not ask for it.` }
    : { outcome: "ask", reason };
}

function askReason(grant: TaskGrant, subject: GrantSubject): string {
  switch (subject.kind) {
    case "observe":
      return "Read the screen.";
    case "pointer":
      return subject.app ? `Click in ${subject.app}.` : "Click on the screen.";
    case "scroll":
      return subject.app ? `Scroll in ${subject.app}.` : "Scroll on the screen.";
    case "type":
      return `Type "${subject.text}"${subject.app ? ` in ${subject.app}` : ""}.`;
    case "key":
      return `Press ${subject.key}${subject.app ? ` in ${subject.app}` : ""}.`;
    case "launch":
      return `Launch ${subject.application}.`;
    case "focus":
      return `Bring ${subject.application} to the front.`;
    case "open":
      return `Open ${subject.path}.`;
    case "read":
      return `Read ${subject.path}.`;
    case "write":
      return `Write ${subject.path}.`;
    case "shell":
      return shellReason(grant, subject.command);
    case "network":
      return `Reach ${subject.host}.`;
  }
}

function shellReason(grant: TaskGrant, command: string): string {
  const target = networkTargets(command);
  const unreachable = target.hosts.filter(
    (host) => !matchesHost(grant.preapproved?.hosts ?? [], host),
  );
  if (target.unknown) {
    return `Run \`${command}\`. It reaches the network, and its target cannot be read ahead of time.`;
  }
  if (unreachable.length) {
    return `Run \`${command}\`. It reaches ${unreachable.join(", ")}, which this task may not use.`;
  }
  return `Run \`${command}\`.`;
}

function subjectApplications(subject: GrantSubject): string[] {
  switch (subject.kind) {
    case "pointer":
    case "scroll":
    case "type":
    case "key":
      return subject.app ? [subject.app] : [];
    case "launch":
    case "focus":
      return [subject.application];
    default:
      return [];
  }
}

function subjectPaths(subject: GrantSubject): string[] {
  switch (subject.kind) {
    case "open":
    case "read":
    case "write":
      return [subject.path];
    case "shell":
      return literalPathOperands(subject.command);
    default:
      return [];
  }
}

function subjectHosts(subject: GrantSubject): string[] {
  switch (subject.kind) {
    case "network":
      return [subject.host];
    case "shell":
      return networkTargets(subject.command).hosts;
    default:
      return [];
  }
}

function matchesName(names: readonly string[], value: string): boolean {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return false;
  return names.some((name) => name.trim().toLowerCase() === wanted);
}

function matchesHost(hosts: readonly string[], value: string): boolean {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return false;
  return hosts.some((host) => host.trim().toLowerCase() === wanted);
}

function matchesPath(roots: readonly string[], target: string, cwd: string): boolean {
  if (!roots.length || !target.trim()) return false;
  return isAllowedDesktopPath(target, [...roots], pathOperations(cwd));
}

function pathOperations(cwd: string) {
  return {
    isAbsolute: path.isAbsolute,
    relative: path.relative,
    resolve: (value: string) => path.resolve(cwd, value),
    sep: path.sep,
  };
}

/** Path-looking arguments of a command, so a denied path is caught before the command runs. */
function literalPathOperands(command: string): string[] {
  let words: string[];
  try {
    words = parseShellCommand(command)
      .filter((word): word is string => typeof word === "string")
      .map((word) => word.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
  return words.filter(
    (word) => !word.includes("://") && (/^[~.]?[/\\]/.test(word) || word.includes("/")),
  );
}

/** Shell operators that start a new command in the same line. */
const COMMAND_SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);

/**
 * The programs a command runs, in order. Returns undefined when the command cannot be read,
 * so an unreadable command is never treated as an allowed one.
 */
function commandProgramNames(command: string): string[] | undefined {
  let parsed: unknown[];
  try {
    parsed = parseShellCommand(command);
  } catch {
    return undefined;
  }
  const programs: string[] = [];
  let startsCommand = true;
  for (const entry of parsed) {
    if (typeof entry !== "string") {
      const operator =
        entry && typeof entry === "object" && "op" in entry
          ? String((entry as { op?: unknown }).op ?? "")
          : "";
      if (COMMAND_SEPARATORS.has(operator)) startsCommand = true;
      continue;
    }
    const word = entry.trim();
    if (!word) continue;
    if (startsCommand) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
      programs.push((word.split("/").at(-1) ?? word).toLowerCase());
      startsCommand = false;
    }
  }
  return programs;
}
