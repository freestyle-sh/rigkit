import { updateCodexCliAndEnableGoalsCommand } from "../lib/commands";
import { vmFirewall, vmIdleTimeoutSeconds } from "../lib/config";
import type { WebsiteContext } from "../lib/types";
import { execOrThrow } from "../lib/vm";
import type { SetupTaskHandler } from "./types";

export const updateCodexCliAndEnableGoalTask: SetupTaskHandler<
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
    console.log("updating Codex CLI and enabling /goal");
    await execOrThrow(vm, "Codex CLI update and /goal enablement", {
      command: updateCodexCliAndEnableGoalsCommand(),
      timeoutMs: 10 * 60 * 1000,
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
