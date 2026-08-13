import {
  devCommand,
  devPort,
  repo,
  repoPath,
  repoUrl,
  vmHome,
  vmIdleTimeoutSeconds,
} from "../lib/config";
import { dirname, shellQuote } from "../lib/shell";
import type { SnapshotContext, WebsiteContext } from "../lib/types";
import { execOrThrow } from "../lib/vm";
import type { SetupTaskHandler } from "./types";

export const cloneAndInstallTask: SetupTaskHandler<
  SnapshotContext,
  WebsiteContext
> = async ({ step, providers }) => {
  const created = await providers.freestyle.client.vms.create({
    snapshotId: step.ctx.snapshotId,
    idleTimeoutSeconds: vmIdleTimeoutSeconds,
    logger: console.log,
  });
  const { vmId } = created;
  const { vm } = created;

  try {
    const cloned = await vm.exec(`test -d ${shellQuote(repoPath + "/.git")}`);

    if ((cloned.statusCode ?? 0) !== 0) {
      console.log("cloning website repo");
      await execOrThrow(vm, "website repo clone", {
        command: [
          "set -e",
          `export HOME=${shellQuote(vmHome)}`,
          `mkdir -p ${shellQuote(dirname(repoPath))}`,
          `gh repo clone ${shellQuote(repo)} ${shellQuote(repoPath)}`,
        ].join("\n"),
        timeoutMs: 5 * 60 * 1000,
      });
    }

    console.log("installing website dependencies");
    await execOrThrow(vm, "website dependency install", {
      command: [
        "set -e",
        `export HOME=${shellQuote(vmHome)}`,
        "export GIT_TERMINAL_PROMPT=0",
        `cd ${shellQuote(repoPath)}`,
        `git remote set-url origin ${shellQuote(repoUrl)}`,
        "git fetch --prune origin",
        "git config --global --add safe.directory " + shellQuote(repoPath),
        "bun install",
      ].join("\n"),
      timeoutMs: 10 * 60 * 1000,
    });

    const snapshot = await vm.snapshot();
    return {
      ctx: {
        snapshotId: snapshot.snapshotId,
        repoPath,
        repo,
        devCommand,
        devPort,
      },
    };
  } finally {
    await providers.freestyle.client.vms.delete({ vmId });
  }
};
