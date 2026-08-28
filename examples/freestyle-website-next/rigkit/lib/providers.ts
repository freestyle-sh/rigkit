import { cmux } from "@rigkit/provider-cmux";
import { freestyle } from "@rigkit/provider-freestyle";
import { portless } from "@rigkit/provider-portless";

export const freestyleProvider = freestyle.provider();
export const terminalProvider = freestyle.terminal();
export const cmuxProvider = cmux.provider();
export const portlessProvider = portless.provider({
  https: false,
  proxyPort: 80,
  syncHosts: false,
});

export type SetupProviders = {
  freestyle: typeof freestyleProvider;
  portless: typeof portlessProvider;
};

export type WebsiteProviders = SetupProviders & {
  terminal: typeof terminalProvider;
  cmux: typeof cmuxProvider;
};
