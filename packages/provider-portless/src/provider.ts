import type { WorkflowProviderController } from "@rigkit/engine";

export const PORTLESS_PROVIDER_ID = "portless";

export type PortlessProviderConfig = {
  command?: string;
  proxyPort?: number;
  https?: boolean;
  tld?: string;
  syncHosts?: boolean;
};

export type PortlessRouteInput = {
  name: string;
  command: string;
  appPort: number;
};

export type PortlessRoute = {
  name: string;
  hostname: string;
  url: string;
  proxyPort: number;
  command: string;
};

export type PortlessRuntime = {
  route(input: PortlessRouteInput): PortlessRoute;
};

export function createPortlessController(
  config: PortlessProviderConfig,
): WorkflowProviderController<PortlessRuntime> {
  return {
    providerId: PORTLESS_PROVIDER_ID,
    runtime() {
      return {
        route: (input) => createPortlessRoute(config, input),
      };
    },
  };
}

export function createPortlessRoute(
  config: PortlessProviderConfig,
  input: PortlessRouteInput,
): PortlessRoute {
  const name = validateName(input.name);
  const appPort = validatePort(input.appPort, "appPort");
  const proxyPort = validatePort(config.proxyPort ?? (config.https === false ? 80 : 443), "proxyPort");
  const https = config.https ?? true;
  const tld = validateTld(config.tld ?? "localhost");
  const hostname = `${name}.${tld}`;
  const urlPort = isDefaultPort(proxyPort, https) ? "" : `:${proxyPort}`;
  const url = `${https ? "https" : "http"}://${hostname}${urlPort}`;
  const command = [
    "env",
    `PORTLESS_PORT=${shellQuote(String(proxyPort))}`,
    `PORTLESS_HTTPS=${shellQuote(https ? "1" : "0")}`,
    `PORTLESS_TLD=${shellQuote(tld)}`,
    `PORTLESS_SYNC_HOSTS=${shellQuote(config.syncHosts === false ? "0" : "1")}`,
    shellQuote(config.command ?? "portless"),
    "run",
    "--name",
    shellQuote(name),
    "--app-port",
    shellQuote(String(appPort)),
    "sh",
    "-lc",
    shellQuote(input.command),
  ].join(" ");

  return { name, hostname, url, proxyPort, command };
}

function validateName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!name || !name.split(".").every(isDnsLabel)) {
    throw new Error(`Invalid Portless route name: ${JSON.stringify(value)}`);
  }
  return name;
}

function validateTld(value: string): string {
  const tld = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!tld || !tld.split(".").every(isDnsLabel)) {
    throw new Error(`Invalid Portless TLD: ${JSON.stringify(value)}`);
  }
  return tld;
}

function isDnsLabel(value: string): boolean {
  return value.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}

function validatePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid Portless ${label}: ${String(value)}`);
  }
  return value;
}

function isDefaultPort(port: number, https: boolean): boolean {
  return port === (https ? 443 : 80);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
