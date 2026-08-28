import {
  configureGitIdentityCommand,
  withVmHome,
} from "../lib/commands";
import { vmFirewall, vmIdleTimeoutSeconds } from "../lib/config";
import type { SnapshotContext } from "../lib/types";
import { execOrThrow } from "../lib/vm";
import type { SetupTaskHandler } from "./types";

export const githubAuthTask: SetupTaskHandler<
  SnapshotContext,
  SnapshotContext
> = async ({ step, providers }) => {
  const created = await providers.freestyle.client.vms.create({
    snapshotId: step.ctx.snapshotId,
    firewall: vmFirewall,
    idleTimeoutSeconds: vmIdleTimeoutSeconds,
  });
  const { vmId } = created;
  const { vm } = created;

  try {
    const authenticated = await vm.exec(
      withVmHome("gh auth status -h github.com >/dev/null 2>&1"),
    );
    if ((authenticated.statusCode ?? 0) !== 0) {
      await providers.freestyle.terminal.open("Log in to GitHub", {
        vmId,
        command: withVmHome(
          "gh auth login --hostname github.com --git-protocol https --web",
        ),
        instructions:
          "Complete the GitHub device/browser login in this terminal. The task will be ready to continue when gh exits successfully.",
      });

      const verified = await vm.exec(
        withVmHome("gh auth status -h github.com >/dev/null 2>&1"),
      );
      if ((verified.statusCode ?? 0) !== 0) {
        const status = await vm.exec(
          withVmHome("gh auth status -h github.com 2>&1"),
        );
        throw new Error(
          `GitHub CLI is not authenticated:\n${status.stdout || status.stderr}`.trim(),
        );
      }
    }

    console.log("configuring Git author identity from GitHub account");
    await execOrThrow(vm, "Git author identity configuration", {
      command: configureGitIdentityCommand(),
      timeoutMs: 60 * 1000,
    });

    const snapshot = await vm.snapshot();
    return { ctx: { snapshotId: snapshot.snapshotId } };
  } finally {
    await providers.freestyle.client.vms.delete(vmId);
  }
};
