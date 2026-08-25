import type { ExecResult } from "freestyle";

// Freestyle v2 caps a single `vm.exec` at five minutes of wall clock. Longer
// jobs run detached inside the guest instead: upload the script, start it
// under setsid with output to a log file, then poll with short execs until an
// exit-status file appears.

export const FREESTYLE_EXEC_TIMEOUT_CAP_MS = 5 * 60 * 1000;

export type FreestyleLongExecTarget = {
  exec(options: {
    command: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    stdin?: string;
  }): Promise<ExecResult>;
};

export type FreestyleLongExecOptions = {
  command: string;
  /** Overall wall-clock budget for the job. Defaults to 30 minutes. */
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Delay between status polls. Defaults to 3 seconds. */
  pollIntervalMs?: number;
  /** Receives incremental combined stdout+stderr as the job produces it. */
  onOutput?: (chunk: string) => void;
};

export type FreestyleLongExecResult = {
  /** Combined stdout and stderr of the job. */
  stdout: string;
  /** The job's exit status; null when the overall timeout killed it. */
  statusCode: number | null;
  timedOut: boolean;
};

const STATUS_PREFIX = "__rigkit_long_exec_status__:";
const RUNNING = "__running__";
const STEP_TIMEOUT_MS = 60 * 1000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

export async function execLongCommand(
  vm: FreestyleLongExecTarget,
  options: FreestyleLongExecOptions,
): Promise<FreestyleLongExecResult> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const dir = `/tmp/rigkit-exec-${crypto.randomUUID()}`;

  const upload = await vm.exec({
    command: `mkdir -p ${dir} && cat > ${dir}/script.sh`,
    stdin: Buffer.from(options.command, "utf8").toString("base64"),
    timeoutMs: STEP_TIMEOUT_MS,
  });
  if ((upload.statusCode ?? 0) !== 0) {
    throw new Error(
      `Failed to stage long-running command:\n${upload.stdout ?? ""}${upload.stderr ?? ""}`.trim(),
    );
  }

  const runner = [
    `nohup setsid sh -c 'if command -v bash >/dev/null 2>&1; then rigkit_shell=bash; else rigkit_shell=sh; fi; "$rigkit_shell" ${dir}/script.sh >> ${dir}/out.log 2>&1 </dev/null; echo $? > ${dir}/exit.tmp; mv ${dir}/exit.tmp ${dir}/exit' >/dev/null 2>&1 &`,
    "echo started",
  ].join("\n");
  const started = await vm.exec({
    command: runner,
    ...(options.env ? { env: options.env } : {}),
    timeoutMs: STEP_TIMEOUT_MS,
  });
  if ((started.statusCode ?? 0) !== 0) {
    throw new Error(
      `Failed to start long-running command:\n${started.stdout ?? ""}${started.stderr ?? ""}`.trim(),
    );
  }

  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  let output = "";
  let pollFailures = 0;

  const readChunk = (raw: string): { status: string; chunk: string } => {
    const newline = raw.indexOf("\n");
    const firstLine = newline === -1 ? raw : raw.slice(0, newline);
    const chunk = newline === -1 ? "" : raw.slice(newline + 1);
    if (!firstLine.startsWith(STATUS_PREFIX)) {
      throw new Error(`Unexpected long-running command poll output: ${firstLine}`);
    }
    return { status: firstLine.slice(STATUS_PREFIX.length).trim(), chunk };
  };

  const cleanup = async () => {
    await vm.exec({ command: `rm -rf ${dir}`, timeoutMs: STEP_TIMEOUT_MS }).catch(() => {});
  };

  while (true) {
    const probe = [
      `if [ -f ${dir}/exit ]; then rigkit_status=$(cat ${dir}/exit); else rigkit_status=${RUNNING}; fi`,
      `echo "${STATUS_PREFIX}$rigkit_status"`,
      `tail -c +${offset + 1} ${dir}/out.log 2>/dev/null || true`,
    ].join("\n");

    let poll: ExecResult;
    try {
      poll = await vm.exec({ command: probe, timeoutMs: STEP_TIMEOUT_MS });
      if ((poll.statusCode ?? 0) !== 0) {
        throw new Error(`poll exited ${poll.statusCode}: ${poll.stderr ?? ""}`);
      }
      pollFailures = 0;
    } catch (error) {
      pollFailures += 1;
      if (pollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(
          `Lost track of long-running command after repeated poll failures: ${String(error)}`,
        );
      }
      await sleep(pollIntervalMs);
      continue;
    }

    const { status, chunk } = readChunk(poll.stdout ?? "");
    if (chunk) {
      offset += Buffer.byteLength(chunk, "utf8");
      output += chunk;
      options.onOutput?.(chunk);
    }

    if (status !== RUNNING) {
      await cleanup();
      const statusCode = Number.parseInt(status, 10);
      return {
        stdout: output,
        statusCode: Number.isNaN(statusCode) ? null : statusCode,
        timedOut: false,
      };
    }

    if (Date.now() >= deadline) {
      await vm.exec({
        command: `pkill -TERM -f ${dir}/script.sh || true`,
        timeoutMs: STEP_TIMEOUT_MS,
      }).catch(() => {});
      await cleanup();
      return { stdout: output, statusCode: null, timedOut: true };
    }

    await sleep(pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
