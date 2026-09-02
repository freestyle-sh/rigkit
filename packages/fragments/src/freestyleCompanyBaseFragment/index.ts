import {
  execLongCommand,
  freestyle,
  type FirewallSpec,
  type FreestyleProviderDefinition,
  type FreestyleSdkVm,
  type FreestyleTerminalProviderDefinition,
  type VmResources,
} from "@rigkit/provider-freestyle";
import {
  sequence,
  type JsonObject,
  type WorkflowNodeInput,
  type WorkflowNodeOutput,
  type WorkflowNodeDefinition,
  type WorkflowProviderMap,
} from "@rigkit/sdk";

export type FreestyleCompanyBaseFragmentOptions = {
  github?: boolean;
  codex?: boolean;
  claude?: boolean;
  vm?: {
    home?: string;
    memSizeGb?: number;
    vcpuCount?: number;
    rootfsSizeGb?: number;
  };
};

export type FreestyleCompanyBaseFragmentProviderMap = WorkflowProviderMap & {
  freestyle: FreestyleProviderDefinition;
  terminal: FreestyleTerminalProviderDefinition;
};

type FreestyleCompanyBaseFragmentConfig = JsonObject & {
  github: boolean;
  codex: boolean;
  claude: boolean;
  bun: boolean;
  nodeMajor: number;
  codexPackage: string;
  claudePackage: string;
  systemPackages: string[];
  npmPackages: string[];
  vm: {
    home: string;
    idleTimeoutSeconds: number;
    memSizeGb: number;
    vcpuCount: number;
    rootfsSizeGb: number;
  };
};

export type FreestyleCompanyBaseFragmentContext = JsonObject & {
  snapshotId: string;
  freestyleCompanyBase: {
    snapshotId: string;
    home: string;
    idleTimeoutSeconds: number;
    tools: {
      github: boolean;
      codex: boolean;
      claude: boolean;
      bun: boolean;
      nodeMajor: number;
    };
    systemPackages: string[];
    npmPackages: string[];
    authenticated: {
      github: boolean;
      codex: boolean;
      claude: boolean;
    };
  };
};

export type FreestyleCompanyBaseFragment = WorkflowNodeDefinition<FreestyleCompanyBaseFragmentProviderMap, {}, FreestyleCompanyBaseFragmentContext>;

/**
 * `withFreestyleCompanyBase` is an intentionally advanced wrapper pattern.
 *
 * A company base fragment usually needs to do two things that are easy to lose
 * in simpler examples:
 *
 * - seed the workflow with a global, shared base snapshot
 * - let repo-specific setup add fields to ctx while preserving the base ctx
 *   needed by later company checks
 *
 * The types below encode that contract. They reject a child setup that drops
 * `freestyleCompanyBase`, but keep any extra fields the child adds so callers
 * can continue with their repo-specific ctx shape.
 */
export type FreestyleCompanyBaseWrappedFragment<Context extends FreestyleCompanyBaseFragmentContext> =
  WorkflowNodeDefinition<FreestyleCompanyBaseFragmentProviderMap, {}, Context>;

type FreestyleCompanyBasePreservingChild<Child extends WorkflowNodeDefinition<any, any, any>> =
  FreestyleCompanyBaseFragmentContext extends WorkflowNodeInput<Child>
    ? WorkflowNodeOutput<Child> extends FreestyleCompanyBaseFragmentContext
      ? Child
      : never
    : never;

type FreestyleCompanyBasePreservedOutput<Child extends WorkflowNodeDefinition<any, any, any>> =
  WorkflowNodeOutput<Child> extends FreestyleCompanyBaseFragmentContext
    ? WorkflowNodeOutput<Child>
    : never;

const defaultSystemPackages = [
  "build-essential",
  "ca-certificates",
  "curl",
  "git",
  "gnupg",
  "jq",
  "pkg-config",
  "python3",
  "python3-pip",
  "ripgrep",
  "unzip",
  "xz-utils",
] as const;

const bun = true;
const nodeMajor = 22;
const codexPackage = "@openai/codex";
const claudePackage = "@anthropic-ai/claude-code";
const idleTimeoutSeconds = 600;

export function freestyleCompanyBaseFragment(options: FreestyleCompanyBaseFragmentOptions = {}): FreestyleCompanyBaseFragment {
  const github = options.github ?? true;
  const codex = options.codex ?? true;
  const claude = options.claude ?? true;
  const systemPackages = [...defaultSystemPackages];
  const npmPackages = [
    ...(codex ? [codexPackage] : []),
    ...(claude ? [claudePackage] : []),
  ];

  const config: FreestyleCompanyBaseFragmentConfig = {
    github,
    codex,
    claude,
    bun,
    nodeMajor,
    codexPackage,
    claudePackage,
    systemPackages,
    npmPackages,
    vm: {
      home: options.vm?.home ?? "/root",
      idleTimeoutSeconds,
      memSizeGb: options.vm?.memSizeGb ?? 16,
      vcpuCount: options.vm?.vcpuCount ?? 4,
      rootfsSizeGb: options.vm?.rootfsSizeGb ?? 24,
    },
  };

  return sequence<{}, {}>("freestyle-company-base")
    .addProvider("freestyle", freestyle.provider())
    .addProvider("terminal", freestyle.terminal())
    .global()
    .configure(config)
    .task(
      "install-tooling",
      { version: "freestyle-company-base-tooling-v2" },
      async ({ config, providers, step }) => {
        const { vm, vmId, data } = await providers.freestyle.client.vms.create({
          firewall: publicInternetFirewall(),
          idleTimeoutSeconds: config.vm.idleTimeoutSeconds,
        });
        try {
          await growVmResources(vm, data.resources, {
            cpu: config.vm.vcpuCount,
            memory: config.vm.memSizeGb * 1024,
            storage: config.vm.rootfsSizeGb * 1024,
          });
          const tooling = await execLongCommand(vm, {
            command: installToolingCommand(config),
            timeoutMs: 20 * 60 * 1000,
            onOutput: (chunk) => console.log(chunk.trimEnd()),
          });
          if (tooling.timedOut || (tooling.statusCode ?? 0) !== 0) {
            throw new Error(
              `Freestyle company base tooling install ${tooling.timedOut ? "timed out" : "failed"}:\n${tooling.stdout}`.trim(),
            );
          }

          const snapshot = await vm.snapshot();
          return {
            ctx: {
              snapshotId: snapshot.snapshotId,
              freestyleCompanyBase: {
                snapshotId: snapshot.snapshotId,
                home: config.vm.home,
                idleTimeoutSeconds: config.vm.idleTimeoutSeconds,
                tools: {
                  github: config.github,
                  codex: config.codex,
                  claude: config.claude,
                  bun: config.bun,
                  nodeMajor: config.nodeMajor,
                },
                systemPackages: config.systemPackages,
                npmPackages: config.npmPackages,
                authenticated: {
                  github: false,
                  codex: false,
                  claude: false,
                },
              },
            },
          };
        } finally {
          await providers.freestyle.client.vms.delete(vmId);
        }
      },
    )
    .task(
      "github-auth",
      { version: "freestyle-company-base-github-auth-v1" },
      async ({ config, providers, step }) => {
        if (!config.github) return { ctx: { ...step.ctx } };

        const created = await providers.freestyle.client.vms.create({
          snapshotId: step.ctx.snapshotId,
          firewall: publicInternetFirewall(),
          idleTimeoutSeconds: config.vm.idleTimeoutSeconds,
        });
        const { vm, vmId } = created;
        try {
          const authenticated = await vm.exec(withHome(config.vm.home, "gh auth status -h github.com >/dev/null 2>&1"));
          if ((authenticated.statusCode ?? 0) !== 0) {
            await providers.terminal.open("Log in to GitHub", {
              ssh: await providers.freestyle.createSSHOptions({ vmId }),
              command: "gh auth login --hostname github.com --git-protocol https --web",
              keepOpenAfterCommand: true,
              instructions:
                "Complete the GitHub browser login in this terminal. After gh succeeds, type exit to continue.",
            });

            const verified = await vm.exec(withHome(config.vm.home, "gh auth status -h github.com >/dev/null 2>&1"));
            if ((verified.statusCode ?? 0) !== 0) {
              const status = await vm.exec(withHome(config.vm.home, "gh auth status -h github.com 2>&1"));
              throw new Error(
                `GitHub CLI is not authenticated:\n${status.stdout || status.stderr}`.trim(),
              );
            }
          }

          const gitIdentity = await vm.exec({
            command: configureGitIdentityCommand(config.vm.home),
            timeoutMs: 60 * 1000,
          });
          if ((gitIdentity.statusCode ?? 0) !== 0) {
            throw new Error(
              `Git author identity configuration failed:\n${gitIdentity.stdout ?? ""}${gitIdentity.stderr ?? ""}`.trim(),
            );
          }

          const snapshot = await vm.snapshot();
          return { ctx: updateCompanyBaseSnapshot(step.ctx, snapshot.snapshotId, { github: true }) };
        } finally {
          await providers.freestyle.client.vms.delete(vmId);
        }
      },
    )
    .task(
      "codex-auth",
      { version: "freestyle-company-base-codex-auth-v1" },
      async ({ config, providers, step }) => {
        if (!config.codex) return { ctx: { ...step.ctx } };

        const { vm, vmId } = await providers.freestyle.client.vms.create({
          snapshotId: step.ctx.snapshotId,
          firewall: publicInternetFirewall(),
          idleTimeoutSeconds: config.vm.idleTimeoutSeconds,
        });
        try {
          await providers.terminal.open("Initialize Codex CLI", {
            ssh: await providers.freestyle.createSSHOptions({ vmId }),
            command: agentCliInitCommand(config.vm.home, "codex"),
            keepOpenAfterCommand: true,
            instructions:
              "Complete Codex login and initialization in this terminal. Exit Codex, then type exit to continue.",
          });

          const snapshot = await vm.snapshot();
          return { ctx: updateCompanyBaseSnapshot(step.ctx, snapshot.snapshotId, { codex: true }) };
        } finally {
          await providers.freestyle.client.vms.delete(vmId);
        }
      },
    )
    .task(
      "claude-auth",
      { version: "freestyle-company-base-claude-auth-v1" },
      async ({ config, providers, step }) => {
        if (!config.claude) return { ctx: { ...step.ctx } };

        const { vm, vmId } = await providers.freestyle.client.vms.create({
          snapshotId: step.ctx.snapshotId,
          firewall: publicInternetFirewall(),
          idleTimeoutSeconds: config.vm.idleTimeoutSeconds,
        });
        try {
          await providers.terminal.open("Initialize Claude CLI", {
            ssh: await providers.freestyle.createSSHOptions({ vmId }),
            command: agentCliInitCommand(config.vm.home, "claude"),
            keepOpenAfterCommand: true,
            instructions:
              "Complete Claude login and initialization in this terminal. Exit Claude, then type exit to continue.",
          });

          const snapshot = await vm.snapshot();
          return { ctx: updateCompanyBaseSnapshot(step.ctx, snapshot.snapshotId, { claude: true }) };
        } finally {
          await providers.freestyle.client.vms.delete(vmId);
        }
      },
    ) as unknown as FreestyleCompanyBaseFragment;
}

export function withFreestyleCompanyBase<
  Child extends WorkflowNodeDefinition<any, any, any>,
>(
  child: FreestyleCompanyBasePreservingChild<Child>,
  options: FreestyleCompanyBaseFragmentOptions = {},
): FreestyleCompanyBaseWrappedFragment<FreestyleCompanyBasePreservedOutput<Child>> {
  return sequence<{}, {}>("with-freestyle-company-base")
    .addProvider("freestyle", freestyle.provider())
    .addProvider("terminal", freestyle.terminal())
    .add(freestyleCompanyBaseFragment(options))
    .add(child as any)
    .add(freestyleCompanyBaseAuthCheckFragment<FreestyleCompanyBasePreservedOutput<Child>>(options) as any) as unknown as FreestyleCompanyBaseWrappedFragment<FreestyleCompanyBasePreservedOutput<Child>>;
}

function freestyleCompanyBaseAuthCheckFragment<Context extends FreestyleCompanyBaseFragmentContext>(
  options: FreestyleCompanyBaseFragmentOptions,
): WorkflowNodeDefinition<FreestyleCompanyBaseFragmentProviderMap, Context, Context> {
  const handler = async ({ providers, step }: any) => {
    const { vm, vmId } = await providers.freestyle.client.vms.create({
      snapshotId: step.ctx.snapshotId,
      firewall: publicInternetFirewall(),
      idleTimeoutSeconds: step.ctx.freestyleCompanyBase.idleTimeoutSeconds,
    });
    try {
      if (options.github ?? true) {
        const github = await vm.exec(withHome(step.ctx.freestyleCompanyBase.home, "gh auth status -h github.com >/dev/null 2>&1"));
        if ((github.statusCode ?? 0) !== 0) {
          return step.invalidate("github-auth" as never);
        }
      }

      return { ctx: { ...step.ctx } as Context };
    } finally {
      await providers.freestyle.client.vms.delete(vmId);
    }
  };

  return sequence<{}, Context>("freestyle-company-base-auth-check")
    .addProvider("freestyle", freestyle.provider())
    .addProvider("terminal", freestyle.terminal())
    .local()
    .task("check-auth", { cacheTTL: 0 }, handler as any) as unknown as WorkflowNodeDefinition<FreestyleCompanyBaseFragmentProviderMap, Context, Context>;
}

function installToolingCommand(config: FreestyleCompanyBaseFragmentConfig): string {
  const aptPackages = [...config.systemPackages];
  if (config.github && !aptPackages.includes("gh")) aptPackages.push("gh");
  if (!aptPackages.includes("nodejs")) aptPackages.push("nodejs");

  const lines = [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    `export HOME=${shellQuote(config.vm.home)}`,
    "apt-get update -qq",
    "apt-get install -y -qq ca-certificates curl gnupg",
    "mkdir -p /etc/apt/keyrings",
  ];

  if (config.github) {
    lines.push(
      "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg",
      "chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg",
      "printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\\n' \"$(dpkg --print-architecture)\" > /etc/apt/sources.list.d/github-cli.list",
    );
  }

  lines.push(
    "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg",
    "chmod go+r /etc/apt/keyrings/nodesource.gpg",
    `printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${config.nodeMajor}.x nodistro main\\n' > /etc/apt/sources.list.d/nodesource.list`,
  );

  lines.push(
    "apt-get update -qq",
    `apt-get install -y -qq ${aptPackages.map(shellQuote).join(" ")}`,
    "corepack enable || true",
    "npm config set prefix /usr/local",
  );

  // The Freestyle base image preinstalls agent CLIs as symlinks into its own
  // node; remove the ones being reinstalled so npm can link without EEXIST.
  const preinstalledBins: Record<string, string> = {
    [codexPackage]: "codex",
    [claudePackage]: "claude",
  };
  const staleBins = config.npmPackages
    .map((npmPackage) => preinstalledBins[npmPackage])
    .filter((bin): bin is string => Boolean(bin));
  if (staleBins.length) {
    lines.push(`rm -f ${staleBins.map((bin) => shellQuote(`/usr/local/bin/${bin}`)).join(" ")}`);
  }

  const backgroundInstalls: string[] = [];
  if (config.bun) {
    backgroundInstalls.push("curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash");
  }
  for (const npmPackage of config.npmPackages) {
    backgroundInstalls.push(`npm install -g ${shellQuote(npmPackage)}`);
  }

  backgroundInstalls.forEach((command, index) => {
    const pid = `install_pid_${index}`;
    lines.push(`${command} &`, `${pid}=$!`);
  });
  backgroundInstalls.forEach((_, index) => {
    lines.push(`wait "$install_pid_${index}"`);
  });

  if (config.bun) {
    lines.push(
      "ln -sf /opt/bun/bin/bun /usr/local/bin/bun",
      "ln -sf /opt/bun/bin/bunx /usr/local/bin/bunx",
    );
  }
  if (config.codex) {
    lines.push(
      `mkdir -p ${shellQuote(`${config.vm.home}/.codex`)}`,
      `printf 'cli_auth_credentials_store = "file"\\n' > ${shellQuote(`${config.vm.home}/.codex/config.toml`)}`,
    );
  }

  lines.push(
    "git config --system init.defaultBranch main",
    "git --version",
    ...(config.github ? ["gh --version"] : []),
    "node --version",
    "npm --version",
    ...(config.bun ? ["bun --version"] : []),
    ...(config.codex ? ["codex --version"] : []),
    ...(config.claude ? ["claude --version"] : []),
    "rm -rf /var/lib/apt/lists/*",
  );

  return lines.join("\n");
}

function withHome(home: string, command: string): string {
  return `HOME=${shellQuote(home)} ${command}`;
}

function agentCliInitCommand(home: string, command: "codex" | "claude"): string {
  return [
    "set -e",
    `export HOME=${shellQuote(home)}`,
    command,
  ].join("\n");
}

function configureGitIdentityCommand(home: string): string {
  return [
    "set -e",
    `export HOME=${shellQuote(home)}`,
    "login=$(gh api user --jq '.login')",
    "name=$(gh api user --jq '.name // empty')",
    "id=$(gh api user --jq '.id')",
    "email=$(gh api user --jq '.email // empty')",
    'if [ -z "$name" ]; then name="$login"; fi',
    'if [ -z "$email" ]; then email="${id}+${login}@users.noreply.github.com"; fi',
    'git config --global user.name "$name"',
    'git config --global user.email "$email"',
  ].join("\n");
}

function updateCompanyBaseSnapshot(
  ctx: Readonly<FreestyleCompanyBaseFragmentContext>,
  snapshotId: string,
  authenticated: Partial<FreestyleCompanyBaseFragmentContext["freestyleCompanyBase"]["authenticated"]>,
): FreestyleCompanyBaseFragmentContext {
  return {
    ...ctx,
    snapshotId,
    freestyleCompanyBase: {
      ...ctx.freestyleCompanyBase,
      snapshotId,
      authenticated: {
        ...ctx.freestyleCompanyBase.authenticated,
        ...authenticated,
      },
    },
  };
}

// Freestyle v2 VMs reach nothing they have not been allowed to; tooling
// installs and browser-auth flows need the public internet.
function publicInternetFirewall(): FirewallSpec {
  return {
    rules: [{ action: "allow", source: {}, destination: { public: true } }],
  };
}

// Freestyle v2 sizes VMs from their snapshot; resize is grow-only, so only
// dimensions above the current shape are requested.
async function growVmResources(
  vm: FreestyleSdkVm,
  current: VmResources,
  requested: VmResources,
): Promise<void> {
  const target = {
    cpu: Math.max(current.cpu, requested.cpu),
    memory: Math.max(current.memory, requested.memory),
    storage: Math.max(current.storage, requested.storage),
  };
  if (
    target.cpu === current.cpu &&
    target.memory === current.memory &&
    target.storage === current.storage
  ) {
    return;
  }
  await vm.resize(target);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
