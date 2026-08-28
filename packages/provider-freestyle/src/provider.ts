import { FreestyleApiError, type Freestyle } from "freestyle";
import type {
  SshConnection,
  SshOptions,
  WorkflowProviderCheckResult,
  WorkflowProviderController,
  ProviderRuntimeContext,
} from "@rigkit/engine";
import type { CmuxSshInput } from "@rigkit/provider-cmux";
import type { FreestyleIdentityId, FreestyleToken } from "./auth.ts";
import type { FreestyleResolvedTeam } from "./host-auth.ts";
import { createFreestyleTerminalSession } from "./terminal-session.ts";

export const FREESTYLE_PROVIDER_ID = "freestyle";
export const FREESTYLE_TERMINAL_PROVIDER_ID = "freestyle-terminal";

export const FREESTYLE_SSH_HOST = "beta-ssh.freestyle.sh";

export type FreestyleSdkVm = ReturnType<Freestyle["vms"]["ref"]>;

export type FreestyleSshInput = SshOptions & {
  vmId: string;
};

export type FreestyleCmuxSshOptions = Exclude<CmuxSshInput, string>;

export type FreestyleCmuxSshOptionsInput = Omit<
  FreestyleCmuxSshOptions,
  "kind" | "destination" | "host" | "username"
> &
  FreestyleSshInput;

export type FreestyleVscodeUrlOptions = FreestyleSshInput & {
  cwd?: string;
};

export type FreestyleRuntime = {
  readonly client: Freestyle;
  terminal: {
    open(
      title: string,
      options: {
        vmId: string;
        command: string;
        linuxUser?: string;
        canFinishWhileRunning?: boolean;
        instructions?: string;
      },
    ): Promise<{ finished: true }>;
  };
  createSSHOptions(input: FreestyleSshInput): Promise<SshConnection>;
  cmux: {
    createSshOptions(
      input: FreestyleCmuxSshOptionsInput,
    ): Promise<FreestyleCmuxSshOptions>;
  };
  vscode: {
    createUrl(input: FreestyleVscodeUrlOptions): Promise<string>;
  };
};

export type FreestyleTerminalRuntime = {
  open(
    title: string,
    options: {
      ssh: SshConnection;
      command?: string;
      keepOpenAfterCommand?: boolean;
      instructions?: string;
    },
  ): Promise<{ finished: true }>;
};

export function createFreestyleWorkflowProvider(input: {
  client: Freestyle;
  identityId: FreestyleIdentityId;
  token: FreestyleToken;
  team?: FreestyleResolvedTeam;
}): WorkflowProviderController<FreestyleRuntime> {
  return createFreestyleWorkflowController(input);
}

export function createFreestyleWorkflowController(input: {
  client: Freestyle;
  identityId: FreestyleIdentityId;
  token: FreestyleToken;
  team?: FreestyleResolvedTeam;
}): WorkflowProviderController<FreestyleRuntime> {
  return {
    providerId: FREESTYLE_PROVIDER_ID,
    checks() {
      if (!input.team) return undefined;
      return {
        id: "team",
        label: "Freestyle team",
        status: "ok",
        value: formatFreestyleTeam(input.team),
        detail: input.team.id,
        fingerprint: `identity:${input.identityId}`,
        metadata: {
          teamId: input.team.id,
          ...(input.team.displayName
            ? { teamName: input.team.displayName }
            : {}),
        },
      };
    },
    runtime(context) {
      return createFreestyleRuntime(input, context);
    },
  };
}

export function createLazyFreestyleWorkflowController(input: {
  authenticate(): Promise<{
    client: Freestyle;
    identityId: FreestyleIdentityId;
    token: FreestyleToken;
    team?: FreestyleResolvedTeam;
  }>;
  checks(context: {
    mode: "plan" | "require";
  }): Promise<WorkflowProviderCheckResult[]>;
}): WorkflowProviderController<FreestyleRuntime> {
  return {
    providerId: FREESTYLE_PROVIDER_ID,
    checks: input.checks,
    async runtime(context) {
      const authenticated = await input.authenticate();
      return createFreestyleRuntime(authenticated, context);
    },
  };
}

export function createFreestyleTerminalController(): WorkflowProviderController<FreestyleTerminalRuntime> {
  return {
    providerId: FREESTYLE_TERMINAL_PROVIDER_ID,
    runtime(context) {
      return {
        open: async (title, options) => {
          const command = buildInteractiveSshCommand(
            options.ssh,
            options.command,
            {
              keepOpenAfterCommand: options.keepOpenAfterCommand,
            },
          );
          const session = createFreestyleTerminalSession({
            title,
            command,
            displayCommand: options.command,
            canFinishWhileRunning: options.keepOpenAfterCommand,
            instructions: options.instructions,
            nodePath: context.nodePath,
            openExternalTarget: (target) => context.local.open(target),
          });
          return await context.interaction.present(session);
        },
      };
    },
  };
}

function createFreestyleRuntime(input: {
  client: Freestyle;
  identityId: FreestyleIdentityId;
  token: FreestyleToken;
}, context: ProviderRuntimeContext): FreestyleRuntime {
  const ensureSSHAccess = async (vmId: string) => {
    const identity = input.client.identities.ref(input.identityId);
    try {
      await identity.permissions.vm.grant({ vmId });
    } catch (error) {
      if (!isPermissionAlreadyExistsError(error)) {
        throw error;
      }
      await identity.permissions.vm.update(vmId, null);
    }
  };

  const runtime: FreestyleRuntime = {
    client: input.client,
    terminal: {
      open: async (title, options) => {
        const session = createFreestyleTerminalSession({
          title,
          command: withBrowserOpenFallback(options.command),
          displayCommand: options.command,
          pty: {
            vm: input.client.vms.ref(options.vmId),
            linuxUser: options.linuxUser,
          },
          canFinishWhileRunning: options.canFinishWhileRunning,
          instructions: options.instructions,
          nodePath: context.nodePath,
          openExternalTarget: (target) => context.local.open(target),
        });
        return await context.interaction.present(session);
      },
    },
    createSSHOptions: async ({ vmId, user }) => {
      await ensureSSHAccess(vmId);
      return freestyleSshConnection(vmId, input.token, user);
    },
    cmux: {
      createSshOptions: async (options) => {
        const { vmId, user, ...sshOptions } = options;
        await ensureSSHAccess(vmId);
        return freestyleCmuxSshOptions(vmId, input.token, user, sshOptions);
      },
    },
    vscode: {
      createUrl: async ({ vmId, user, cwd }) => {
        await ensureSSHAccess(vmId);
        return freestyleVscodeUrl(vmId, input.token, user, { cwd });
      },
    },
  };

  return runtime;
}

const defaultFreestyleVmUser = "root";

function formatFreestyleTeam(team: FreestyleResolvedTeam): string {
  return team.displayName ? `${team.displayName} (${team.id})` : team.id;
}

function freestyleSshUsername(vmId: string, user: string | undefined): string {
  return `${vmId}+${user ?? defaultFreestyleVmUser}`;
}

// Editor and cmux connections address the VM through its own subdomain so the
// SSH proxy can identify the target before authentication completes.
function freestyleEditorSshHost(vmId: string): string {
  return `${vmId}.${FREESTYLE_SSH_HOST}`;
}

function freestyleSshConnection(
  vmId: string,
  token: FreestyleToken,
  user: string | undefined,
): SshConnection {
  const username = freestyleSshUsername(vmId, user);
  return {
    kind: "ssh",
    host: FREESTYLE_SSH_HOST,
    username,
    auth: { type: "token", token },
    command: `ssh ${username}:${token}@${FREESTYLE_SSH_HOST}`,
  };
}

function isPermissionAlreadyExistsError(error: unknown): boolean {
  if (error instanceof FreestyleApiError) {
    if (error.status === 409) return true;
    return normalizeErrorCode(error.code).includes("ALREADYEXISTS");
  }
  return errorStrings(error).some((value) =>
    normalizeErrorCode(value).includes("ALREADYEXISTS"),
  );
}

function errorStrings(error: unknown): string[] {
  if (typeof error === "string") return [error];
  if (!error || typeof error !== "object") return [];

  const record = error as Record<string, unknown>;
  const values: string[] = [];
  for (const key of ["error", "code", "name", "message", "reason"]) {
    const value = record[key];
    if (typeof value === "string") values.push(value);
    else values.push(...errorStrings(value));
  }
  values.push(...errorStrings(record.cause));
  return values;
}

function normalizeErrorCode(value: string): string {
  return value.replaceAll(/[^a-zA-Z]/g, "").toUpperCase();
}

// Freestyle SSH authenticates through the token in the username, so client
// keys are irrelevant and the proxy's host key would otherwise prompt on
// first contact. Shared by the cmux, editor, and interactive terminal paths.
const freestyleTokenSshOptions = [
  "StrictHostKeyChecking=no",
  "UserKnownHostsFile=/dev/null",
  "LogLevel=ERROR",
  "IdentitiesOnly=yes",
  "IdentityFile=/dev/null",
  "ControlMaster=no",
] as const;

function freestyleCmuxSshOptions(
  vmId: string,
  token: FreestyleToken,
  user: string | undefined,
  options:
    | Omit<FreestyleCmuxSshOptionsInput, keyof FreestyleSshInput>
    | undefined,
): FreestyleCmuxSshOptions {
  const { sshOptions, port, ...rest } = options ?? {};
  const mergedSshOptions = [
    ...freestyleTokenSshOptions,
    ...(sshOptions ?? []),
  ];
  return {
    kind: "ssh",
    destination: `${freestyleEditorUsername(vmId, user)},${token}@${freestyleEditorSshHost(vmId)}`,
    ...(port !== undefined ? { port } : {}),
    ...rest,
    sshOptions: mergedSshOptions,
  };
}

// Editor connections default to root when no Linux user is named. Omitting
// `+root` matters for VS Code: it splits the remote authority on `+`, so a
// user suffix in the authority makes it misparse the hostname.
function freestyleEditorUsername(vmId: string, user: string | undefined): string {
  if (!user || user === defaultFreestyleVmUser) return vmId;
  return `${vmId}+${user}`;
}

function freestyleVscodeUrl(
  vmId: string,
  token: FreestyleToken,
  user: string | undefined,
  options: { cwd?: string } = {},
): string {
  const authority = `${freestyleEditorUsername(vmId, user)},${token}@${freestyleEditorSshHost(vmId)}`;
  return `vscode://vscode-remote/ssh-remote+${authority}${options.cwd ?? ""}?windowId=_blank`;
}

export function buildInteractiveSshCommand(
  connection: SshConnection,
  remoteCommand: string | undefined,
  options: { keepOpenAfterCommand?: boolean } = {},
): string {
  if (connection.auth.type === "privateKey") {
    return connection.command;
  }

  const command =
    remoteCommand && options.keepOpenAfterCommand
      ? keepOpenAfterCommand(remoteCommand)
      : remoteCommand;
  const destination = `${connection.username}:${connection.auth.token}@${connection.host}`;
  const args = ["ssh"];
  for (const option of freestyleTokenSshOptions) {
    args.push("-o", option);
  }
  if (command) args.push("-tt", "-q");
  if (connection.port !== undefined) args.push("-p", String(connection.port));
  args.push(destination);
  if (command) args.push(withBrowserOpenFallback(command));
  return args
    .map((arg) =>
      arg === "ssh" || arg.startsWith("-") ? arg : shellQuote(arg),
    )
    .join(" ");
}

function withBrowserOpenFallback(command: string): string {
  return [
    'export BROWSER="${BROWSER:-true}"',
    'export GH_BROWSER="${GH_BROWSER:-$BROWSER}"',
    command,
  ].join("\n");
}

function keepOpenAfterCommand(command: string): string {
  return [
    command,
    "status=$?",
    'if [ "$status" -ne 0 ]; then exit "$status"; fi',
    `printf '\\nCommand completed. Type exit to continue.\\n'`,
    'exec "${SHELL:-/bin/bash}" -l',
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
