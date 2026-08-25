import { vmFirewall, vmIdleTimeoutSeconds } from "../lib/config";
import {
  installAptDependenciesCommand,
  installJavaScriptToolsCommand,
  verifySystemDependenciesCommand,
} from "../lib/commands";
import type { SnapshotContext } from "../lib/types";
import { execOrThrow } from "../lib/vm";
import type { SetupTaskHandler } from "./types";

type SnapshotStageInput = {
  label: string;
  command: string;
  timeoutMs: number;
  snapshotId?: string;
};

async function runSnapshotStage(
  providers: Parameters<SetupTaskHandler<Record<string, never>, SnapshotContext>>[0]["providers"],
  input: SnapshotStageInput,
): Promise<{ ctx: SnapshotContext }> {
  const { vm, vmId } = await providers.freestyle.client.vms.create({
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    firewall: vmFirewall,
    idleTimeoutSeconds: vmIdleTimeoutSeconds,
  });

  try {
    await execOrThrow(vm, input.label, {
      command: input.command,
      timeoutMs: input.timeoutMs,
    });

    const snapshot = await vm.snapshot();
    return { ctx: { snapshotId: snapshot.snapshotId } };
  } finally {
    await providers.freestyle.client.vms.delete(vmId);
  }
}

export const installAptDependenciesTask: SetupTaskHandler<
  Record<string, never>,
  SnapshotContext
> = async ({ providers }) => {
  console.log("installing apt/base dependencies");
  return runSnapshotStage(providers, {
    label: "apt/base dependency install",
    command: installAptDependenciesCommand(),
    timeoutMs: 15 * 60 * 1000,
  });
};

export const installJavaScriptToolsTask: SetupTaskHandler<
  SnapshotContext,
  SnapshotContext
> = async ({ step, providers }) => {
  console.log("installing bun and codex");
  return runSnapshotStage(providers, {
    snapshotId: step.ctx.snapshotId,
    label: "javascript tool install",
    command: installJavaScriptToolsCommand(),
    timeoutMs: 10 * 60 * 1000,
  });
};

export const verifySystemDependenciesTask: SetupTaskHandler<
  SnapshotContext,
  SnapshotContext
> = async ({ step, providers }) => {
  console.log("verifying base tools");
  return runSnapshotStage(providers, {
    snapshotId: step.ctx.snapshotId,
    label: "system dependency verification",
    command: verifySystemDependenciesCommand(),
    timeoutMs: 60 * 1000,
  });
};
