import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEFAULT_CONFIG_PATH } from "./project.ts";
import { RIGKIT_CLI_VERSION } from "./version.ts";

export type InitProjectInput = {
  projectDir: string;
};

export type InitProjectResult = {
  name: string;
  projectDir: string;
  configPath: string;
  packageJsonPath: string;
  created: {
    config: boolean;
    packageJson: boolean;
  };
  updated: {
    packageJson: boolean;
  };
};

export function initProject(input: InitProjectInput): InitProjectResult {
  const configPath = join(input.projectDir, DEFAULT_CONFIG_PATH);
  mkdirSync(input.projectDir, { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });

  if (existsSync(configPath)) {
    throw new Error(`${configPath} already exists.`);
  }

  writeFileSync(configPath, starterConfig());
  const packageJson = ensureProjectPackageJson(input.projectDir);

  return {
    name: packageJson.name,
    projectDir: input.projectDir,
    configPath,
    packageJsonPath: packageJson.path,
    created: {
      config: true,
      packageJson: packageJson.created,
    },
    updated: {
      packageJson: packageJson.updated,
    },
  };
}

function ensureProjectPackageJson(projectDir: string): {
  name: string;
  path: string;
  created: boolean;
  updated: boolean;
} {
  const path = join(projectDir, "package.json");
  const created = !existsSync(path);
  const pkg = created
    ? {
        name: defaultPackageName(projectDir),
        private: true,
        type: "module",
      }
    : JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const name = typeof pkg.name === "string" && pkg.name.trim()
    ? pkg.name.trim()
    : defaultPackageName(projectDir);

  let changed = false;
  if (pkg.name !== name) {
    pkg.name = name;
    changed = true;
  }
  if (pkg.private !== true) {
    pkg.private = true;
    changed = true;
  }
  if (pkg.type !== "module") {
    pkg.type = "module";
    changed = true;
  }

  const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
  for (const [key, value] of Object.entries({
    apply: "rig apply",
    plan: "rig plan",
  })) {
    if (scripts[key] !== value) {
      scripts[key] = value;
      changed = true;
    }
  }
  pkg.scripts = sortObject(scripts);

  for (const [name, version] of Object.entries(rigkitDevDependencies())) {
    changed = upsertProjectDependency(pkg, name, version) || changed;
  }

  if (created || changed) {
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  return {
    name,
    path,
    created,
    updated: !created && changed,
  };
}

function upsertProjectDependency(pkg: Record<string, unknown>, name: string, version: string): boolean {
  const dependencies = isRecord(pkg.dependencies) ? pkg.dependencies : undefined;
  if (dependencies && Object.prototype.hasOwnProperty.call(dependencies, name)) {
    if (dependencies[name] === version) return false;
    dependencies[name] = version;
    pkg.dependencies = sortObject(dependencies);
    return true;
  }

  const devDependencies = isRecord(pkg.devDependencies) ? pkg.devDependencies : {};
  if (devDependencies[name] === version) return false;
  devDependencies[name] = version;
  pkg.devDependencies = sortObject(devDependencies);
  return true;
}

function rigkitDevDependencies(): Record<string, string> {
  return {
    "@rigkit/provider-cmux": RIGKIT_CLI_VERSION,
    "@rigkit/provider-freestyle": RIGKIT_CLI_VERSION,
    "@rigkit/sdk": RIGKIT_CLI_VERSION,
  };
}

function defaultPackageName(projectDir: string): string {
  const name = basename(projectDir) || "rigkit-project";
  return normalizePackageName(name);
}

function normalizePackageName(value: string): string {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return name || "rigkit-project";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sortObject<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export function starterConfig(): string {
  const workflowName = JSON.stringify("dev");

  return `import { workflow } from "@rigkit/sdk";
import { cmux } from "@rigkit/provider-cmux";
import { execLongCommand, freestyle, type FirewallSpec } from "@rigkit/provider-freestyle";

const repo = "octocat/Hello-World";
const repoPath = "/workspace/Hello-World";
const vmHome = "/root";
const vmIdleTimeoutSeconds = 3600;
// A Freestyle VM reaches nothing it has not been allowed to; these steps need
// the public internet for apt, GitHub, and browser logins.
const vmFirewall: FirewallSpec = {
  rules: [{ action: "allow", source: {}, destination: { public: true } }],
};

const freestyleProvider = freestyle.provider();
const terminalProvider = freestyle.terminal();

export const dev = workflow(${workflowName})
  .sequence("dev")
  .addProvider("freestyle", freestyleProvider)
  .addProvider("terminal", terminalProvider)
  .step("install-dependencies", async ({ providers }) => {
    console.log("installing base dependencies");
    const { vm, vmId } = await providers.freestyle.client.vms.create({
      firewall: vmFirewall,
      idleTimeoutSeconds: vmIdleTimeoutSeconds,
    });
    try {
      // Freestyle caps one exec at five minutes; execLongCommand runs longer
      // jobs detached in the guest and polls until they finish.
      const dependencies = await execLongCommand(vm, {
        command: installDependenciesCommand(),
        timeoutMs: 10 * 60 * 1000,
        onOutput: (chunk) => console.log(chunk.trimEnd()),
      });
      if (dependencies.timedOut || (dependencies.statusCode ?? 0) !== 0) {
        throw new Error(\`Base dependency install \${dependencies.timedOut ? "timed out" : "failed"}:\\n\${dependencies.stdout}\`.trim());
      }

      const result = await vm.exec("node --version");
      if ((result.statusCode ?? 0) !== 0 || !(result.stdout ?? "").trim().startsWith("v22.")) {
        throw new Error(\`Expected Node.js v22, got: \${result.stdout}\${result.stderr}\`);
      }
      const snapshot = await vm.snapshot();
      return { ctx: { snapshotId: snapshot.snapshotId } };
    } finally {
      await providers.freestyle.client.vms.delete(vmId);
    }
  })
  .step("github-auth", async ({ providers, step }) => {
    const { vm, vmId } = await providers.freestyle.client.vms.create({
      snapshotId: step.ctx.snapshotId,
      firewall: vmFirewall,
      idleTimeoutSeconds: vmIdleTimeoutSeconds,
    });
    try {
      const authenticated = await vm.exec(withVmHome("gh auth status -h github.com >/dev/null 2>&1"));
      if ((authenticated.statusCode ?? 0) !== 0) {
        await providers.terminal.open("Log in to GitHub", {
          ssh: await providers.freestyle.createSSHOptions({ vmId }),
          command: "gh auth login --hostname github.com --git-protocol https --web",
          keepOpenAfterCommand: true,
          instructions: "Complete the GitHub browser login in this terminal. After gh succeeds, type exit to continue.",
        });

        const verified = await vm.exec(withVmHome("gh auth status -h github.com >/dev/null 2>&1"));
        if ((verified.statusCode ?? 0) !== 0) {
          const status = await vm.exec(withVmHome("gh auth status -h github.com 2>&1"));
          throw new Error(\`GitHub CLI is not authenticated:\\n\${status.stdout || status.stderr}\`.trim());
        }
      }

      const snapshot = await vm.snapshot();
      return { ctx: { snapshotId: snapshot.snapshotId } };
    } finally {
      await providers.freestyle.client.vms.delete(vmId);
    }
  })
  .step("clone-hello-world", async ({ providers, step }) => {
    const { vm, vmId } = await providers.freestyle.client.vms.create({
      snapshotId: step.ctx.snapshotId,
      firewall: vmFirewall,
      idleTimeoutSeconds: vmIdleTimeoutSeconds,
    });
    try {
      const clone = await vm.exec({
        command: [
          "set -e",
          \`export HOME=\${shellQuote(vmHome)}\`,
          \`mkdir -p \${shellQuote(dirname(repoPath))}\`,
          \`rm -rf \${shellQuote(repoPath)}\`,
          \`gh repo clone \${shellQuote(repo)} \${shellQuote(repoPath)}\`,
          \`git -C \${shellQuote(repoPath)} status --short\`,
        ].join("\\n"),
        timeoutMs: 5 * 60 * 1000,
      });
      if ((clone.statusCode ?? 0) !== 0) {
        throw new Error(\`Hello-World clone failed:\\n\${clone.stdout ?? ""}\${clone.stderr ?? ""}\`.trim());
      }

      const snapshot = await vm.snapshot();
      return { ctx: { snapshotId: snapshot.snapshotId, repoPath } };
    } finally {
      await providers.freestyle.client.vms.delete(vmId);
    }
  })
  .workspace({
    create: async ({ workflow, providers }) => {
      console.log("booting workspace vm");
      const { vmId } = await providers.freestyle.client.vms.create({
        snapshotId: workflow.ctx.snapshotId,
        firewall: vmFirewall,
        idleTimeoutSeconds: vmIdleTimeoutSeconds,
      });
      return {
        vmId,
        repoPath: workflow.ctx.repoPath,
      };
    },
    remove: async ({ providers, workspace }) => {
      await providers.freestyle.client.vms.delete(workspace.ctx.vmId);
    },
  })
  .addProvider("cmux", cmux.provider())
  .workspaceOperation("open-cmux", {
    title: "Open cmux",
    description: "Open the workspace in cmux",
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
        text: \`cd \${shellQuote(workspace.ctx.repoPath)} && git status && exec bash -l\\n\`,
      });
      await providers.cmux.selectWorkspace(cmuxWorkspace.workspaceId);
    },
  })
  .workspaceOperation("open-vscode", {
    title: "Open VS Code",
    description: "Open the workspace in VS Code",
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
      await providers.terminal.open(\`SSH \${workspace.name}\`, {
        ssh: await providers.freestyle.createSSHOptions({
          vmId: workspace.ctx.vmId,
        }),
        command: \`cd \${shellQuote(workspace.ctx.repoPath)} && exec bash -l\`,
        keepOpenAfterCommand: true,
        instructions: "Exit the SSH session when you are done.",
      });
    },
  });

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function installDependenciesCommand(): string {
  return [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "apt-get install -y -qq ca-certificates curl git gnupg openssh-client",
    "mkdir -p /etc/apt/keyrings",
    "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg",
    "chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg",
    "printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\\\\n' \\"$(dpkg --print-architecture)\\" > /etc/apt/sources.list.d/github-cli.list",
    "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg",
    "chmod go+r /etc/apt/keyrings/nodesource.gpg",
    "printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\\\\n' > /etc/apt/sources.list.d/nodesource.list",
    "apt-get update -qq",
    "apt-get install -y -qq gh nodejs",
    "git config --system init.defaultBranch main",
    "node --version",
    "npm --version",
    "gh --version",
    "rm -rf /var/lib/apt/lists/*",
  ].join("\\n");
}

function withVmHome(command: string): string {
  return \`HOME=\${shellQuote(vmHome)} \${command}\`;
}

function shellQuote(value: string): string {
  return \`'\${value.replaceAll("'", \`'\\\\''\`)}'\`;
}
`;
}
