import { workflow } from "@rigkit/sdk";
import { execLongCommand, freestyle, type FirewallSpec } from "@rigkit/provider-freestyle";
import {
  copyGcloudConfig,
  gcloudCopiedConfigReadyCommand,
} from "@rigkit/provider-gcloud-cli";

const vmIdleTimeoutSeconds = 3600;
// A Freestyle VM reaches nothing it has not been allowed to; the installs
// below need the public internet.
const vmFirewall: FirewallSpec = {
  rules: [{ action: "allow", source: {}, destination: { public: true } }],
};

const app = workflow("gcloud-on-open");
const freestyleProvider = freestyle.provider();
const gcloudConfigProvider = copyGcloudConfig.provider({
  requireAuth: true,
});

const baseVm = app
  .sequence("base-vm")
  .addProvider("freestyle", freestyleProvider)
  .task("install-dependencies", async ({ providers }) => {
    const { vm, vmId } = await providers.freestyle.client.vms.create({
      firewall: vmFirewall,
      idleTimeoutSeconds: vmIdleTimeoutSeconds,
    });
    try {
      await vm.resize({ memory: 16 * 1024 });
      console.log("installing gcloud cli");
      const result = await execLongCommand(vm, {
        command: installGcloudCliCommand(),
        timeoutMs: 10 * 60 * 1000,
        onOutput: (chunk) => console.log(chunk.trimEnd()),
      });
      if (result.timedOut || (result.statusCode ?? 0) !== 0) {
        throw new Error(`gcloud cli install ${result.timedOut ? "timed out" : "failed"}:\n${result.stdout}`.trim());
      }
      const snapshot = await vm.snapshot();
      return { ctx: { snapshotId: snapshot.snapshotId } };
    } finally {
      await providers.freestyle.client.vms.delete(vmId);
    }
  });

export const gcloudOnOpen = app
  .sequence("gcloud-workspace")
  .add(baseVm)
  .task("marker", async ({ step }) => {
    return {
      ctx: {
        snapshotId: step.ctx.snapshotId,
        workspaceNote:
          "local gcloud config files are copied by the inject-gcloud workspace operation",
      },
    };
  })
  .addProvider("freestyle", freestyleProvider)
  .addProvider("gcloudConfig", gcloudConfigProvider)
  .workspace({
    create: async ({ workflow, providers }) => {
      const gcloudConfigFiles = await providers.gcloudConfig.configFiles();
      const { vm, vmId } = await providers.freestyle.client.vms.create({
        snapshotId: workflow.ctx.snapshotId,
        firewall: vmFirewall,
        idleTimeoutSeconds: vmIdleTimeoutSeconds,
      });

      try {
        console.log("copying local gcloud config");
        await vm.fs.remove("/root/.config/gcloud").catch(() => {});
        await vm.fs.mkdir("/root/.config/gcloud");
        for (const file of gcloudConfigFiles.files) {
          const path = `/root/.config/gcloud/${file.path}`;
          const dir = path.slice(0, path.lastIndexOf("/"));
          await vm.fs.mkdir(dir);
          await vm.fs.writeFile(path, Buffer.from(file.contentsBase64, "base64"));
          await vm.exec(`chmod 600 ${shellQuote(path)}`);
        }
        if (gcloudConfigFiles.account) {
          const result = await vm.exec(`gcloud config set account ${shellQuote(gcloudConfigFiles.account)} >/dev/null`);
          if ((result.statusCode ?? 0) !== 0) {
            throw new Error(`gcloud account selection failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
          }
        }

        const verified = await vm.exec(gcloudCopiedConfigReadyCommand());
        if ((verified.statusCode ?? 0) !== 0) {
          throw new Error(`gcloud did not accept the copied config files:\n${verified.stdout ?? ""}${verified.stderr ?? ""}`.trim());
        }

        const ssh = await providers.freestyle.createSSHOptions({ vmId });
        console.log(
          [
            `SSH command:\n${ssh.command}`,
            "",
            "Verify inside the VM with: gcloud auth list",
          ].join("\n"),
        );

        return { vmId };
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
    description: "Open an SSH session to the workspace VM",
    run: async ({ providers, workspace, local }) => {
      if (!local.command) {
        throw new Error("This host does not support interactive commands");
      }

      const ssh = await providers.freestyle.createSSHOptions({ vmId: workspace.ctx.vmId });
      const commandResult = await local.command({
        argv: ["sh", "-lc", ssh.command],
        mode: "interactive",
        reason: `Open SSH session to ${workspace.name}`,
        presentation: {
          visible: true,
          label: `SSH ${workspace.name}`,
        },
      });

      return {
        command: ssh.command,
        commandResult,
      };
    },
  });

function installGcloudCliCommand(): string {
  return [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq ca-certificates curl gnupg",
    "if ! command -v gcloud >/dev/null 2>&1; then",
    "  mkdir -p /etc/apt/keyrings",
    "  rm -f /etc/apt/keyrings/google-cloud-cli.gpg",
    "  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /etc/apt/keyrings/google-cloud-cli.gpg",
    "  chmod go+r /etc/apt/keyrings/google-cloud-cli.gpg",
    "  printf 'deb [signed-by=/etc/apt/keyrings/google-cloud-cli.gpg] https://packages.cloud.google.com/apt cloud-sdk main\\n' > /etc/apt/sources.list.d/google-cloud-sdk.list",
    "  apt-get update -qq",
    "  apt-get install -y -qq google-cloud-cli",
    "fi",
    "gcloud --version",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
