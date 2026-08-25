import type { WorkflowWorkspaceOperationHandler } from "@rigkit/sdk";
import { devEnvironmentPath, vmHome } from "../lib/config";
import type { WebsiteProviders } from "../lib/providers";
import { shellQuote } from "../lib/shell";
import type { WebsiteContext, WebsiteWorkspaceContext } from "../lib/types";
import { execOrThrow } from "../lib/vm";

type ExecuteCodexTaskInput = {
  task: string;
};

type CodexTaskSessionResult = {
  prUrl: string;
  branch: string;
};

type ExecuteCodexTaskResult = string;

const pollIntervalMs = 2_000;
const taskTimeoutMs = 60 * 60 * 1000;

export const executeCodexTaskOperation: WorkflowWorkspaceOperationHandler<
  WebsiteProviders,
  WebsiteContext,
  WebsiteWorkspaceContext,
  ExecuteCodexTaskInput,
  ExecuteCodexTaskResult
> = async ({ input, providers, workspace }) => {
  const task = input.task.trim();
  if (!task) {
    throw new Error("execute-codex-task requires a non-empty task string.");
  }

  const vm = providers.freestyle.client.vms.ref(workspace.ctx.vmId);
  const sessionName = `codex-task-${Date.now().toString(36)}`;
  const paths = codexTaskPaths(sessionName);

  console.log(`starting Codex task session ${sessionName}`);
  await execOrThrow(vm, "Codex task session start", {
    command: startCodexTaskSessionCommand({
      task,
      sessionName,
      branch: workspace.ctx.branch,
      repoPath: workspace.ctx.repoPath,
      paths,
    }),
    timeoutMs: 60 * 1000,
  });

  let offset = 0;
  const startedAt = Date.now();
  while (true) {
    await sleep(pollIntervalMs);

    const result = await execOrThrow(vm, "Codex task session poll", {
      command: readCodexTaskSessionCommand({ paths, offset }),
      timeoutMs: 30 * 1000,
    });
    const snapshot = parsePollOutput(result.stdout ?? "");
    offset = snapshot.size;

    if (snapshot.output) {
      console.log(snapshot.output.trimEnd());
    }

    if (snapshot.exitCode !== undefined) {
      if (snapshot.exitCode !== 0) {
        throw new Error(
          `Codex task session ${sessionName} failed with exit code ${snapshot.exitCode}.`,
        );
      }
      if (!snapshot.result) {
        throw new Error(
          `Codex task session ${sessionName} completed without writing a PR result.`,
        );
      }

      const parsed = parseTaskResult(snapshot.result, sessionName);
      console.log(`Codex task PR: ${parsed.prUrl}`);
      return parsed.prUrl;
    }

    if (Date.now() - startedAt > taskTimeoutMs) {
      await vm.exec({
        command: [
          "set -e",
          `if [ -f ${shellQuote(paths.pid)} ]; then kill "$(cat ${shellQuote(paths.pid)})" 2>/dev/null || true; fi`,
        ].join("\n"),
        timeoutMs: 30 * 1000,
      });
      throw new Error(
        `Codex task session ${sessionName} timed out after ${taskTimeoutMs / 1000} seconds.`,
      );
    }
  }
};

function codexTaskPaths(sessionName: string) {
  const dir = `${vmHome}/.local/share/rigkit/codex-tasks/${sessionName}`;
  return {
    dir,
    prompt: `${dir}/prompt.txt`,
    task: `${dir}/task.txt`,
    runner: `${dir}/run.sh`,
    log: `${dir}/output.log`,
    status: `${dir}/status`,
    result: `${dir}/result.json`,
    lastMessage: `${dir}/last-message.txt`,
    body: `${dir}/pr-body.md`,
    pid: `${dir}/session.pid`,
  };
}

function startCodexTaskSessionCommand(options: {
  task: string;
  sessionName: string;
  branch: string;
  repoPath: string;
  paths: ReturnType<typeof codexTaskPaths>;
}): string {
  const prompt = codexPrompt(options.task);

  return [
    "set -e",
    `export HOME=${shellQuote(vmHome)}`,
    `export PATH=${shellQuote(devEnvironmentPath)}:"$PATH"`,
    `mkdir -p ${shellQuote(options.paths.dir)}`,
    `printf '%s\\n' ${shellQuote(options.task)} > ${shellQuote(options.paths.task)}`,
    `printf '%s\\n' ${shellQuote(prompt)} > ${shellQuote(options.paths.prompt)}`,
    `rm -f ${shellQuote(options.paths.log)} ${shellQuote(options.paths.status)} ${shellQuote(options.paths.result)} ${shellQuote(options.paths.lastMessage)} ${shellQuote(options.paths.body)}`,
    `if [ -f ${shellQuote(options.paths.pid)} ]; then kill "$(cat ${shellQuote(options.paths.pid)})" 2>/dev/null || true; fi`,
    `cat > ${shellQuote(options.paths.runner)} <<'RIGKIT_CODEX_TASK_RUNNER'`,
    codexTaskRunnerScript({
      branch: options.branch,
      repoPath: options.repoPath,
      paths: options.paths,
    }),
    "RIGKIT_CODEX_TASK_RUNNER",
    `chmod +x ${shellQuote(options.paths.runner)}`,
    // Detach the runner so it survives this exec; it writes its own log/status files.
    `nohup ${shellQuote(options.paths.runner)} </dev/null >/dev/null 2>&1 &`,
    `echo $! > ${shellQuote(options.paths.pid)}`,
  ].join("\n");
}

function codexPrompt(task: string): string {
  return `${task}

When the implementation is complete, commit all relevant changes on the current branch, push the branch to GitHub, open a GitHub pull request, and include the pull request URL in your final response.`;
}

function codexTaskRunnerScript(options: {
  branch: string;
  repoPath: string;
  paths: ReturnType<typeof codexTaskPaths>;
}): string {
  return `#!/usr/bin/env bash
set +e

run_codex_task() {
  set -euo pipefail

  export HOME=${shellQuote(vmHome)}
  export PATH=${shellQuote(devEnvironmentPath)}:"$PATH"

  cd ${shellQuote(options.repoPath)}
  git config --global --add safe.directory ${shellQuote(options.repoPath)} >/dev/null 2>&1 || true
  git switch ${shellQuote(options.branch)}

  echo "== Codex task started at $(date -Is) =="
  codex exec \\
    --dangerously-bypass-approvals-and-sandbox \\
    --cd ${shellQuote(options.repoPath)} \\
    --color never \\
    --output-last-message ${shellQuote(options.paths.lastMessage)} \\
    - < ${shellQuote(options.paths.prompt)}
  echo "== Codex exec completed at $(date -Is) =="

  default_branch="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')"
  branch="$(git branch --show-current)"
  git fetch origin "$default_branch" --prune

  if [ -n "$(git status --porcelain)" ]; then
    first_line="$(sed -n '/[^[:space:]]/{s/^[[:space:]]*//; s/[[:space:]]*$//; p; q;}' ${shellQuote(options.paths.task)})"
    if [ -z "$first_line" ]; then
      first_line="update website"
    fi
    commit_message="Codex task: $first_line"
    if [ "\${#commit_message}" -gt 72 ]; then
      commit_message="\${commit_message:0:69}..."
    fi
    git add -A
    git commit -m "$commit_message"
  fi

  if git diff --quiet "origin/$default_branch"...HEAD; then
    existing_url="$(gh pr view --head "$branch" --json url --jq '.url' 2>/dev/null || true)"
    if [ -z "$existing_url" ]; then
      echo "No changes found between $branch and origin/$default_branch, and no existing PR was found." >&2
      exit 1
    fi
  fi

  git push -u origin HEAD

  pr_url="$(gh pr view --head "$branch" --json url --jq '.url' 2>/dev/null || true)"
  if [ -z "$pr_url" ]; then
    title="$(git log -1 --pretty=%s)"
    {
      echo "Automated Codex task."
      echo
      echo "Task:"
      echo
      cat ${shellQuote(options.paths.task)}
      if [ -s ${shellQuote(options.paths.lastMessage)} ]; then
        echo
        echo "Codex final response:"
        echo
        cat ${shellQuote(options.paths.lastMessage)}
      fi
    } > ${shellQuote(options.paths.body)}
    pr_url="$(gh pr create --base "$default_branch" --head "$branch" --title "$title" --body-file ${shellQuote(options.paths.body)})"
  fi

  node -e 'const fs = require("node:fs"); const [path, prUrl, branch] = process.argv.slice(1); fs.writeFileSync(path, JSON.stringify({ prUrl, branch }) + "\\n");' ${shellQuote(options.paths.result)} "$pr_url" "$branch"
  echo "== Pull request: $pr_url =="
}

run_codex_task > ${shellQuote(options.paths.log)} 2>&1
status=$?
printf '%s\\n' "$status" > ${shellQuote(options.paths.status)}
exit "$status"
`;
}

function readCodexTaskSessionCommand(options: {
  paths: ReturnType<typeof codexTaskPaths>;
  offset: number;
}): string {
  const begin = "__RIGKIT_CODEX_TASK_OUTPUT_BEGIN__";
  const end = "__RIGKIT_CODEX_TASK_OUTPUT_END__";

  return [
    "set -e",
    `log=${shellQuote(options.paths.log)}`,
    `status=${shellQuote(options.paths.status)}`,
    `result=${shellQuote(options.paths.result)}`,
    "size=0",
    'if [ -f "$log" ]; then size="$(wc -c < "$log" | tr -d " ")"; fi',
    'printf "__RIGKIT_CODEX_TASK_SIZE__ %s\\n" "$size"',
    `if [ "$size" -gt ${options.offset} ]; then`,
    `  printf '${begin}\\n'`,
    `  tail -c +$(( ${options.offset} + 1 )) "$log" || true`,
    `  printf '\\n${end}\\n'`,
    "fi",
    'if [ -f "$status" ]; then printf "__RIGKIT_CODEX_TASK_EXIT__ %s\\n" "$(cat "$status")"; fi',
    'if [ -f "$result" ]; then printf "__RIGKIT_CODEX_TASK_RESULT__ %s\\n" "$(cat "$result")"; fi',
  ].join("\n");
}

function parsePollOutput(output: string): {
  size: number;
  output: string;
  exitCode?: number;
  result?: string;
} {
  const sizeMatch = output.match(/^__RIGKIT_CODEX_TASK_SIZE__ (\d+)$/m);
  const exitMatch = output.match(/^__RIGKIT_CODEX_TASK_EXIT__ (\d+)$/m);
  const resultMatch = output.match(/^__RIGKIT_CODEX_TASK_RESULT__ (.+)$/m);
  return {
    size: sizeMatch ? Number(sizeMatch[1]) : 0,
    output: extractBetween(
      output,
      "__RIGKIT_CODEX_TASK_OUTPUT_BEGIN__\n",
      "\n__RIGKIT_CODEX_TASK_OUTPUT_END__",
    ),
    ...(exitMatch ? { exitCode: Number(exitMatch[1]) } : {}),
    ...(resultMatch ? { result: resultMatch[1] } : {}),
  };
}

function extractBetween(value: string, begin: string, end: string): string {
  const beginIndex = value.indexOf(begin);
  if (beginIndex === -1) return "";
  const contentIndex = beginIndex + begin.length;
  const endIndex = value.indexOf(end, contentIndex);
  if (endIndex === -1) return value.slice(contentIndex);
  return value.slice(contentIndex, endIndex);
}

function parseTaskResult(
  raw: string,
  sessionName: string,
): CodexTaskSessionResult {
  const parsed = JSON.parse(raw) as Partial<CodexTaskSessionResult>;
  if (!parsed.prUrl || !parsed.branch) {
    throw new Error(
      `Codex task session ${sessionName} wrote an invalid PR result: ${raw}`,
    );
  }
  return {
    prUrl: parsed.prUrl,
    branch: parsed.branch,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
