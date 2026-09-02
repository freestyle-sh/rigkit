import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ProviderStorage, ProviderStorageRecord } from "@rigkit/engine";
import type { JsonValue } from "@rigkit/sdk";
import {
  CmuxCommandError,
  cmux,
  cmuxProviderPlugin,
  createCmuxClient,
  formatShellCommand,
  isInsideCmuxTerminal,
  parseCmuxHandle,
  parseOptionalCmuxHandle,
  type CmuxRpcParams,
  type CmuxRpcResult,
  type CmuxRuntime,
} from "./index.ts";
import { callCmux, type CmuxCallClient } from "./host.ts";

describe("cmux sdk", () => {
  test("parses workspace refs from cmux text output", () => {
    expect(parseCmuxHandle("OK workspace:3\n", "workspace")).toBe("workspace:3");
  });

  test("parses optional typed refs without stealing unrelated UUIDs", () => {
    const output = "OK workspace=workspace:2 pane=pane:4 surface=surface:5";
    expect(parseOptionalCmuxHandle(output, "workspace")).toBe("workspace:2");
    expect(parseOptionalCmuxHandle(output, "pane")).toBe("pane:4");
    expect(parseOptionalCmuxHandle(output, "surface")).toBe("surface:5");
    expect(parseOptionalCmuxHandle("OK workspace=00000000-0000-0000-0000-000000000001", "pane")).toBeUndefined();
  });

  test("creates a workspace with command text", async () => {
    const calls: Array<{ method: string; params: CmuxRpcParams }> = [];
    const rpcRunner = (method: string, params: CmuxRpcParams): CmuxRpcResult => {
      calls.push({ method, params });
      if (method === "workspace.create") {
        return {
          workspace_id: "00000000-0000-0000-0000-000000000007",
          workspace_ref: "workspace:7",
        };
      }
      return {};
    };

    const cmux = createCmuxClient({ printCommands: false, rpcRunner });
    const workspace = await cmux.newWorkspace({
      name: "cmux-playground",
      command: "echo hello world",
      focus: true,
    });

    expect(workspace.handle).toBe("00000000-0000-0000-0000-000000000007");
    expect(workspace.ref).toBe("workspace:7");
    expect(calls).toEqual([
      {
        method: "workspace.create",
        params: { title: "cmux-playground", focus: true },
      },
      {
        method: "surface.send_text",
        params: {
          workspace_id: "00000000-0000-0000-0000-000000000007",
          text: "echo hello world\n",
        },
      },
    ]);
  });

  test("opens an ssh workspace through direct socket RPC", async () => {
    const calls: Array<{ method: string; params: CmuxRpcParams }> = [];
    const cmux = createCmuxClient({
      printCommands: false,
      rpcRunner: (method, params) => {
        calls.push({ method, params });
        if (method === "workspace.create") {
          return {
            workspace_id: "00000000-0000-0000-0000-000000000012",
            workspace_ref: "workspace:12",
          };
        }
        return {
          workspace_id: "00000000-0000-0000-0000-000000000012",
          workspace_ref: "workspace:12",
        };
      },
    });

    const workspace = await cmux.ssh({
      destination: "vm:token@example.com",
      name: "website",
      port: 2222,
      identity: "/tmp/key",
      sshOptions: ["StrictHostKeyChecking=no"],
      skipDaemonBootstrap: true,
    });

    expect(workspace.handle).toBe("00000000-0000-0000-0000-000000000012");
    expect(calls).toEqual([
      {
        method: "workspace.create",
        params: {
          initial_command: "ssh -p 2222 -i /tmp/key -o StrictHostKeyChecking=no vm:token@example.com",
        },
      },
      {
        method: "workspace.rename",
        params: {
          workspace_id: "00000000-0000-0000-0000-000000000012",
          title: "website",
        },
      },
      {
        method: "workspace.remote.configure",
        params: {
          workspace_id: "00000000-0000-0000-0000-000000000012",
          destination: "vm:token@example.com",
          auto_connect: true,
          terminal_startup_command: "ssh -p 2222 -i /tmp/key -o StrictHostKeyChecking=no vm:token@example.com",
          port: 2222,
          identity_file: "/tmp/key",
          ssh_options: ["StrictHostKeyChecking=no"],
          skip_daemon_bootstrap: true,
        },
      },
      {
        method: "workspace.select",
        params: {
          workspace_id: "00000000-0000-0000-0000-000000000012",
        },
      },
    ]);
  });

  test("creates panes, surfaces, opens browsers, and sends terminal text", async () => {
    const calls: Array<{ method: string; params: CmuxRpcParams }> = [];
    const cmux = createCmuxClient({
      printCommands: false,
      rpcRunner: (method, params) => {
        calls.push({ method, params });
        if (method === "pane.create") {
          return {
            workspace_id: "00000000-0000-0000-0000-000000000009",
            workspace_ref: "workspace:9",
            surface_id: "00000000-0000-0000-0000-000000000007",
            surface_ref: "surface:7",
            pane_id: "00000000-0000-0000-0000-000000000008",
            pane_ref: "pane:8",
          };
        }
        if (method === "browser.open_split") {
          return {
            workspace_id: "00000000-0000-0000-0000-000000000009",
            workspace_ref: "workspace:9",
            surface_id: "00000000-0000-0000-0000-000000000010",
            surface_ref: "surface:10",
            pane_id: "00000000-0000-0000-0000-000000000011",
            pane_ref: "pane:11",
          };
        }
        if (method === "surface.create") {
          return {
            workspace_id: "00000000-0000-0000-0000-000000000009",
            workspace_ref: "workspace:9",
            surface_id: "00000000-0000-0000-0000-000000000012",
            surface_ref: "surface:12",
            pane_id: "00000000-0000-0000-0000-000000000008",
            pane_ref: "pane:8",
          };
        }
        return {};
      },
    });

    const pane = await cmux.newPane({
      workspace: "00000000-0000-0000-0000-000000000009",
      type: "terminal",
      direction: "down",
      focus: false,
    });
    await cmux.send({
      workspace: "00000000-0000-0000-0000-000000000009",
      surface: pane.surface,
      text: "pnpm dev\\n",
    });
    await cmux.portsKick({
      workspace: "00000000-0000-0000-0000-000000000009",
      surface: pane.surface,
      reason: "refresh",
    });
    const surface = await cmux.newSurface({
      workspace: "00000000-0000-0000-0000-000000000009",
      pane: pane.pane,
      type: "terminal",
      focus: false,
    });
    await cmux.send({
      workspace: "00000000-0000-0000-0000-000000000009",
      surface: surface.surface,
      text: "codex\\n",
    });
    await cmux.browserOpen({
      workspace: "00000000-0000-0000-0000-000000000009",
      url: "http://localhost:3000",
      focus: true,
    });

    expect(pane.surface).toBe("00000000-0000-0000-0000-000000000007");
    expect(surface.surface).toBe("00000000-0000-0000-0000-000000000012");
    expect(calls).toEqual([
      {
        method: "pane.create",
        params: {
          workspace_id: "00000000-0000-0000-0000-000000000009",
          type: "terminal",
          direction: "down",
          focus: false,
        },
      },
      {
        method: "surface.send_text",
        params: {
          workspace_id: "00000000-0000-0000-0000-000000000009",
          surface_id: "00000000-0000-0000-0000-000000000007",
          text: "pnpm dev\\n",
        },
      },
      {
        method: "surface.ports_kick",
        params: {
          workspace_id: "00000000-0000-0000-0000-000000000009",
          surface_id: "00000000-0000-0000-0000-000000000007",
          reason: "refresh",
        },
      },
      {
        method: "surface.create",
        params: {
          type: "terminal",
          pane_id: "00000000-0000-0000-0000-000000000008",
          workspace_id: "00000000-0000-0000-0000-000000000009",
          focus: false,
        },
      },
      {
        method: "surface.send_text",
        params: {
          workspace_id: "00000000-0000-0000-0000-000000000009",
          surface_id: "00000000-0000-0000-0000-000000000012",
          text: "codex\\n",
        },
      },
      {
        method: "browser.open_split",
        params: {
          url: "http://localhost:3000",
          workspace_id: "00000000-0000-0000-0000-000000000009",
          focus: true,
        },
      },
    ]);
  });

  test("waits for remote workspace proxy readiness", async () => {
    let listCalls = 0;
    const calls: Array<{ method: string; params: CmuxRpcParams }> = [];
    const cmux = createCmuxClient({
      printCommands: false,
      sleep: async () => {},
      rpcRunner: (method, params) => {
        calls.push({ method, params });
        if (method !== "workspace.list") return {};

        listCalls += 1;
        return {
          workspaces: [
            {
              id: "00000000-0000-0000-0000-000000000012",
              ref: "workspace:12",
              remote: listCalls === 1
                ? {
                  connected: false,
                  state: "connecting",
                  proxy: { state: "connecting" },
                  detail: "Connecting",
                }
                : {
                  connected: true,
                  state: "connected",
                  proxy: {
                    state: "ready",
                    host: "127.0.0.1",
                    port: 49152,
                  },
                  detail: "Connected",
                },
            },
          ],
        };
      },
    });

    const status = await cmux.waitForRemoteReady(
      "00000000-0000-0000-0000-000000000012",
      { timeoutMs: 1000, intervalMs: 1 },
    );

    expect(status.remote?.connected).toBe(true);
    expect(calls).toEqual([
      { method: "workspace.list", params: {} },
      { method: "workspace.list", params: {} },
    ]);
  });

  test("prints shell-formatted commands when enabled", async () => {
    const logs: string[] = [];
    const cmux = createCmuxClient({
      logger: (message) => logs.push(message),
      rpcRunner: (method) => {
        if (method === "workspace.create") {
          return {
            workspace_id: "00000000-0000-0000-0000-000000000009",
          };
        }
        return {};
      },
    });

    await cmux.newWorkspace({ name: "hello world" });

    expect(logs).toEqual([
      "$ cmux rpc workspace.create '{\"title\":\"hello world\"}'",
    ]);
  });

  test("sends direct v2 rpc over the cmux socket from a cmux terminal env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-cmux-"));
    const socketPath = join(dir, "cmux.sock");
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex < 0) return;
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          const request = JSON.parse(line) as {
            id: string;
            method: string;
            params: CmuxRpcParams;
          };
          socket.write(JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              workspace_id: "00000000-0000-0000-0000-000000000021",
              workspace_ref: "workspace:21",
              echo_method: request.method,
              echo_params: request.params,
            },
          }) + "\n");
        }
      });
    });
    const originalSocketPath = process.env.CMUX_SOCKET_PATH;
    const originalWorkspaceId = process.env.CMUX_WORKSPACE_ID;

    try {
      await listen(server, socketPath);
      process.env.CMUX_SOCKET_PATH = socketPath;
      process.env.CMUX_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

      const cmux = createCmuxClient({ printCommands: false });
      const workspace = await cmux.newWorkspace({ name: "direct" });

      expect(workspace.handle).toBe("00000000-0000-0000-0000-000000000021");
      expect(workspace.result).toMatchObject({
        echo_method: "workspace.create",
        echo_params: { title: "direct" },
      });
    } finally {
      restoreEnv("CMUX_SOCKET_PATH", originalSocketPath);
      restoreEnv("CMUX_WORKSPACE_ID", originalWorkspaceId);
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails fast outside cmux before opening the socket", async () => {
    const originalSocketPath = process.env.CMUX_SOCKET_PATH;
    const originalWorkspaceId = process.env.CMUX_WORKSPACE_ID;
    const originalSurfaceId = process.env.CMUX_SURFACE_ID;

    delete process.env.CMUX_SOCKET_PATH;
    delete process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_SURFACE_ID;

    try {
      const cmux = createCmuxClient({
        printCommands: false,
      });

      await expect(cmux.newWorkspace({ name: "outside" })).rejects.toThrow(
        "cmux socket commands need a cmux-controlled terminal",
      );
    } finally {
      restoreEnv("CMUX_SOCKET_PATH", originalSocketPath);
      restoreEnv("CMUX_WORKSPACE_ID", originalWorkspaceId);
      restoreEnv("CMUX_SURFACE_ID", originalSurfaceId);
    }
  });

  test("detects cmux terminal environment", () => {
    expect(isInsideCmuxTerminal({})).toBe(false);
    expect(isInsideCmuxTerminal({ CMUX_SOCKET_PATH: "/tmp/cmux.sock" })).toBe(true);
    expect(isInsideCmuxTerminal({ CMUX_WORKSPACE_ID: "workspace-id" })).toBe(true);
    expect(isInsideCmuxTerminal({ CMUX_SURFACE_ID: "surface-id" })).toBe(true);
  });

  test("formats shell commands", () => {
    expect(formatShellCommand(["cmux", "new-workspace", "--name", "hello world"])).toBe(
      "cmux new-workspace --name 'hello world'",
    );
  });

  test("throws a structured error on raw cmux command failure", () => {
    const cmux = createCmuxClient({
      autoLaunch: false,
      printCommands: false,
      runner: (args) => {
        return { exitCode: 2, stdout: "", stderr: "bad command\n" };
      },
    });

    expect(() => cmux.run(["bad"])).toThrow(CmuxCommandError);
  });

  test("handles raw cmux.call host capability requests", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const logs: string[] = [];
    const client = fakeOpenClient(calls);

    const workspace = await callCmux({
      method: "ssh",
      params: {
        kind: "ssh",
        destination: "vm_123,token_123@beta-ssh.freestyle.sh",
        name: "website",
        sshOptions: ["ServerAliveInterval=15"],
      },
    }, { client, logger: (message: string) => logs.push(message) });
    const browser = await callCmux({
      method: "newSurface",
      params: {
        workspace: "workspace-1",
        type: "browser",
        url: "http://localhost:4321",
        focus: true,
      },
    }, { client, logger: (message: string) => logs.push(message) });
    const terminal = await callCmux({
      method: "newSurface",
      params: {
        workspace: "workspace-1",
        type: "terminal",
        focus: false,
      },
    }, { client, logger: (message: string) => logs.push(message) });
    await callCmux({
      method: "send",
      params: {
        workspace: "workspace-1",
        surface: "surface-2",
        text: "pnpm dev\n",
      },
    }, { client, logger: (message: string) => logs.push(message) });
    await callCmux({
      method: "selectWorkspace",
      params: { workspace: "workspace-1" },
    }, { client, logger: (message: string) => logs.push(message) });

    expect(workspace).toEqual({ handle: "workspace-1", id: "workspace-1", ref: "workspace:1" });
    expect(browser).toMatchObject({ surface: "surface-1" });
    expect(terminal).toMatchObject({ surface: "surface-2" });
    expect(calls).toEqual([
      {
        method: "ssh",
        params: expect.objectContaining({
          destination: "vm_123,token_123@beta-ssh.freestyle.sh",
          name: "website",
          sshOptions: ["ServerAliveInterval=15"],
        }),
      },
      {
        method: "newSurface",
        params: {
          workspace: "workspace-1",
          type: "browser",
          url: "http://localhost:4321",
          focus: true,
        },
      },
      {
        method: "newSurface",
        params: {
          workspace: "workspace-1",
          type: "terminal",
          focus: false,
        },
      },
      {
        method: "send",
        params: {
          workspace: "workspace-1",
          surface: "surface-2",
          text: "pnpm dev\n",
        },
      },
      {
        method: "selectWorkspace",
        params: "workspace-1",
      },
    ]);
    expect(logs).toEqual([
      "cmux: ssh",
      "cmux: newSurface",
      "cmux: newSurface",
      "cmux: send",
      "cmux: selectWorkspace",
    ]);
  });

  test("forwards an explicit cmux ssh terminal startup command", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = fakeOpenClient(calls);

    await callCmux({
      method: "ssh",
      params: {
        kind: "ssh",
        destination: "vm_123,token_123@beta-ssh.freestyle.sh",
        name: "website",
        terminalStartupCommand: "ssh -tt vm_123:token_123@beta-ssh.freestyle.sh",
      },
    }, { client });

    expect(calls[0]).toEqual({
      method: "ssh",
      params: expect.objectContaining({
        destination: "vm_123,token_123@beta-ssh.freestyle.sh",
        name: "website",
        terminalStartupCommand: "ssh -tt vm_123:token_123@beta-ssh.freestyle.sh",
      }),
    });
  });

  test("exposes a provider facade that requests raw cmux calls from the local host", async () => {
    const definition = cmux.provider();
    expect(definition.providerId).toBe("cmux");
    expect(definition.plugin).toBe(cmuxProviderPlugin);

    const controller = await cmuxProviderPlugin.createProvider({
      provider: { providerId: "cmux", config: {} },
      storage: memoryProviderStorage("cmux"),
      hostStorage: memoryProviderStorage("cmux"),
      local: { open: async () => {} },
    });
    const requests: Array<{ capability: string; params: unknown; options: unknown }> = [];
    const runtime = await controller.runtime({
      workflow: "test",
      nodePath: "operation.open",
      emit: () => {},
      interaction: {
        present: async <Result,>() => undefined as Result,
      },
      metadata: () => {},
      local: {
        open: async () => {},
        requestCapability: async <Result,>(capability: string, params: unknown, options: unknown) => {
          requests.push({ capability, params, options });
          const method = (params as { method?: string }).method;
          if (method === "newSurface") {
            return { surface: "surface-1", pane: "pane-1" } as Result;
          }
          if (method === "send") return "OK" as Result;
          return { sessionId: "workspace-1", workspaceId: "workspace-1" } as Result;
        },
      },
    }) as CmuxRuntime;

    const workspace = await runtime.ssh({
      destination: "vm_123,token_123@beta-ssh.freestyle.sh",
      name: "workspace",
    });
    const terminal = await runtime.newSurface({
      workspace: workspace.workspaceId,
      type: "terminal",
      focus: true,
    });
    await runtime.send({
      workspace: workspace.workspaceId,
      surface: terminal.surfaceId,
      text: "git status\n",
    });

    expect(requests).toEqual([
      {
        capability: "cmux.call",
        params: {
          method: "ssh",
          params: {
            destination: "vm_123,token_123@beta-ssh.freestyle.sh",
            name: "workspace",
          },
        },
        options: { nodePath: "operation.open" },
      },
      {
        capability: "cmux.call",
        params: {
          method: "newSurface",
          params: {
            workspace: "workspace-1",
            type: "terminal",
            focus: true,
          },
        },
        options: { nodePath: "operation.open" },
      },
      {
        capability: "cmux.call",
        params: {
          method: "send",
          params: {
            workspace: "workspace-1",
            surface: "surface-1",
            text: "git status\n",
          },
        },
        options: { nodePath: "operation.open" },
      },
    ]);
  });
});

function fakeOpenClient(calls: Array<{ method: string; params: unknown }>): CmuxCallClient {
  let terminalPaneIndex = 0;
  return {
    async newWorkspace(params) {
      calls.push({ method: "newWorkspace", params });
      return { handle: "workspace-1", id: "workspace-1", ref: "workspace:1" };
    },
    async ssh(params) {
      calls.push({ method: "ssh", params });
      return { handle: "workspace-1", id: "workspace-1", ref: "workspace:1" };
    },
    async newPane(params) {
      calls.push({ method: "newPane", params });
      terminalPaneIndex += 1;
      return {
        workspace: "workspace-1",
        workspaceRef: "workspace:1",
        pane: `pane-${terminalPaneIndex}`,
        paneRef: `pane:${terminalPaneIndex}`,
        surface: `surface-${terminalPaneIndex}`,
        surfaceRef: `surface:${terminalPaneIndex}`,
      };
    },
    async newSurface(params) {
      calls.push({ method: "newSurface", params });
      terminalPaneIndex += 1;
      return {
        workspace: "workspace-1",
        workspaceRef: "workspace:1",
        pane: `pane-${terminalPaneIndex}`,
        paneRef: `pane:${terminalPaneIndex}`,
        surface: `surface-${terminalPaneIndex}`,
        surfaceRef: `surface:${terminalPaneIndex}`,
      };
    },
    async send(params) {
      calls.push({ method: "send", params });
      return "OK";
    },
    async portsKick(params) {
      calls.push({ method: "portsKick", params });
      return "OK";
    },
    async browserOpen(params) {
      calls.push({ method: "browserOpen", params });
      return {
        workspace: "workspace-1",
        workspaceRef: "workspace:1",
        pane: "browser-pane-1",
        paneRef: "pane:browser-1",
        surface: "browser-surface-1",
        surfaceRef: "surface:browser-1",
      };
    },
    async selectWorkspace(workspace) {
      calls.push({ method: "selectWorkspace", params: workspace });
      return "OK";
    },
    async waitForRemoteReady(workspace, options) {
      calls.push({ method: "waitForRemoteReady", params: { workspace, options } });
      return { handle: workspace, id: workspace, ref: "workspace:1", result: {} };
    },
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function memoryProviderStorage(providerId: string): ProviderStorage {
  const records = new Map<string, ProviderStorageRecord>();
  return {
    get<Value extends JsonValue = JsonValue>(key: string) {
      return records.get(key) as ProviderStorageRecord<Value> | undefined;
    },
    set<Value extends JsonValue = JsonValue>(key: string, value: Value) {
      const now = new Date().toISOString();
      const existing = records.get(key);
      const record: ProviderStorageRecord<Value> = {
        providerId,
        key,
        value,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      records.set(key, record as ProviderStorageRecord);
      return record;
    },
    delete(key) {
      records.delete(key);
    },
    entries(prefix = "") {
      return [...records.values()].filter((record) => record.key.startsWith(prefix));
    },
  };
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
