import { describe, expect, test } from "bun:test";
import { execLongCommand, type FreestyleLongExecTarget } from "./long-exec.ts";

type ExecCall = { command: string; stdin?: string; env?: Record<string, string> };

function fakeVm(handler: (call: ExecCall, index: number) => { stdout?: string; statusCode?: number }): {
  vm: FreestyleLongExecTarget;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  return {
    calls,
    vm: {
      exec: async (options) => {
        calls.push({ command: options.command, stdin: options.stdin, env: options.env });
        const result = handler(options, calls.length - 1);
        return { stdout: result.stdout ?? "", stderr: "", statusCode: result.statusCode ?? 0 };
      },
    },
  };
}

describe("execLongCommand", () => {
  test("stages the script, polls with byte offsets, and returns the exit status", async () => {
    const script = "set -e\napt-get update\napt-get install -y build-essential";
    const { vm, calls } = fakeVm((call, index) => {
      if (index === 0) return { stdout: "" }; // upload
      if (index === 1) return { stdout: "started\n" }; // start
      if (call.command.includes("rm -rf")) return { stdout: "" };
      if (call.command.includes("tail -c +1 ")) {
        return { stdout: "__rigkit_long_exec_status__:__running__\nhello\n" };
      }
      return { stdout: "__rigkit_long_exec_status__:0\nworld\n" };
    });

    const chunks: string[] = [];
    const result = await execLongCommand(vm, {
      command: script,
      pollIntervalMs: 1,
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(result).toEqual({ stdout: "hello\nworld\n", statusCode: 0, timedOut: false });
    expect(chunks).toEqual(["hello\n", "world\n"]);

    expect(calls[0]?.stdin).toBe(Buffer.from(script, "utf8").toString("base64"));
    expect(calls[0]?.command).toContain("cat > /tmp/rigkit-exec-");
    expect(calls[1]?.command).toContain("nohup setsid sh -c");
    // "hello\n" is 6 bytes, so the second poll resumes from byte 7.
    const secondPoll = calls.find((call) => call.command.includes("tail -c +7 "));
    expect(secondPoll).toBeDefined();
    // The staged directory is removed once the job finishes.
    expect(calls.at(-1)?.command).toContain("rm -rf /tmp/rigkit-exec-");
  });

  test("passes env to the detached job and reports non-zero exits", async () => {
    const { vm, calls } = fakeVm((call, index) => {
      if (index === 0) return { stdout: "" };
      if (index === 1) return { stdout: "started\n" };
      if (call.command.includes("rm -rf")) return { stdout: "" };
      return { stdout: "__rigkit_long_exec_status__:17\nboom\n" };
    });

    const result = await execLongCommand(vm, {
      command: "exit 17",
      env: { DEBIAN_FRONTEND: "noninteractive" },
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ stdout: "boom\n", statusCode: 17, timedOut: false });
    expect(calls[1]?.env).toEqual({ DEBIAN_FRONTEND: "noninteractive" });
  });

  test("kills the job and reports a timeout when the budget runs out", async () => {
    const { vm, calls } = fakeVm((call, index) => {
      if (index === 0) return { stdout: "" };
      if (index === 1) return { stdout: "started\n" };
      if (call.command.includes("pkill") || call.command.includes("rm -rf")) return { stdout: "" };
      return { stdout: "__rigkit_long_exec_status__:__running__\ntick\n" };
    });

    const result = await execLongCommand(vm, {
      command: "sleep 1000",
      timeoutMs: 1,
      pollIntervalMs: 1,
    });

    expect(result.timedOut).toBe(true);
    expect(result.statusCode).toBeNull();
    expect(result.stdout).toContain("tick");
    expect(calls.some((call) => call.command.includes("pkill -TERM -f /tmp/rigkit-exec-"))).toBe(true);
  });

  test("tolerates transient poll failures", async () => {
    let polls = 0;
    const { vm } = fakeVm((call, index) => {
      if (index === 0) return { stdout: "" };
      if (index === 1) return { stdout: "started\n" };
      if (call.command.includes("rm -rf")) return { stdout: "" };
      polls += 1;
      if (polls <= 2) return { stdout: "", statusCode: 1 };
      return { stdout: "__rigkit_long_exec_status__:0\ndone\n" };
    });

    const result = await execLongCommand(vm, { command: "echo done", pollIntervalMs: 1 });
    expect(result).toEqual({ stdout: "done\n", statusCode: 0, timedOut: false });
  });
});
