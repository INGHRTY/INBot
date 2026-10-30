import path from "node:path";
import { parse as parseShellCommand } from "shell-quote";
import { z } from "zod";
import { isAllowedDesktopPath } from "../desktop-sandbox-paths.js";
import { networkTargets } from "./network-target.js";

const names = z.array(z.string().min(1).max(256)).max(64);
const paths = z.array(z.string().min(1).max(4096)).max(64);
const hosts = z.array(z.string().min(1).max(253)).max(64);

/**
 * What a task may do on this computer. Every list starts empty, so a grant that names
 * nothing allows nothing. The device enforces it on every action; the cloud only uses it
 * to reject a task before dispatching it.
 */
export const taskGrantSchema = z.object({
  preapproved: z.object({
    /** Applications the task may work in, by bundle id or application name. */
    apps: names.optional(),
    /** Paths the task may read. */
    readPaths: paths.optional(),
    /** Paths the task may write. */
    writePaths: paths.optional(),
    /** Shell commands the task may run. */
    shell: z
      .object({
        allow: z.boolean(),
        commands: z.array(z.string().min(1).max(64)).max(64).optional(),
      })
      .optional(),
    /** Hosts the task may reach. */
    hosts: hosts.optional(),
  }),
  /** What happens to an action that is neither denied nor preapproved. */
  onDemand: z.enum(["ask", "deny"]),
  /** Actions that never run, whatever else the grant says. */
  denied: z.object({ apps: names.optional(), paths: paths.optional(), hosts: hosts.optional() }),
  /** The grant stops applying at this moment. */
  expiresAt: z.string().min(1).max(64),
});
export type TaskGrant = z.infer<typeof taskGrantSchema>;

/** One action, in the terms the grant can judge. */
export type GrantSubject =
  | { kind: "observe" }
  | { kind: "pointer"; app?: string }
  | { kind: "scroll"; app?: string }
  | { kind: "type"; app?: string; text: string }
  | { kind: "key"; app?: string; key: string; modifiers?: string[] }
  | { kind: "launch"; application: string; uri?: string }
  | { kind: "focus"; application: string; uri?: string }
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
  // A moment that does not parse cannot be shown to be in the future, so it has passed.
  if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) {
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

/** How long a task's grant may last. */
export const TASK_GRANT_MAX_HOURS = 1;

/**
 * The widest grant a task may run under on someone's own computer.
 *
 * This is code that ships to the Mac, not something the cloud sends, so a dispatcher that
 * has been compromised or has changed cannot widen what a task may do without approval.
 * To let a task do more on its own, change this one place: the cloud builds its default
 * grant from it too.
 */
export function taskGrantCeiling(now = new Date()): TaskGrant {
  return {
    preapproved: {},
    onDemand: "ask",
    denied: {},
    expiresAt: new Date(now.getTime() + TASK_GRANT_MAX_HOURS * 60 * 60_000).toISOString(),
  };
}

/**
 * Narrows a grant the cloud sent to the ceiling this computer allows.
 *
 * Preapproval only survives where the ceiling preapproves it, denials add up, and the
 * grant never outlives the ceiling. A task that arrives without a readable expiry runs
 * under the ceiling's own, so it still expires.
 */
export function enforceTaskGrant(grant: TaskGrant, now = new Date()): TaskGrant {
  const ceiling = taskGrantCeiling(now);
  const expiresAt = Date.parse(grant.expiresAt);
  const ceilingAt = Date.parse(ceiling.expiresAt);
  const keep = <T>(sent: T[] | undefined, allowed: T[] | undefined): T[] | undefined => {
    if (!sent?.length) return undefined;
    const permitted = (allowed ?? []).map((value) => String(value).toLowerCase());
    const kept = sent.filter((value) => permitted.includes(String(value).toLowerCase()));
    return kept.length ? kept : undefined;
  };
  const preapproved = {
    apps: keep(grant.preapproved.apps, ceiling.preapproved.apps),
    readPaths: keep(grant.preapproved.readPaths, ceiling.preapproved.readPaths),
    writePaths: keep(grant.preapproved.writePaths, ceiling.preapproved.writePaths),
    hosts: keep(grant.preapproved.hosts, ceiling.preapproved.hosts),
    shell:
      ceiling.preapproved.shell?.allow && grant.preapproved.shell?.allow
        ? {
            allow: true,
            commands: keep(grant.preapproved.shell.commands, ceiling.preapproved.shell.commands),
          }
        : undefined,
  };
  return {
    preapproved: prune(preapproved),
    // Denying everything is stricter than asking, so it survives; asking is the loosest
    // a task can be.
    onDemand: "ask",
    denied: {
      apps: union(grant.denied.apps, ceiling.denied.apps),
      paths: union(grant.denied.paths, ceiling.denied.paths),
      hosts: union(grant.denied.hosts, ceiling.denied.hosts),
    },
    expiresAt: new Date(
      Math.min(Number.isFinite(expiresAt) ? expiresAt : ceilingAt, ceilingAt),
    ).toISOString(),
  };
}

function prune<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function union(sent: string[] | undefined, ceiling: string[] | undefined): string[] | undefined {
  const all = [...(sent ?? []), ...(ceiling ?? [])];
  return all.length ? [...new Set(all)] : undefined;
}

function deniedDecision(
  grant: TaskGrant,
  subject: GrantSubject,
  cwd: string,
): GrantDecision | undefined {
  const denied = grant.denied ?? {};
  if (denied.apps?.length) {
    for (const application of subjectApplications(subject)) {
      if (matchesAppName(denied.apps, application)) {
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
      return matchesAppName(preapproved.apps ?? [], application)
        ? { outcome: "allowed" }
        : undefined;
    }
    case "type":
      // Typing is how data leaves the screen, so it is never preapproved.
      return undefined;
    case "key": {
      // A "key" that is not a named key is text, and the desktop types it as text, so it
      // follows the same rule as typing: never preapproved.
      if (subject.modifiers?.length || !isNamedKey(subject.key)) return undefined;
      const application = subject.app;
      if (!application) return undefined;
      return matchesAppName(preapproved.apps ?? [], application)
        ? { outcome: "allowed" }
        : undefined;
    }
    case "launch":
    case "focus":
      // Opening something with a URI can navigate an app or run a file, so a bare
      // application name is not enough to preapprove it.
      if (subject.uri) return undefined;
      return matchesAppName(preapproved.apps ?? [], subject.application)
        ? { outcome: "allowed" }
        : undefined;
    case "open":
      // Opening a file runs whatever handles it (a .command, a .app, an installer), which
      // is not a read. It always takes a person's word for it.
      return undefined;
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
      return isNamedKey(subject.key)
        ? `Press ${subject.key}${subject.app ? ` in ${subject.app}` : ""}.`
        : `Type "${subject.key}"${subject.app ? ` in ${subject.app}` : ""}.`;
    case "launch":
      return `Launch ${subject.application}${subject.uri ? ` with ${subject.uri}` : ""}.`;
    case "focus":
      return `Bring ${subject.application} to the front${subject.uri ? ` with ${subject.uri}` : ""}.`;
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

/**
 * Whether a grant names this application.
 *
 * An app answers to two names: the one a person sees ("Safari") and the bundle id the
 * system knows ("com.apple.Safari"). A grant that names one covers both, so a denial
 * cannot be stepped around by asking the other way.
 */
function matchesAppName(names: readonly string[], value: string): boolean {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return false;
  return names.some((name) => {
    const entry = name.trim().toLowerCase();
    if (!entry) return false;
    if (entry === wanted) return true;
    // A bundle id also answers to its last part: "Safari" covers "com.apple.Safari",
    // and a grant naming the bundle id covers the name a window reports.
    return (wanted.split(".").at(-1) ?? "") === entry || (entry.split(".").at(-1) ?? "") === wanted;
  });
}

/** Keys that are control keys rather than text; the desktop types anything else literally. */
const NAMED_KEYS = new Set([
  "backspace",
  "capslock",
  "del",
  "delete",
  "down",
  "end",
  "enter",
  "esc",
  "escape",
  "forwarddelete",
  "help",
  "home",
  "insert",
  "left",
  "next",
  "option",
  "pagedown",
  "pageup",
  "prior",
  "return",
  "right",
  "space",
  "tab",
  "up",
  ...Array.from({ length: 20 }, (_unused, index) => `f${index + 1}`),
]);

function isNamedKey(key: string): boolean {
  return NAMED_KEYS.has(key.trim().toLowerCase());
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
