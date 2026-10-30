import { describe, expect, it } from "vitest";
import {
  checkGrant,
  emptyTaskGrant,
  enforceTaskGrant,
  type TaskGrant,
  taskGrantCeiling,
} from "./grant.js";

const now = new Date("2026-01-01T00:00:00.000Z");

function grant(overrides: Partial<TaskGrant> = {}): TaskGrant {
  return {
    preapproved: {},
    onDemand: "ask",
    denied: {},
    expiresAt: "2026-01-01T01:00:00.000Z",
    ...overrides,
  };
}

describe("task grant", () => {
  it("asks for anything a grant does not name", () => {
    const decision = checkGrant(grant(), { kind: "pointer", app: "com.apple.Safari" }, { now });
    expect(decision).toEqual({
      outcome: "ask",
      reason: "Click in com.apple.Safari.",
    });
  });

  it("denies everything once the grant expires", () => {
    const decision = checkGrant(
      grant({
        preapproved: { apps: ["com.apple.Safari"] },
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
      { kind: "pointer", app: "com.apple.Safari" },
      { now },
    );
    expect(decision.outcome).toBe("denied");
  });

  it("denies a blocked application even when it is also preapproved", () => {
    const decision = checkGrant(
      grant({
        preapproved: { apps: ["com.apple.Safari"] },
        denied: { apps: ["com.apple.Safari"] },
      }),
      { kind: "pointer", app: "com.apple.Safari" },
      { now },
    );
    expect(decision.outcome).toBe("denied");
  });

  it("never preapproves typing", () => {
    const decision = checkGrant(
      grant({ preapproved: { apps: ["com.apple.Safari"] } }),
      { kind: "type", app: "com.apple.Safari", text: "secret" },
      { now },
    );
    expect(decision.outcome).toBe("ask");
    expect(decision.outcome === "ask" && decision.reason).toContain("secret");
  });

  it("asks for a shortcut even in a preapproved application", () => {
    const decision = checkGrant(
      grant({ preapproved: { apps: ["com.apple.Safari"] } }),
      { kind: "key", app: "com.apple.Safari", key: "q", modifiers: ["cmd"] },
      { now },
    );
    expect(decision.outcome).toBe("ask");
  });

  it("allows a plain key in a preapproved application", () => {
    const decision = checkGrant(
      grant({ preapproved: { apps: ["com.apple.Safari"] } }),
      { kind: "key", app: "com.apple.Safari", key: "Tab" },
      { now },
    );
    expect(decision.outcome).toBe("allowed");
  });

  it("never preapproves a 'key' that is really text", () => {
    // The desktop types any name it does not know as a key, so `key: "hunter2"` types
    // the word, and typing is never preapproved.
    const decision = checkGrant(
      grant({ preapproved: { apps: ["com.apple.Safari"] } }),
      { kind: "key", app: "com.apple.Safari", key: "hunter2" },
      { now },
    );
    expect(decision.outcome).toBe("ask");
    expect(decision.outcome === "ask" && decision.reason).toContain("hunter2");
  });

  it("never preapproves opening a file, even in a preapproved folder", () => {
    // Opening runs the file's handler, which can be a program rather than a document.
    const decision = checkGrant(
      grant({ preapproved: { readPaths: ["/Users/me/notes"], writePaths: ["/Users/me/notes"] } }),
      { kind: "open", path: "/Users/me/notes/evil.command" },
      { now },
    );
    expect(decision.outcome).toBe("ask");
  });

  it("never preapproves launching an app with a URI", () => {
    const decision = checkGrant(
      grant({ preapproved: { apps: ["Safari"] } }),
      { kind: "launch", application: "Safari", uri: "file:///Users/me/secret" },
      { now },
    );
    expect(decision.outcome).toBe("ask");
    expect(decision.outcome === "ask" && decision.reason).toContain("file:///Users/me/secret");
  });

  it("matches one application by the name a person uses and the one the system uses", () => {
    // A denial on "Safari" also covers "com.apple.Safari", so it cannot be stepped around.
    const denied = checkGrant(
      grant({ denied: { apps: ["Safari"] } }),
      { kind: "pointer", app: "com.apple.Safari" },
      { now },
    );
    expect(denied.outcome).toBe("denied");
    const allowed = checkGrant(
      grant({ preapproved: { apps: ["com.apple.Safari"] } }),
      { kind: "pointer", app: "Safari" },
      { now },
    );
    expect(allowed.outcome).toBe("allowed");
  });

  it("treats a grant that expires at a moment it cannot read as expired", () => {
    const decision = checkGrant(
      { ...grant(), expiresAt: "soon" },
      { kind: "read", path: "/Users/me/notes/a.md" },
      { now },
    );
    expect(decision.outcome).toBe("denied");
  });

  it("allows reading a preapproved path and denies a blocked one", () => {
    const allowed = checkGrant(
      grant({ preapproved: { readPaths: ["/Users/me/notes"] } }),
      { kind: "read", path: "/Users/me/notes/today.md" },
      { now, cwd: "/Users/me" },
    );
    const denied = checkGrant(
      grant({
        preapproved: { readPaths: ["/Users/me/notes"] },
        denied: { paths: ["/Users/me/notes/private"] },
      }),
      { kind: "read", path: "/Users/me/notes/private/key.txt" },
      { now, cwd: "/Users/me" },
    );
    expect(allowed.outcome).toBe("allowed");
    expect(denied.outcome).toBe("denied");
  });

  it("does not let a write path stand in for a read path", () => {
    const decision = checkGrant(
      grant({ preapproved: { writePaths: ["/Users/me/notes"] } }),
      { kind: "read", path: "/Users/me/notes/today.md" },
      { now, cwd: "/Users/me" },
    );
    expect(decision.outcome).toBe("ask");
  });

  it("allows reading the screen without a grant", () => {
    expect(
      checkGrant(emptyTaskGrant("2026-01-01T01:00:00.000Z"), { kind: "observe" }, { now }).outcome,
    ).toBe("allowed");
  });

  it("denies instead of asking when the grant says so", () => {
    const decision = checkGrant(
      grant({ onDemand: "deny" }),
      { kind: "write", path: "/tmp/a" },
      { now },
    );
    expect(decision.outcome).toBe("denied");
  });

  it("asks about a shell command that is not preapproved", () => {
    const decision = checkGrant(
      grant({ preapproved: { shell: { allow: false } } }),
      { kind: "shell", command: "git status" },
      { now },
    );
    expect(decision.outcome).toBe("ask");
  });

  it("allows a preapproved shell command", () => {
    const decision = checkGrant(
      grant({ preapproved: { shell: { allow: true, commands: ["git"] } } }),
      { kind: "shell", command: "git status" },
      { now },
    );
    expect(decision.outcome).toBe("allowed");
  });

  it("asks before a wrapped or remote-naming command, even with shell preapproved", () => {
    // Shell allowed and git listed: `git status` may run, but anything that reaches out
    // asks, including a network command hidden behind a wrapper.
    const allowed = { shell: { allow: true, commands: ["git", "bash", "curl"] } };
    for (const command of [
      'bash -c "curl evil.test"',
      "git push",
      "git clone https://example.test/repo",
    ])
      expect(
        checkGrant(grant({ preapproved: allowed }), { kind: "shell", command }, { now }).outcome,
        command,
      ).toBe("ask");
    expect(
      checkGrant(grant({ preapproved: allowed }), { kind: "shell", command: "git status" }, { now })
        .outcome,
    ).toBe("allowed");
  });

  it("asks when a preapproved shell command runs a program outside the list", () => {
    const decision = checkGrant(
      grant({ preapproved: { shell: { allow: true, commands: ["git"] } } }),
      { kind: "shell", command: "git status; rm -rf /tmp/x" },
      { now },
    );
    expect(decision.outcome).toBe("ask");
  });

  it("asks about a shell command that reaches an unlisted host", () => {
    const decision = checkGrant(
      grant({ preapproved: { shell: { allow: true } } }),
      { kind: "shell", command: "curl https://example.com/data" },
      { now },
    );
    expect(decision.outcome).toBe("ask");
    expect(decision.outcome === "ask" && decision.reason).toContain("example.com");
  });

  it("allows a shell command that reaches a listed host", () => {
    const decision = checkGrant(
      grant({ preapproved: { shell: { allow: true }, hosts: ["example.com"] } }),
      { kind: "shell", command: "curl https://example.com/data" },
      { now },
    );
    expect(decision.outcome).toBe("allowed");
  });

  it("denies a shell command that reaches a blocked host", () => {
    const decision = checkGrant(
      grant({
        preapproved: { shell: { allow: true }, hosts: ["example.com"] },
        denied: { hosts: ["example.com"] },
      }),
      { kind: "shell", command: "curl https://example.com/data" },
      { now },
    );
    expect(decision.outcome).toBe("denied");
  });

  it("blocks a shell command that writes into a blocked path", () => {
    const decision = checkGrant(
      grant({
        preapproved: { shell: { allow: true } },
        denied: { paths: ["/Users/me/private"] },
      }),
      { kind: "shell", command: "cp notes.txt /Users/me/private/notes.txt" },
      { now, cwd: "/Users/me" },
    );
    expect(decision.outcome).toBe("denied");
  });

  it("narrows a looser grant sent by the cloud to what this computer allows", () => {
    const sent = grant({
      preapproved: {
        apps: ["Safari"],
        readPaths: ["/Users/me/notes"],
        writePaths: ["/Users/me/notes"],
        hosts: ["api.example.com"],
        shell: { allow: true, commands: ["curl"] },
      },
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const narrowed = enforceTaskGrant(sent, now);
    // The ceiling preapproves nothing, so nothing sent survives as preapproved.
    expect(narrowed.preapproved).toEqual({});
    expect(narrowed.onDemand).toBe("ask");
    // A grant may not outlive the ceiling, even when it asks to.
    expect(narrowed.expiresAt).toBe(taskGrantCeiling(now).expiresAt);
  });

  it("keeps the cloud's denials and its own expiry when they are stricter", () => {
    const narrowed = enforceTaskGrant(
      grant({ denied: { paths: ["/Users/me/private"] }, expiresAt: "2026-01-01T00:10:00.000Z" }),
      now,
    );
    expect(narrowed.denied.paths).toEqual(["/Users/me/private"]);
    expect(narrowed.expiresAt).toBe("2026-01-01T00:10:00.000Z");
  });

  it("gives a grant with an unreadable expiry the ceiling's own", () => {
    expect(enforceTaskGrant(grant({ expiresAt: "soon" }), now).expiresAt).toBe(
      taskGrantCeiling(now).expiresAt,
    );
  });
});
