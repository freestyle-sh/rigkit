import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileProviderHostStorage } from "@rigkit/engine";
import { projectIdFor, runtimeFingerprintFor, runtimePaths, SUPPORTED_RUNTIME_API_VERSION } from "@rigkit/runtime-client";
import { RIGKIT_CLI_VERSION } from "./version.ts";

const cliPath = join(import.meta.dir, "cli.ts");

// Derive mismatch fixtures from the real CLI version so release bumps do not
// accidentally turn a "different minor/major" fixture into a matching version.
const [cliMajor, cliMinor] = RIGKIT_CLI_VERSION.split(".").map(Number);
const nextMinorVersion = `${cliMajor}.${cliMinor + 1}.0`;
const nextMajorVersion = `${cliMajor + 1}.0.0`;

function rigkitIndexPath(projectDir: string): string {
  return join(projectDir, "rigkit", "index.ts");
}

function writeRigkitIndex(projectDir: string): string {
  const configPath = rigkitIndexPath(projectDir);
  mkdirSync(join(projectDir, "rigkit"), { recursive: true });
  writeFileSync(configPath, "export const dev = {}\n");
  return configPath;
}

describe("CLI entrypoint", () => {
  test("renders CLI diagnostics as JSON", async () => {
    const result = await runCli(["doctor", "--cli", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      cliVersion: RIGKIT_CLI_VERSION,
    });
  });

  test("exposes static help and version bootstrap commands", async () => {
    const rootHelp = await runCli([]);
    expect(rootHelp.exitCode).toBe(0);
    expect(rootHelp.stderr).toBe("");
    expect(rootHelp.stdout).toContain("rig ");
    expect(rootHelp.stdout).toContain("plan        Plan project workflow changes");
    expect(rootHelp.stdout).toContain("rm          Remove a workspace");
    expect(rootHelp.stdout).toContain("run         Run a workspace operation");
    expect(rootHelp.stdout).toContain("cache       Inspect and clear workflow cache");
    expect(rootHelp.stdout).toContain("providers   Manage provider-owned local state");

    const version = await runCli(["version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stderr).toBe("");
    expect(version.stdout.trim()).toBe(RIGKIT_CLI_VERSION);

    const help = await runCli(["help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("rig ");
    expect(help.stdout).toContain("plan        Plan project workflow changes");
    expect(help.stdout).toContain("rm          Remove a workspace");
    expect(help.stdout).toContain("run         Run a workspace operation");
    expect(help.stdout).toContain("cache       Inspect and clear workflow cache");
    expect(help.stdout).toContain("providers   Manage provider-owned local state");
  });

  test("prints an update notice when latest metadata is newer", async () => {
    const rigkitHome = mkdtempSync(join(tmpdir(), "rigkit-cli-update-"));
    const latestVersion = nextPatchVersion(RIGKIT_CLI_VERSION);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({
          version: latestVersion,
          installerUrl: "https://www.rigkit.dev/install",
        });
      },
    });

    try {
      const result = await runCli(["doctor", "--cli"], {
        env: {
          RIGKIT_HOME: rigkitHome,
          RIGKIT_UPDATE_CHECK: "1",
          RIGKIT_UPDATE_TIMEOUT_MS: "2000",
          RIGKIT_UPDATE_URL: `http://127.0.0.1:${server.port}/latest.json`,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(RIGKIT_CLI_VERSION);
      expect(result.stderr).toContain(`rig ${latestVersion} is available`);
      expect(result.stderr).toContain("update with: curl -fsSL https://www.rigkit.dev/install | sh");
    } finally {
      server.stop(true);
      rmSync(rigkitHome, { recursive: true, force: true });
    }
  });

  test("does not print update notices for JSON output", async () => {
    const rigkitHome = mkdtempSync(join(tmpdir(), "rigkit-cli-update-json-"));
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1;
        return Response.json({
          version: nextPatchVersion(RIGKIT_CLI_VERSION),
          installerUrl: "https://www.rigkit.dev/install",
        });
      },
    });

    try {
      const result = await runCli(["doctor", "--cli", "--json"], {
        env: {
          RIGKIT_HOME: rigkitHome,
          RIGKIT_UPDATE_CHECK: "1",
          RIGKIT_UPDATE_URL: `http://127.0.0.1:${server.port}/latest.json`,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        cliVersion: RIGKIT_CLI_VERSION,
      });
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
      rmSync(rigkitHome, { recursive: true, force: true });
    }
  });

  test("rejects operation shorthand at the root", async () => {
    const result = await runCli(["unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown command 'unknown'");
  });

  test("serves dynamic shell completion endpoint", async () => {
    const result = await runCli(["__complete", "--shell", "zsh", "--index", "1", "--", "rig", "v"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("version\tshow CLI version\t\tCommands");
  });

  test("discovers projects without starting a runtime", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rigkit-cli-projects-"));
    mkdirSync(join(cwd, "api"));
    writeRigkitIndex(join(cwd, "api"));

    try {
      const result = await runCli(["projects", "--json"], { cwd });
      const realCwd = realpathSync(cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        projects: [{
          projectDir: join(realCwd, "api"),
          configPath: join(realCwd, "api", "rigkit", "index.ts"),
        }],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("shows the canonical config path when missing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rigkit-cli-named-configs-"));

    try {
      const result = await runCli(["create", "--json"], { cwd });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("No Rigkit config found from");
      expect(result.stderr).toContain("rig init");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("initializes the current directory without init options", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rigkit-cli-init-"));

    try {
      const result = await runCli(["--json", "init"], { cwd });
      const projectDir = realpathSync(cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        name: projectDir.split("/").at(-1)?.toLowerCase(),
        projectDir,
        configPath: join(projectDir, "rigkit", "index.ts"),
        packageJsonPath: join(projectDir, "package.json"),
        created: {
          config: true,
          packageJson: true,
        },
        updated: {
          packageJson: false,
        },
        install: {
          packageManager: "skip",
          skipped: true,
          reason: "json",
        },
      });
      expect(existsSync(join(projectDir, "rigkit", "index.ts"))).toBe(true);
      expect(existsSync(join(projectDir, "package.json"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("rejects removed init options", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rigkit-cli-init-options-"));

    try {
      const result = await runCli(["init", "website"], { cwd });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("too many arguments");
      expect(existsSync(join(cwd, "rigkit", "index.ts"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("rejects package manager installs in JSON init before writing files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rigkit-cli-init-json-install-"));

    try {
      const result = await runCli(["init", "--json", "--package-manager", "npm"], { cwd });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("rig init --json only supports --package-manager skip");
      expect(existsSync(join(cwd, "rigkit", "index.ts"))).toBe(false);
      expect(existsSync(join(cwd, "package.json"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("accepts conventional double-dash global options", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rigkit-cli-global-options-"));
    mkdirSync(join(cwd, "api"));
    writeRigkitIndex(join(cwd, "api"));

    try {
      const result = await runCli(["--chdir=api", "projects", "--json"], { cwd });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        projects: [{
          projectDir: join(realpathSync(cwd), "api"),
          configPath: join(realpathSync(cwd), "api", "rigkit", "index.ts"),
        }],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("clears workflow cache through the runtime", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-cache-clear-"));

    await withWorkspaceRuntime({ projectDir }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "cache", "smoke", "clear", "--global", "--json"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, deleted: 1 });
    });
  });

  test("clears Freestyle provider host storage without loading a project", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "rigkit-provider-storage-"));
    const storage = createFileProviderHostStorage({ providerId: "freestyle", rootDir: storageRoot });
    storage.set("stack-auth:test", { refreshToken: "refresh-token", updatedAt: 1 });
    storage.set("identity:test", { token: "ssh-token" });

    try {
      const result = await runCli(["providers", "freestyle", "clear", "--json"], {
        env: { RIGKIT_HOST_STORAGE_DIR: storageRoot },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        providerId: "freestyle",
        deleted: 2,
        storageRoot,
      });
      expect(storage.entries()).toEqual([]);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  test("does not render a success marker when cache invalidation is a no-op", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-cache-invalidate-"));

    await withWorkspaceRuntime({ projectDir, cacheInvalidated: 0 }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "cache", "smoke", "invalidate", "missing-task"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("no cache entries invalidated");
      expect(result.stdout).not.toContain("✓");
    });
  });

  test("preserves JSON output for zero cache invalidations", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-cache-invalidate-json-"));

    await withWorkspaceRuntime({ projectDir, cacheInvalidated: 0 }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "cache", "smoke", "invalidate", "missing-task", "--json"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, invalidated: 0 });
    });
  });

  test("passes positional workflow when invalidating cache", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-cache-invalidate-workflow-"));

    await withWorkspaceRuntime({ projectDir, requireCacheInvalidateWorkflow: true }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "cache", "smoke", "invalidate", "ready", "--json"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, invalidated: 1 });
    });
  });

  test("lists cache entries with plan-style task status", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-cache-list-"));

    await withWorkspaceRuntime({ projectDir }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "cache", "smoke", "ls"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("status");
      expect(result.stdout).toContain("cached");
      expect(result.stdout).toContain("ready");
      expect(result.stdout).not.toContain("valid");
    });
  });

  test("explains workflow cache decisions", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-cache-explain-"));

    await withWorkspaceRuntime({ projectDir }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "cache", "smoke", "explain", "--json"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        workflow: "smoke",
        explanations: [{
          path: "ready",
          status: "cached",
          reason: { code: "cached" },
        }],
      });
    });
  });

  test("lists workspaces from the project runtime", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-ls-"));

    await withWorkspaceRuntime({ projectDir }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "ls"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("smoke");
      expect(result.stdout).toContain("cached");
      expect(result.stdout).toContain("workspace");
      expect(result.stdout).toContain("api");
    });
  });

  test("lists workspaces as JSON", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-ls-json-"));

    await withWorkspaceRuntime({ projectDir }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "ls", "--json"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        workflows: [{
          name: "smoke",
          workspaces: [{
          name: "api",
          workflow: "smoke",
          ctx: {},
          }],
        }],
      });
    });
  });

  test("warns for minor CLI/runtime version mismatches", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-version-warning-"));

    await withWorkspaceRuntime({
      projectDir,
      runtimeVersion: nextMinorVersion,
      engineVersion: nextMinorVersion,
    }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "ls"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("api");
      expect(result.stderr).toContain("Rigkit version mismatch");
      expect(result.stderr).toContain("different minor versions");
      expect(result.stderr).toContain("Update the global CLI");
    });
  });

  test("keeps JSON output clean for minor version mismatches", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-version-warning-json-"));

    await withWorkspaceRuntime({
      projectDir,
      runtimeVersion: nextMinorVersion,
      engineVersion: nextMinorVersion,
    }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "ls", "--json"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).workflows[0].workspaces[0].name).toBe("api");
    });
  });

  test("errors for major CLI/runtime version mismatches", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-version-error-"));

    await withWorkspaceRuntime({
      projectDir,
      runtimeVersion: nextMajorVersion,
      engineVersion: nextMajorVersion,
    }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "ls"], { env });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Rigkit version mismatch");
      expect(result.stderr).toContain("different major versions");
    });
  });

  test("rejects workspace create names that are not shell-safe", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-create-name-"));

    await withWorkspaceRuntime({ projectDir }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "create", "--workflow", "smoke", "--name", "some workspace", "--json"], { env });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('Invalid workspace name "some workspace"');
    });
  });

  test("accepts create name as a positional argument", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-create-positional-"));

    await withWorkspaceRuntime({ projectDir }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "create", "--workflow", "smoke", "new-workspace", "--json"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        name: "new-workspace",
      });
    });
  });

  test("removes a workspace with the built-in rm command", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-rm-"));

    await withWorkspaceRuntime({ projectDir }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "rm", "api", "-y", "--json"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        name: "api",
      });
    });
  });

  test("requires --workflow for duplicate workspace names in JSON run", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-run-conflict-"));

    await withWorkspaceRuntime({ projectDir, duplicateWorkspaceName: true }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "run", "api", "remove", "--json"], { env });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('Workspace "api" exists in multiple workflows: smoke, api. Pass --workflow.');
    });
  });

  test("uses --workflow to disambiguate duplicate workspace names in run", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "rigkit-cli-run-workflow-"));

    await withWorkspaceRuntime({ projectDir, duplicateWorkspaceName: true }, async ({ env }) => {
      const result = await runCli([`--chdir=${projectDir}`, "run", "api", "remove", "--workflow", "smoke", "--yes", "--json"], { env });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        name: "api",
        workflow: "smoke",
      });
    });
  });

  test("requires discovered projects for operation --all", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rigkit-cli-run-all-"));

    try {
      const result = await runCli(["plan", "--all", "--json"], { cwd });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("No Rigkit projects found.");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("requires selection for operation --discover with multiple projects", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rigkit-cli-run-discover-"));
    mkdirSync(join(cwd, "api"));
    mkdirSync(join(cwd, "web"));
    writeRigkitIndex(join(cwd, "api"));
    writeRigkitIndex(join(cwd, "web"));

    try {
      const result = await runCli(["plan", "--discover", "--json"], { cwd });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Multiple Rigkit projects found.");
      expect(result.stderr).toContain("pass --all");
      expect(result.stderr).toContain(join(realpathSync(cwd), "api", "rigkit", "index.ts"));
      expect(result.stderr).toContain(join(realpathSync(cwd), "web", "rigkit", "index.ts"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

async function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      RIGKIT_UPDATE_CHECK: "0",
      ...options.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function nextPatchVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return "999.0.0";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

async function withWorkspaceRuntime(
  input: {
    projectDir: string;
    cacheInvalidated?: number;
    requireCacheInvalidateWorkflow?: boolean;
    duplicateWorkspaceName?: boolean;
    engineVersion?: string;
    runtimeVersion?: string;
  },
  run: (context: { env: Record<string, string> }) => Promise<void>,
): Promise<void> {
  const rigkitHome = mkdtempSync(join(tmpdir(), "rigkit-home-"));
  const token = "test-token";
  mkdirSync(input.projectDir, { recursive: true });
  const configPath = writeRigkitIndex(input.projectDir);
  const projectId = projectIdFor({ projectDir: input.projectDir, configPath });
  const runtimeFingerprint = runtimeFingerprintFor({ projectDir: input.projectDir, configPath });
  const paths = runtimePaths(projectId, rigkitHome);
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.tokenPath, `${token}\n`);
  const engineVersion = input.engineVersion ?? "engine-test";
  const runtimeVersion = input.runtimeVersion ?? "runtime-test";

  const now = new Date(0).toISOString();
  let runResult: unknown = undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return runtimeJson({ error: { message: "Unauthorized" } }, { status: 401 });
      }

      const { pathname } = new URL(request.url);
      if (pathname === "/health") {
        return runtimeJson({
          ok: true,
          projectId,
          runtimeFingerprint,
          projectDir: input.projectDir,
          configPath,
          statePath: join(input.projectDir, ".rigkit", "state.sqlite"),
          engineVersion,
          runtimeVersion,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (pathname === "/runtime") {
        return runtimeJson({
          apiVersion: SUPPORTED_RUNTIME_API_VERSION,
          engineVersion,
          runtimeVersion,
          protocolHash: "test-protocol",
        });
      }
      if (pathname === "/workspaces") {
        return runtimeJson({
          workspaces: [
            {
              id: "workspace-api",
              name: "api",
              workflow: "smoke",
              ctx: {},
              createdAt: now,
              updatedAt: now,
            },
            ...(input.duplicateWorkspaceName ? [{
              id: "workspace-api-api",
              name: "api",
              workflow: "api",
              ctx: {},
              createdAt: now,
              updatedAt: now,
            }] : []),
          ],
        });
      }
      if (pathname === "/workflows") {
        return runtimeJson({
          workflows: [
            {
              name: "smoke",
              providers: [],
              nodes: ["ready"],
              operations: [],
              createsWorkspace: true,
              lastAppliedAt: now,
            },
            ...(input.duplicateWorkspaceName ? [{
              name: "api",
              providers: [],
              nodes: ["ready"],
              operations: [],
              createsWorkspace: true,
              lastAppliedAt: now,
            }] : []),
          ],
        });
      }
      if (pathname === "/cache/invalidate") {
        const body = await request.json() as { workflow?: string };
        if (input.requireCacheInvalidateWorkflow && body.workflow !== "smoke") {
          return runtimeJson({ error: { message: "Pass --workflow to choose a workflow" } }, { status: 400 });
        }
        return runtimeJson({ ok: true, invalidated: input.cacheInvalidated ?? 1 });
      }
      if (pathname === "/cache/clear") {
        const body = await request.json() as { workflow?: string };
        if (body.workflow !== "smoke") {
          return runtimeJson({ error: { message: "Unknown workflow" } }, { status: 400 });
        }
        return runtimeJson({ ok: true, deleted: 1 });
      }
      if (pathname === "/cache/explain") {
        const body = await request.json() as { workflow?: string; task?: string };
        if (body.workflow !== "smoke") {
          return runtimeJson({ error: { message: "Unknown workflow" } }, { status: 400 });
        }
        return runtimeJson({
          workflow: "smoke",
          explanations: [{
            workflow: "smoke",
            path: "ready",
            name: "ready",
            status: "cached",
            reason: { code: "cached", message: "cached" },
            runId: "run-ready",
            scope: "local",
            cacheWorkflow: "smoke",
            cacheNodePath: "ready",
            upstreamRunIds: [],
            candidates: [{
              runId: "run-ready",
              scope: "local",
              nodePath: "ready",
              displayPath: "ready",
              nodeName: "ready",
              nodeKind: "task",
              createdAt: now,
              invalidated: false,
              reasons: [{ code: "cached", message: "cached" }],
            }],
          }],
        });
      }
      if (pathname === "/cache" || pathname === "/cache/list") {
        return runtimeJson({
          entries: [{
            scope: "local",
            workflow: "smoke",
            nodePath: "ready",
            displayPath: "ready",
            planIndex: 0,
            nodeName: "ready",
            nodeKind: "task",
            runId: "run-ready",
            invalidated: false,
            createdAt: now,
          }],
        });
      }
      if (pathname === "/operations") {
        return runtimeJson({
          operations: [{
            workflow: "",
            id: "create",
            kind: "command",
            source: "core",
            title: "Create",
            description: "Create a workspace",
            createsWorkspace: true,
            cli: {
              positionals: [{ name: "name", index: 0 }],
              options: [
                { name: "workflow", flag: "--workflow" },
                { name: "name", flag: "--name", required: true, type: "string" },
              ],
            },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                workflow: { type: "string", enum: ["smoke"] },
                name: { type: "string", minLength: 1 },
              },
              required: ["name"],
            },
          }],
          workspaceOperations: [
            {
              workflow: "smoke",
              id: "remove",
              kind: "workspace-action",
              source: "core",
              title: "Remove",
              description: "remove workspace",
              cli: {
                options: [{ name: "yes", flag: "--yes", aliases: ["-y"], type: "boolean", runtime: false }],
              },
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {},
              },
            },
            ...(input.duplicateWorkspaceName ? [{
              workflow: "api",
              id: "remove",
              kind: "workspace-action",
              source: "core",
              title: "Remove",
              description: "remove api workspace",
              cli: {
                options: [{ name: "yes", flag: "--yes", aliases: ["-y"], type: "boolean", runtime: false }],
              },
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {},
              },
            }] : []),
          ],
        });
      }
      if (pathname === "/runs") {
        const body = await request.json() as { operation?: string; input?: { name?: string } };
        runResult = body.operation === "plan"
          ? {
            workflow: "smoke",
            providerFingerprint: "test",
            cachedNodeCount: 1,
            nodeCount: 1,
            nodes: [{ index: 0, path: "ready", name: "ready", status: "cached", upstreamRunIds: [] }],
          }
          : body.operation === "api/remove"
          ? {
            id: "workspace-api",
            name: "api",
            workflow: "smoke",
            ctx: {},
            createdAt: now,
            updatedAt: now,
          }
          : {
            id: "workspace-new",
            name: body.input?.name ?? "new-workspace",
            workflow: "smoke",
            ctx: {},
            createdAt: now,
            updatedAt: now,
          };
        return runtimeJson({
          runId: "run-test",
          operation: body.operation ?? "test",
          status: "running",
          eventsUrl: "/runs/run-test/events",
          sessionUrl: "",
        }, { status: 202 });
      }
      if (pathname === "/runs/run-test/events") {
        return new Response(
          `data: ${JSON.stringify({
            type: "run.completed",
            result: runResult,
          })}\n\n`,
          {
            headers: {
              "content-type": "text/event-stream",
              "x-rigkit-api-version": String(SUPPORTED_RUNTIME_API_VERSION),
            },
          },
        );
      }
      return runtimeJson({ error: { message: "Not found" } }, { status: 404 });
    },
  });

  writeFileSync(
    paths.handlePath,
    `${JSON.stringify({
      projectId,
      runtimeFingerprint,
      projectDir: input.projectDir,
      configPath,
      pid: process.pid,
      url: `http://127.0.0.1:${server.port}`,
      tokenPath: paths.tokenPath,
    }, null, 2)}\n`,
  );

  try {
    await run({ env: { RIGKIT_HOME: rigkitHome } });
  } finally {
    server.stop(true);
    rmSync(rigkitHome, { recursive: true, force: true });
    rmSync(input.projectDir, { recursive: true, force: true });
  }
}

function runtimeJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("x-rigkit-api-version", String(SUPPORTED_RUNTIME_API_VERSION));
  return Response.json(body, { ...init, headers });
}
