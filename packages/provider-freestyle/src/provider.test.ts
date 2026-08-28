import { afterEach, describe, expect, test } from "bun:test";
import { Freestyle } from "freestyle";
import type { ProviderInteractionSession, ProviderRuntimeContext } from "@rigkit/engine";
import { freestyleIdentityId, freestyleToken } from "./auth.ts";
import {
  buildInteractiveSshCommand,
  createFreestyleTerminalController,
  createFreestyleWorkflowController,
} from "./provider.ts";

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

describe("Freestyle provider host adapters", () => {
  test("creates SSH options and grants VM access internally", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (resource, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(resource)}`);
      return Response.json({});
    }) as typeof fetch;

    const runtime = await createFreestyleWorkflowController({
      client: new Freestyle({ apiKey: "test-key" }),
      identityId: freestyleIdentityId("identity-stream"),
      token: freestyleToken("token"),
    }).runtime(providerContext());

    await expect(runtime.createSSHOptions({ vmId: "vm-stream" })).resolves.toEqual({
      kind: "ssh",
      host: "beta-ssh.freestyle.sh",
      username: "vm-stream+root",
      auth: { type: "token", token: "token" },
      command: "ssh vm-stream+root:token@beta-ssh.freestyle.sh",
    });
    expect(requests).toContain("POST https://beta-api.freestyle.sh/v5/identities/identity-stream/permissions/vm");
  });

  test("creates cmux ssh options with Freestyle-owned ssh settings", async () => {
    globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;

    const runtime = await createFreestyleWorkflowController({
      client: new Freestyle({ apiKey: "test-key" }),
      identityId: freestyleIdentityId("identity-stream"),
      token: freestyleToken("token"),
    }).runtime(providerContext());

    const ssh = await runtime.cmux.createSshOptions({
      vmId: "vm-stream",
      sshOptions: ["ServerAliveInterval=15"],
      skipDaemonBootstrap: true,
    });

    expect(ssh).toEqual({
      kind: "ssh",
      destination: "vm-stream,token@vm-stream.beta-ssh.freestyle.sh",
      skipDaemonBootstrap: true,
      sshOptions: [
        "StrictHostKeyChecking=no",
        "UserKnownHostsFile=/dev/null",
        "LogLevel=ERROR",
        "IdentitiesOnly=yes",
        "IdentityFile=/dev/null",
        "ControlMaster=no",
        "ServerAliveInterval=15",
      ],
    });
  });

  test("treats existing VM permissions as idempotent for cmux ssh options", async () => {
    const calls: string[] = [];
    const runtime = await createFreestyleWorkflowController({
      client: {
        identities: {
          ref: () => ({
            permissions: {
              vm: {
                grant: async () => {
                  calls.push("grant");
                  throw new Error("PERMISSION_ALREADY_EXISTS: Permission already exists");
                },
                update: async () => {
                  calls.push("update");
                },
              },
            },
          }),
        },
      } as unknown as Freestyle,
      identityId: freestyleIdentityId("identity-stream"),
      token: freestyleToken("token"),
    }).runtime(providerContext());

    await expect(runtime.cmux.createSshOptions({ vmId: "vm-stream" })).resolves.toMatchObject({
      destination: "vm-stream,token@vm-stream.beta-ssh.freestyle.sh",
    });
    expect(calls).toEqual(["grant", "update"]);
  });

  test("creates VS Code URLs using the Freestyle ssh authority", async () => {
    globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;

    const runtime = await createFreestyleWorkflowController({
      client: new Freestyle({ apiKey: "test-key" }),
      identityId: freestyleIdentityId("identity-stream"),
      token: freestyleToken("token"),
    }).runtime(providerContext());

    const url = await runtime.vscode.createUrl({ vmId: "vm-stream", cwd: "/workspace/site" });

    // VS Code splits the remote authority on "+", so the default-user URL
    // must carry no user suffix and no percent-encoding.
    expect(url).toBe(
      "vscode://vscode-remote/ssh-remote+vm-stream,token@vm-stream.beta-ssh.freestyle.sh/workspace/site?windowId=_blank",
    );

    const withUser = await runtime.vscode.createUrl({ vmId: "vm-stream", user: "developer" });
    expect(withUser).toBe(
      "vscode://vscode-remote/ssh-remote+vm-stream+developer,token@vm-stream.beta-ssh.freestyle.sh?windowId=_blank",
    );
  });

  test("honors explicit SSH users", async () => {
    globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;

    const runtime = await createFreestyleWorkflowController({
      client: new Freestyle({ apiKey: "test-key" }),
      identityId: freestyleIdentityId("identity-stream"),
      token: freestyleToken("token"),
    }).runtime(providerContext());

    await expect(runtime.createSSHOptions({ vmId: "vm-stream", user: "ubuntu" })).resolves.toMatchObject({
      username: "vm-stream+ubuntu",
      command: "ssh vm-stream+ubuntu:token@beta-ssh.freestyle.sh",
    });
  });

  test("opens VM commands through the SDK PTY without creating SSH options", async () => {
    let referencedVmId = "";
    let html = "";
    const vm = { pty: {} };
    const runtime = await createFreestyleWorkflowController({
      client: {
        vms: {
          ref: (vmId: string) => {
            referencedVmId = vmId;
            return vm;
          },
        },
      } as unknown as Freestyle,
      identityId: freestyleIdentityId("identity-stream"),
      token: freestyleToken("token"),
    }).runtime({
      ...providerContext(),
      interaction: {
        present: async <Result>(session: ProviderInteractionSession<Result>) => {
          html = await (await fetch(session.url)).text();
          await session.stop();
          return { finished: true } as Result;
        },
      },
    });

    await expect(runtime.terminal.open("Claude auth", {
      vmId: "vm-pty",
      command: "claude auth login",
      instructions: "Sign in from this terminal.",
    })).resolves.toEqual({ finished: true });

    expect(referencedVmId).toBe("vm-pty");
    expect(html).toContain("claude auth login");
    expect(html).toContain("Sign in from this terminal.");
    expect(html).toContain("const startupInput = null;");
    expect(html).toContain("const canFinishWhileRunning = false;");
  });

  test("runs terminal commands as SSH remote commands instead of typed startup input", async () => {
    let html = "";
    const runtime = await createFreestyleTerminalController().runtime({
      ...providerContext(),
      interaction: {
        present: async <Result>(session: ProviderInteractionSession<Result>) => {
          const response = await fetch(session.url);
          html = await response.text();
          session.stop();
          return { finished: true } as Result;
        },
      },
    });

    await expect(runtime.open("GitHub auth", {
      ssh: {
        kind: "ssh",
        host: "beta-ssh.freestyle.sh",
        username: "vm-stream+root",
        auth: { type: "token", token: "token" },
        command: "ssh vm-stream+root:token@beta-ssh.freestyle.sh",
      },
      command: "gh auth login --hostname github.com",
    })).resolves.toEqual({ finished: true });

    expect(html).toContain("gh auth login --hostname github.com");
    expect(html).toContain("const startupInput = null;");
    expect(html).toContain("const canFinishWhileRunning = false;");
  });

  test("interactive SSH commands never prompt for host key confirmation", () => {
    const command = buildInteractiveSshCommand(
      {
        kind: "ssh",
        host: "beta-ssh.freestyle.sh",
        username: "vm-stream+root",
        auth: { type: "token", token: "token" },
        command: "ssh vm-stream+root:token@beta-ssh.freestyle.sh",
      },
      undefined,
    );

    expect(command).toContain("-o 'StrictHostKeyChecking=no'");
    expect(command).toContain("-o 'UserKnownHostsFile=/dev/null'");
    expect(command).toContain("-o 'IdentityFile=/dev/null'");
    expect(command).toContain("'vm-stream+root:token@beta-ssh.freestyle.sh'");
  });

  test("sets remote browser open fallbacks for SSH terminal commands", () => {
    const command = buildInteractiveSshCommand(
      {
        kind: "ssh",
        host: "beta-ssh.freestyle.sh",
        username: "vm-stream+root",
        auth: { type: "token", token: "token" },
        command: "ssh vm-stream+root:token@beta-ssh.freestyle.sh",
      },
      "gh auth login --hostname github.com --web",
    );

    expect(command).toContain('export BROWSER="${BROWSER:-true}"');
    expect(command).toContain('export GH_BROWSER="${GH_BROWSER:-$BROWSER}"');
    expect(command).toContain("gh auth login --hostname github.com --web");
  });

  test("can keep an SSH terminal open after a successful remote command", () => {
    const command = buildInteractiveSshCommand(
      {
        kind: "ssh",
        host: "beta-ssh.freestyle.sh",
        username: "vm-stream+root",
        auth: { type: "token", token: "token" },
        command: "ssh vm-stream+root:token@beta-ssh.freestyle.sh",
      },
      "gh auth status -h github.com",
      { keepOpenAfterCommand: true },
    );

    expect(command).toContain("gh auth status -h github.com");
    expect(command).toContain("status=$?");
    expect(command).toContain('if [ "$status" -ne 0 ]; then exit "$status"; fi');
    expect(command).toContain('exec "${SHELL:-/bin/bash}" -l');
  });

  test("allows finishing while a keep-open SSH command is running", async () => {
    let html = "";
    const runtime = await createFreestyleTerminalController().runtime({
      ...providerContext(),
      interaction: {
        present: async <Result>(session: ProviderInteractionSession<Result>) => {
          const response = await fetch(session.url);
          html = await response.text();
          session.stop();
          return { finished: true } as Result;
        },
      },
    });

    await runtime.open("GitHub auth", {
      ssh: {
        kind: "ssh",
        host: "beta-ssh.freestyle.sh",
        username: "vm-stream+root",
        auth: { type: "token", token: "token" },
        command: "ssh vm-stream+root:token@beta-ssh.freestyle.sh",
      },
      command: "gh auth login --hostname github.com",
      keepOpenAfterCommand: true,
    });

    expect(html).toContain("const canFinishWhileRunning = true;");
  });
});

function providerContext(): ProviderRuntimeContext {
  return {
    workflow: "workflow",
    nodePath: "workflow.step",
    emit: () => {},
    interaction: {
      present: async () => {
        throw new Error("unexpected interaction");
      },
    },
    local: {
      open: async () => {},
    },
    metadata: () => {},
  };
}
