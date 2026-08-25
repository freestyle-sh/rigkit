import {
  withFreestyleCompanyBase,
  type FreestyleCompanyBaseFragmentContext,
} from "@rigkit/fragments";
import { freestyle, type FirewallSpec } from "@rigkit/provider-freestyle";
import { workflow } from "@rigkit/sdk";

const projectPath = "/workspace/company-project";
// A Freestyle VM reaches nothing it has not been allowed to.
const vmFirewall: FirewallSpec = {
  rules: [{ action: "allow", source: {}, destination: { public: true } }],
};

const app = workflow("base-freestyle-fragment-example");
const freestyleProvider = freestyle.provider();
const terminalProvider = freestyle.terminal();

const companyBaseOptions = {
  github: envBoolean("RIGKIT_BASE_GITHUB", true),
  codex: envBoolean("RIGKIT_BASE_CODEX", true),
  claude: envBoolean("RIGKIT_BASE_CLAUDE", true),
  vm: {
    home: envString("RIGKIT_BASE_HOME", "/root"),
    memSizeGb: envNumber("RIGKIT_BASE_MEM_SIZE_GB", 16),
    vcpuCount: envNumber("RIGKIT_BASE_VCPU_COUNT", 4),
    rootfsSizeGb: envNumber("RIGKIT_BASE_ROOTFS_SIZE_GB", 24),
  },
};

const projectSetup = app
  .sequence<FreestyleCompanyBaseFragmentContext>("company-project-setup")
  .addProvider("freestyle", freestyleProvider)
  .task("prepare-project-image", async ({ providers, step }) => {
    const created = await providers.freestyle.client.vms.create({
      snapshotId: step.ctx.snapshotId,
      firewall: vmFirewall,
      idleTimeoutSeconds: step.ctx.freestyleCompanyBase.idleTimeoutSeconds,
    });
    const { vm, vmId } = created;
    try {
      const prepared = await vm.exec({
        command: [
          "set -e",
          `mkdir -p ${shellQuote(projectPath)}`,
          `cat > ${shellQuote(`${projectPath}/README.md`)} <<'EOF'`,
          "# Company Project Workspace",
          "",
          "This workspace was built on top of the shared Freestyle base fragment.",
          "Repo-specific setup starts here.",
          "EOF",
          `cat > ${shellQuote(`${projectPath}/base-tools.json`)} <<'EOF'`,
          JSON.stringify(
            {
              tools: step.ctx.freestyleCompanyBase.tools,
              authenticated: step.ctx.freestyleCompanyBase.authenticated,
              npmPackages: step.ctx.freestyleCompanyBase.npmPackages,
              systemPackages: step.ctx.freestyleCompanyBase.systemPackages,
            },
            null,
            2,
          ),
          "EOF",
        ].join("\n"),
        timeoutMs: 60 * 1000,
      });
      if ((prepared.statusCode ?? 0) !== 0) {
        throw new Error(
          `project image setup failed:\n${prepared.stdout ?? ""}${prepared.stderr ?? ""}`.trim(),
        );
      }

      const snapshot = await vm.snapshot();
      return {
        ctx: {
          ...step.ctx,
          snapshotId: snapshot.snapshotId,
          project: {
            path: projectPath,
            snapshotId: snapshot.snapshotId,
          },
        },
      };
    } finally {
      await providers.freestyle.client.vms.delete(vmId);
    }
  })
  .task("marker", async ({ step }) => {
    console.log(
      "project setup complete, snapshot with project files is ready to be used by workspaces",
    );
    return {
      ctx: step.ctx,
    };
  });

export const baseFreestyleFragmentExample = app
  .sequence("company-project")
  .add(withFreestyleCompanyBase(projectSetup, companyBaseOptions))
  .addProvider("freestyle", freestyleProvider)
  .addProvider("terminal", terminalProvider)
  .workspace({
    create: async ({ workflow, providers, workspace }) => {
      const created = await providers.freestyle.client.vms.create({
        snapshotId: workflow.ctx.snapshotId,
        firewall: vmFirewall,
        idleTimeoutSeconds:
          workflow.ctx.freestyleCompanyBase.idleTimeoutSeconds,
      });
      const { vmId } = created;
      try {
        return {
          vmId,
          name: workspace.name,
          projectPath: workflow.ctx.project.path,
          baseSnapshotId: workflow.ctx.freestyleCompanyBase.snapshotId,
          projectSnapshotId: workflow.ctx.project.snapshotId,
          tools: workflow.ctx.freestyleCompanyBase.tools,
          authenticated: workflow.ctx.freestyleCompanyBase.authenticated,
        };
      } catch (error) {
        await providers.freestyle.client.vms.delete(vmId);
        throw error;
      }
    },
    remove: async ({ providers, workspace }) => {
      await providers.freestyle.client.vms.delete(workspace.ctx.vmId);
    },
  })
  .workspaceOperation("ssh", {
    title: "SSH",
    description: "Open an interactive shell in the workspace",
    run: async ({ providers, workspace }) => {
      await providers.terminal.open(`SSH ${workspace.name}`, {
        ssh: await providers.freestyle.createSSHOptions({
          vmId: workspace.ctx.vmId,
        }),
        command: `cd ${shellQuote(workspace.ctx.projectPath)} && exec bash -l`,
        keepOpenAfterCommand: true,
        instructions: "Exit the SSH session when you are done.",
      });
    },
  })
  .workspaceOperation("status", {
    title: "Status",
    description: "Return the base fragment settings used by this workspace",
    run: async ({ workspace }) => ({
      workspace: workspace.name,
      projectPath: workspace.ctx.projectPath,
      tools: workspace.ctx.tools,
      authenticated: workspace.ctx.authenticated,
      baseSnapshotId: workspace.ctx.baseSnapshotId,
      projectSnapshotId: workspace.ctx.projectSnapshotId,
    }),
  });

function envString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(
    `${name} must be one of 1, 0, true, false, yes, no, on, or off`,
  );
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
