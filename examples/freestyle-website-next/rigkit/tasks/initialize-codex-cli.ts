import { agentCliInitCommand } from "../lib/commands";
import { vmFirewall, vmIdleTimeoutSeconds } from "../lib/config";
import type { WebsiteContext } from "../lib/types";
import type { SetupTaskHandler } from "./types";

export const initializeCodexCliTask: SetupTaskHandler<
  WebsiteContext,
  WebsiteContext
> = async ({ step, providers }) => {
  const created = await providers.freestyle.client.vms.create({
    snapshotId: step.ctx.snapshotId,
    firewall: vmFirewall,
    idleTimeoutSeconds: vmIdleTimeoutSeconds,
  });
  const { vmId } = created;
  const { vm } = created;

  try {
    await providers.freestyle.terminal.open("Initialize Codex CLI", {
      vmId,
      command: agentCliInitCommand("codex"),
      canFinishWhileRunning: true,
      instructions:
        "Codex CLI is running inside the cloned website repo. Complete the login and workspace trust prompts, then exit Codex or click Complete task.",
    });

    const snapshot = await vm.snapshot();
    return {
      ctx: {
        ...step.ctx,
        snapshotId: snapshot.snapshotId,
      },
    };
  } finally {
    await providers.freestyle.client.vms.delete(vmId);
  }
};
