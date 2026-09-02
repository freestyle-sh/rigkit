import { defineProvider, type WorkflowProviderDefinition } from "@rigkit/sdk";
import type { BaseProviderPlugin } from "@rigkit/engine";
import * as z from "zod/v4-mini";
import {
  createPortlessController,
  PORTLESS_PROVIDER_ID,
  type PortlessProviderConfig,
  type PortlessRuntime,
} from "./provider.ts";

const portlessProviderConfigSchema = z.strictObject({
  command: z.optional(z.string().check(z.minLength(1))),
  proxyPort: z.optional(z.number().check(z.int(), z.gte(1), z.lte(65_535))),
  https: z.optional(z.boolean()),
  tld: z.optional(z.string().check(z.minLength(1))),
  syncHosts: z.optional(z.boolean()),
});

export type PortlessProviderDefinition = WorkflowProviderDefinition<
  typeof PORTLESS_PROVIDER_ID,
  PortlessProviderConfig,
  PortlessRuntime
>;

export function provider(
  config: PortlessProviderDefinition["config"] = {},
): PortlessProviderDefinition {
  return defineProvider(PORTLESS_PROVIDER_ID, config, portlessProviderPlugin);
}

export const portless = { provider };

export const portlessProviderPlugin: BaseProviderPlugin = {
  providerId: PORTLESS_PROVIDER_ID,
  createProvider({ provider }) {
    const result = z.safeParse(portlessProviderConfigSchema, provider.config);
    if (!result.success) {
      throw new Error(`Invalid Portless provider config:\n${z.prettifyError(result.error)}`);
    }
    return createPortlessController(result.data);
  },
};

export {
  createPortlessController,
  createPortlessRoute,
  PORTLESS_PROVIDER_ID,
} from "./provider.ts";
export { RIGKIT_PROVIDER_PORTLESS_VERSION } from "./version.ts";
export type {
  PortlessProviderConfig,
  PortlessRoute,
  PortlessRouteInput,
  PortlessRuntime,
} from "./provider.ts";
