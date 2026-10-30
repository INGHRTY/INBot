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
  });

  it("reports a network command whose target cannot be read", () => {
    expect(networkTargets("curl $TARGET").unknown).toBe(true);
  });

  it("reports an unreadable command as reaching the network", () => {
    expect(networkTargets("curl 'unterminated").unknown).toBe(true);
  });
});
