import {
  defineProvider,
  type WorkflowProviderDefinition,
} from "@rigkit/sdk";
import type { BaseProviderPlugin } from "@rigkit/engine";
import * as z from "zod/v4-mini";
import { freestyleIdentityId, freestyleToken, freestyleTokenId } from "./auth.ts";
import {
  checkFreestyleProviderAuth,
  createFreestyleAuthenticatedClient,
  freestyleProviderChecksFromAuthenticated,
  type FreestyleProviderConfig,
} from "./host-auth.ts";
import {
  FREESTYLE_PROVIDER_ID,
  FREESTYLE_TERMINAL_PROVIDER_ID,
  createLazyFreestyleWorkflowController,
  createFreestyleTerminalController,
  createFreestyleWorkflowProvider,
} from "./provider.ts";
import type { FreestyleRuntime, FreestyleTerminalRuntime } from "./provider.ts";

const freestyleProviderConfigSchema = z.strictObject({
  apiKey: z.optional(z.string().check(z.minLength(1))),
  profile: z.optional(z.string().check(z.minLength(1))),
  teamId: z.optional(z.string().check(z.minLength(1))),
  apiUrl: z.optional(z.string().check(z.minLength(1))),
  dashboardUrl: z.optional(z.string().check(z.minLength(1))),
});

export type { FreestyleProviderConfig };

export type FreestyleProviderDefinition = WorkflowProviderDefinition<
  typeof FREESTYLE_PROVIDER_ID,
  FreestyleProviderConfig,
  FreestyleRuntime
>;

export type FreestyleProviderOptions =
  | string
  | FreestyleProviderDefinition["config"];

export type FreestyleTerminalProviderDefinition = WorkflowProviderDefinition<
  typeof FREESTYLE_TERMINAL_PROVIDER_ID,
  {},
  FreestyleTerminalRuntime
>;

export function provider(
  config: FreestyleProviderOptions = {},
): FreestyleProviderDefinition {
  return defineProvider(FREESTYLE_PROVIDER_ID, normalizeFreestyleProviderOptions(config), freestyleProviderPlugin);
}

export function terminal(): FreestyleTerminalProviderDefinition {
  return defineProvider(FREESTYLE_TERMINAL_PROVIDER_ID, {}, freestyleTerminalPlugin);
}

export const freestyle = {
  provider,
  terminal,
};

export const defineFreestyleProvider = provider;

export const freestyleProviderPlugin: BaseProviderPlugin = {
  providerId: FREESTYLE_PROVIDER_ID,
  async createProvider({ provider, hostStorage, local }) {
    const config = parseFreestyleProviderConfig(provider.config);
    let authenticated: ReturnType<typeof createFreestyleAuthenticatedClient> | undefined;
    const authenticate = () => authenticated ??= createFreestyleAuthenticatedClient({
      config,
      hostStorage,
      local,
    });
    return createLazyFreestyleWorkflowController({
      authenticate,
      checks: async ({ mode }) => {
        if (mode === "require") {
          return freestyleProviderChecksFromAuthenticated(await authenticate());
        }
        return checkFreestyleProviderAuth({ config, hostStorage });
      },
    });
  },
};

export const freestyleTerminalPlugin: BaseProviderPlugin = {
  providerId: FREESTYLE_TERMINAL_PROVIDER_ID,
  createProvider() {
    return createFreestyleTerminalController();
  },
};

export {
  checkFreestyleProviderAuth,
  createFreestyleAuthenticatedClient,
  createFreestyleSdkFetch,
  freestyleProviderChecksFromAuthenticated,
} from "./host-auth.ts";
export {
  freestyleIdentityId,
  freestyleToken,
  freestyleTokenId,
  type FreestyleIdentityId,
  type FreestyleToken,
  type FreestyleTokenId,
} from "./auth.ts";
export {
  FREESTYLE_PROVIDER_ID,
  FREESTYLE_SSH_HOST,
  FREESTYLE_TERMINAL_PROVIDER_ID,
  createFreestyleTerminalController,
  createLazyFreestyleWorkflowController,
  createFreestyleWorkflowController,
  createFreestyleWorkflowProvider,
} from "./provider.ts";
export {
  FREESTYLE_EXEC_TIMEOUT_CAP_MS,
  execLongCommand,
  type FreestyleLongExecOptions,
  type FreestyleLongExecResult,
  type FreestyleLongExecTarget,
} from "./long-exec.ts";
export {
  detectLocalVscode,
  installVscodeServerCommand,
  parseVscodeVersionOutput,
  type InstallVscodeServerCommandOptions,
  type LocalVscode,
} from "./vscode-server.ts";
export { createFreestyleStore } from "./store.ts";
export { createFreestyleTerminalSession } from "./terminal-session.ts";
export { RIGKIT_PROVIDER_FREESTYLE_VERSION } from "./version.ts";
export { Freestyle, FreestyleApiError } from "freestyle";
export type { CreateVmOptions, FirewallSpec, VmData, VmResources } from "freestyle";
export type {
  FreestyleCmuxSshOptions,
  FreestyleCmuxSshOptionsInput,
  FreestyleRuntime,
  FreestyleSdkVm,
  FreestyleSshInput,
  FreestyleTerminalRuntime,
  FreestyleVscodeUrlOptions,
} from "./provider.ts";
export type { FreestyleGitRelationship, FreestyleIdentity } from "./store.ts";
export type { FreestyleResolvedTeam } from "./host-auth.ts";

function parseFreestyleProviderConfig(value: unknown): FreestyleProviderConfig {
  const result = z.safeParse(freestyleProviderConfigSchema, normalizeFreestyleProviderOptions(value));
  if (!result.success) {
    throw new Error(`Invalid Freestyle provider config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function normalizeFreestyleProviderOptions(value: unknown): FreestyleProviderDefinition["config"] {
  if (typeof value === "string") {
    return { apiKey: value };
  }
  return value as FreestyleProviderDefinition["config"];
}
