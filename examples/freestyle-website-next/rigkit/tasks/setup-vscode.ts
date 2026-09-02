import {
  detectLocalVscode,
  installVscodeServerCommand,
} from "@rigkit/provider-freestyle";
import { vmFirewall, vmHome, vmIdleTimeoutSeconds } from "../lib/config";
import type { SnapshotContext } from "../lib/types";
import { execOrThrow } from "../lib/vm";
import type { SetupTaskHandler } from "./types";

// Detected once at definition load. Remote-SSH downloads a server matching
// the client's exact commit on first connect; baking that build into the
// snapshot makes "Open VS Code" connect instantly. The commit is part of the
// task version below, so updating VS Code locally rebuilds this stage.
export const localVscode = detectLocalVscode();

export const setupVscodeTaskVersion = `vscode-server-${localVscode?.commit ?? "none"}`;

export const setupVscodeTask: SetupTaskHandler<
  SnapshotContext,
  SnapshotContext
> = async ({ step, providers }) => {
  if (!localVscode) {
    console.log(
      "no local VS Code found (code --version failed); Remote-SSH will install its server on first connect",
    );
    return { ctx: { ...step.ctx } };
  }

  console.log(
    `preinstalling VS Code server ${localVscode.version} (${localVscode.commit.slice(0, 10)})`,
  );
  const { vm, vmId } = await providers.freestyle.client.vms.create({
    snapshotId: step.ctx.snapshotId,
    firewall: vmFirewall,
    idleTimeoutSeconds: vmIdleTimeoutSeconds,
  });
  try {
    await execOrThrow(vm, "VS Code server preinstall", {
      command: installVscodeServerCommand({
        commit: localVscode.commit,
        home: vmHome,
      }),
      timeoutMs: 5 * 60 * 1000,
    });

    const snapshot = await vm.snapshot();
    return { ctx: { snapshotId: snapshot.snapshotId } };
  } finally {
    await providers.freestyle.client.vms.delete(vmId);
  }
};
