import { describe, expect, test } from "bun:test";
import { installVscodeServerCommand, parseVscodeVersionOutput } from "./vscode-server.ts";

const COMMIT = "f1a4fb101478ce6ec82fe9627c43efbf9e98c813";

describe("parseVscodeVersionOutput", () => {
  test("parses code --version output", () => {
    expect(parseVscodeVersionOutput(`1.103.1\n${COMMIT}\narm64\n`)).toEqual({
      version: "1.103.1",
      commit: COMMIT,
    });
  });

  test("rejects output without a commit sha", () => {
    expect(parseVscodeVersionOutput("1.103.1\nnot-a-sha\narm64")).toBeUndefined();
    expect(parseVscodeVersionOutput("")).toBeUndefined();
  });
});

describe("installVscodeServerCommand", () => {
  test("installs both server layouts and the CLI for the pinned commit", () => {
    const command = installVscodeServerCommand({ commit: COMMIT });

    expect(command).toContain(`commit=${COMMIT}`);
    expect(command).toContain("export HOME='/root'");
    expect(command).toContain("https://update.code.visualstudio.com/commit:$commit/server-linux-$arch/stable");
    expect(command).toContain("https://update.code.visualstudio.com/commit:$commit/cli-alpine-$arch/stable");
    expect(command).toContain('"$base/bin/$commit"');
    expect(command).toContain('"$base/cli/servers/Stable-$commit/server"');
    expect(command).toContain('mv "$tmp/code" "$base/code-$commit"');
    expect(command).toContain("aarch64|arm64) arch=arm64 ;;");
  });

  test("honors a custom home directory", () => {
    const command = installVscodeServerCommand({ commit: COMMIT, home: "/home/developer" });
    expect(command).toContain("export HOME='/home/developer'");
    expect(command).toContain("base='/home/developer'/.vscode-server");
  });

  test("rejects a malformed commit sha", () => {
    expect(() => installVscodeServerCommand({ commit: "abc; rm -rf /" })).toThrow(
      "Invalid VS Code commit sha",
    );
  });
});
