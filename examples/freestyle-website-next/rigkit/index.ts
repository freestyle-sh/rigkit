import { workflow, z } from "@rigkit/sdk";
import {
  attachDevServerLogCommand,
  startDevServerCommand,
} from "./lib/commands";
import { vmIdleTimeoutSeconds } from "./lib/config";
import {
  cmuxProvider,
  freestyleProvider,
  terminalProvider,
} from "./lib/providers";
import { shellQuote } from "./lib/shell";
import { cloneAndInstallTask } from "./tasks/clone-and-install";
import { executeCodexTaskOperation } from "./tasks/execute-codex-task";
import { githubAuthTask } from "./tasks/github-auth";
import { initializeCodexCliTask } from "./tasks/initialize-codex-cli";
import {
  installAptDependenciesTask,
  installJavaScriptToolsTask,
  verifySystemDependenciesTask,
} from "./tasks/install-dependencies";
import { updateCodexCliAndEnableGoalTask } from "./tasks/update-codex-cli-and-enable-goal";
import { execOrThrow, waitForLocalhostHtml } from "./lib/vm";

const app = workflow("freestyle-website-next");

const websiteSetup = app
  .sequence("website-setup")
  .addProvider("freestyle", freestyleProvider)
  .addProvider("terminal", terminalProvider)
  .task(
    "install-apt-dependencies",
    { version: "apt-dependencies-node22-v2" },
    installAptDependenciesTask,
  )
  .task(
    "install-javascript-tools",
    { version: "javascript-tools-node22-v3" },
    installJavaScriptToolsTask,
  )
  .task(
    "verify-system-dependencies",
    { version: "system-dependency-verification-v2" },
    verifySystemDependenciesTask,
  )
  .task("github-auth", { version: "github-auth-root-v6" }, githubAuthTask)
  .task(
    "clone-and-install",
    { version: "website-clone-and-install-v3" },
    cloneAndInstallTask,
  )
  .task(
    "initialize-codex-cli",
    { version: "codex-cli-initialization-v1" },
    initializeCodexCliTask,
  )
  .task(
    "update-codex-cli-and-enable-goal",
    { version: "codex-cli-goals-v1", cacheTTL: "24h" },
    updateCodexCliAndEnableGoalTask,
  );

export const freestyleWebsiteNext = app
  .sequence("website")
  .add(websiteSetup)
  .addProvider("freestyle", freestyleProvider)
  .addProvider("terminal", terminalProvider)
  .workspace({
    create: async ({ workflow, providers, workspace }) => {
      const created = await providers.freestyle.client.vms.create({
        snapshotId: workflow.ctx.snapshotId,
        idleTimeoutSeconds: vmIdleTimeoutSeconds,
      });
      const { vmId } = created;
      const { vm } = created;
      try {
        const branch = `rigkit/${workspace.name.replaceAll(/[^A-Za-z0-9._/-]/g, "-")}`;
        const result = await vm.exec(
          [
            "set -e",
            `cd ${shellQuote(workflow.ctx.repoPath)}`,
            `git switch -C ${shellQuote(branch)}`,
          ].join("\n"),
        );
        if ((result.statusCode ?? 0) !== 0) {
          throw new Error(
            `workspace branch creation failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
          );
        }
        // The setup snapshot no longer bakes in a running dev server (shpool is
        // gone), so start it here in the freshly forked workspace VM.
        await execOrThrow(vm, "website dev server start", {
          command: startDevServerCommand({
            repoPath: workflow.ctx.repoPath,
            command: workflow.ctx.devCommand,
          }),
          timeoutMs: 60 * 1000,
        });
        await waitForLocalhostHtml(vm, workflow.ctx.devPort);
        return {
          vmId,
          repoPath: workflow.ctx.repoPath,
          repo: workflow.ctx.repo,
          branch,
          devCommand: workflow.ctx.devCommand,
          devPort: workflow.ctx.devPort,
        };
      } catch (error) {
        await providers.freestyle.client.vms.delete({ vmId });
        throw error;
      }
    },
    remove: async ({ providers, workspace }) => {
      await providers.freestyle.client.vms.delete({ vmId: workspace.ctx.vmId });
    },
  })
  .addProvider("cmux", cmuxProvider)
  .workspaceOperation("open-cmux", {
    title: "Open cmux",
    description: "Open the website workspace in cmux",
    run: async ({ providers, workspace }) => {
      const cmuxWorkspace = await providers.cmux.ssh({
        ...(await providers.freestyle.cmux.createSshOptions({
          vmId: workspace.ctx.vmId,
        })),
        name: workspace.name,
      });
      await providers.cmux.newSurface({
        workspace: cmuxWorkspace.workspaceId,
        type: "browser",
        url: `http://localhost:${workspace.ctx.devPort}`,
        focus: true,
      });
      const devTerminal = await providers.cmux.newSurface({
        workspace: cmuxWorkspace.workspaceId,
        type: "terminal",
        focus: false,
      });
      await providers.cmux.send({
        workspace: cmuxWorkspace.workspaceId,
        surface: devTerminal.surfaceId,
        text: `${attachDevServerLogCommand()}\n`,
      });
      const codexTerminal = await providers.cmux.newSurface({
        workspace: cmuxWorkspace.workspaceId,
        type: "terminal",
        focus: false,
      });
      await providers.cmux.send({
        workspace: cmuxWorkspace.workspaceId,
        surface: codexTerminal.surfaceId,
        text: `cd ${shellQuote(workspace.ctx.repoPath)} && codex\n`,
      });
      await providers.cmux.selectWorkspace(cmuxWorkspace.workspaceId);
    },
  })
  .workspaceOperation("execute-codex-task", {
    title: "Execute Codex task",
    description:
      "Run Codex on a task, push the branch, open a PR, and return the PR URL",
    input: z.object({
      task: z.string().min(1).describe("Task instructions for Codex"),
    }),
    run: executeCodexTaskOperation,
  })
  .workspaceOperation("open-vscode", {
    title: "Open VS Code",
    description: "Open the website workspace in VS Code",
    run: async ({ providers, workspace, local }) => {
      const url = await providers.freestyle.vscode.createUrl({
        vmId: workspace.ctx.vmId,
        cwd: workspace.ctx.repoPath,
      });
      await local.open(url);
    },
  })
  .workspaceOperation("ssh", {
    title: "SSH",
    description: "Open an interactive SSH session",
    run: async ({ providers, workspace }) => {
      await providers.terminal.open(`SSH ${workspace.name}`, {
        ssh: await providers.freestyle.createSSHOptions({
          vmId: workspace.ctx.vmId,
        }),
        command: `cd ${shellQuote(workspace.ctx.repoPath)} && exec bash -l`,
        keepOpenAfterCommand: true,
        instructions: "Exit the SSH session when you are done.",
      });
    },
  });
