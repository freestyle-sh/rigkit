import { cmux } from "@rigkit/provider-cmux";
import { freestyle, type FirewallSpec } from "@rigkit/provider-freestyle";
import { workflow } from "@rigkit/sdk";

const app = workflow("cmux-playground");
// A Freestyle VM reaches nothing it has not been allowed to.
const vmFirewall: FirewallSpec = {
  rules: [{ action: "allow", source: {}, destination: { public: true } }],
};
const freestyleProvider = freestyle.provider({
  apiKey: process.env.FREESTYLE_API_KEY,
});

export const cmuxPlayground = app
  .sequence("cmux-playground")
  .addProvider("freestyle", freestyleProvider)
  .task("create-snapshot", async ({ providers }) => {
    const { vm, vmId } = await providers.freestyle.client.vms.create({
      firewall: vmFirewall,
      idleTimeoutSeconds: 3600,
    });

    try {
      const snapshot = await vm.snapshot();
      return { ctx: { snapshotId: snapshot.snapshotId } };
    } finally {
      await providers.freestyle.client.vms.delete(vmId);
    }
  })
  .workspace({
    create: async ({ workflow, providers, step }) => {
      const { vmId } = await providers.freestyle.client.vms.create({
        snapshotId: workflow.ctx.snapshotId,
        firewall: vmFirewall,
        idleTimeoutSeconds: 3600,
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));

      return { vmId };
    },
    remove: async ({ providers, workspace }) => {
      await providers.freestyle.client.vms.delete(workspace.ctx.vmId);
    },
  })
  .addProvider("cmux", cmux.provider())
  .workspaceOperation("open", {
    title: "Open",
    description: "Open a cmux workspace",
    run: async ({ providers, workspace }) => {
      const cmuxWorkspace = await providers.cmux.ssh({
        ...await providers.freestyle.cmux.createSshOptions({
          vmId: workspace.ctx.vmId,
        }),
        name: workspace.name,
      });
      const terminal = await providers.cmux.newSurface({
        workspace: cmuxWorkspace.workspaceId,
        type: "terminal",
        focus: true,
      });
      await providers.cmux.send({
        workspace: cmuxWorkspace.workspaceId,
        surface: terminal.surfaceId,
        text: "echo hello world\n",
      });
      await providers.cmux.selectWorkspace(cmuxWorkspace.workspaceId);
    },
  });
