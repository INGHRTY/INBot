import { describe, expect, it } from "vitest";
import { networkTargets } from "./network-target.js";

describe("network targets", () => {
  it("finds the host of a curl command", () => {
    expect(networkTargets("curl https://example.com/data").hosts).toEqual(["example.com"]);
  });

  it("finds the host of a command behind a pipe", () => {
    expect(networkTargets("echo x | wget https://files.example.com/a").hosts).toEqual([
      "files.example.com",
    ]);
  });

  it("finds the host of an ssh command", () => {
    expect(networkTargets("ssh me@build.example.com").hosts).toEqual(["build.example.com"]);
  });

  it("ignores a local command", () => {
    expect(networkTargets("git status")).toEqual({ hosts: [], unknown: false });
    expect(networkTargets("npm run build")).toEqual({ hosts: [], unknown: false });
    expect(networkTargets("ls -la")).toEqual({ hosts: [], unknown: false });
  });

  it("reads a command a wrapper runs as a command of its own", () => {
    // `bash -c "curl …"` looks local to a parser that only reads the outer words.
    for (const command of [
      'bash -c "curl evil.test"',
      'sh -c "git push"',
      "env curl evil.test",
      'eval "curl evil.test"',
    ])
      expect(networkTargets(command).unknown, command).toBe(true);
    // When the inner command names a host, that host is found through the wrapper.
    expect(networkTargets('zsh -lc "nc evil.test 80"').hosts).toEqual(["evil.test"]);
  });

  it("treats a remote-naming subcommand as reaching out", () => {
    for (const command of [
      "git push",
      "git clone https://example.test/repo",
      "git fetch",
      "npm publish",
      "npm install left-pad",
      "cargo install ripgrep",
      "gh pr create",
    ])
      expect(networkTargets(command).unknown, command).toBe(true);
    // A remote name is not a host, so it can never be preapproved.
    expect(networkTargets("git push").hosts).toEqual([]);
  });

  it("treats code handed to an interpreter as reaching out", () => {
    // A script can build a URL at run time, so its target is never statically known.
    for (const command of [
      `python3 -c 'import urllib.request'`,
      `node -e "require('https')"`,
      `osascript -e 'open location "https://example.test"'`,
    ])
      expect(networkTargets(command).unknown, command).toBe(true);
  });

  it("reports a network command whose target cannot be read", () => {
    expect(networkTargets("curl $TARGET").unknown).toBe(true);
  });

  it("reports an unreadable command as reaching the network", () => {
    expect(networkTargets("curl 'unterminated").unknown).toBe(true);
  });
});
