import type { FreestyleSdkVm } from "@rigkit/provider-freestyle";
import { devServerLogPath, devServerPidPath } from "./config";
import { shellQuote } from "./shell";

type ExecInput = Parameters<FreestyleSdkVm["exec"]>[0];

export async function execOrThrow(
  vm: Pick<FreestyleSdkVm, "exec">,
  label: string,
  options: ExecInput,
): Promise<Awaited<ReturnType<FreestyleSdkVm["exec"]>>> {
  const result = await vm.exec(options);
  if ((result.statusCode ?? 0) !== 0) {
    throw new Error(
      `${label} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    );
  }
  return result;
}

export async function waitForLocalhostHtml(
  vm: Pick<FreestyleSdkVm, "exec">,
  port: number,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  await execOrThrow(vm, `Dev server did not return HTML on localhost:${port}`, {
    command: [
      "set -e",
      "tmp_dir=$(mktemp -d)",
      "trap 'rm -rf \"$tmp_dir\"' EXIT",
      "for attempt in $(seq 1 120); do",
      `  if curl -fsS --max-time 5 -o "$tmp_dir/body" ${shellQuote(url)} >/dev/null 2>&1; then`,
      `    if grep -Eiq '<!doctype html|<html[[:space:]>]' "$tmp_dir/body"; then`,
      "      exit 0",
      "    fi",
      "  fi",
      "  sleep 1",
      "done",
      "echo '--- dev server readiness diagnostics ---'",
      `echo 'url: ${url}'`,
      `echo 'pid file: ${devServerPidPath}'`,
      `if [ -f ${shellQuote(devServerPidPath)} ]; then pid=$(cat ${shellQuote(devServerPidPath)}); echo "pid: $pid"; ps -fp "$pid" || true; else echo 'pid file missing'; fi`,
      `echo 'metadata:'`,
      `cat ${shellQuote(devServerLogPath)}.meta 2>/dev/null || echo 'metadata missing'`,
      `echo 'listening sockets:'`,
      "(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || netstat -an 2>/dev/null) | sed -n '1,120p' || true",
      `echo 'dev server log tail:'`,
      `tail -n 200 ${shellQuote(devServerLogPath)} 2>/dev/null || echo 'dev server log missing'`,
      `echo 'final curl:'`,
      `curl -i -sS --max-time 10 ${shellQuote(url)} | sed -n '1,80p' || true`,
      "exit 1",
    ].join("\n"),
    timeoutMs: 125 * 1000,
  });
}
