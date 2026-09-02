import type { FirewallSpec } from "@rigkit/provider-freestyle";

export const repo = "freestyle-sh/freestyle-website-next";
export const repoUrl = `https://github.com/${repo}.git`;
export const repoPath = "/workspace/freestyle-website-next";

export const devAppPort = 4321;
export const devRouteName = "freestyle-website";
export const vmIdleTimeoutSeconds = 43200;
export const vmHome = "/root";

export const devEnvironmentPath =
  "/usr/local/bin:/root/.local/bin:/opt/bun/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export const devAppCommand = `/usr/local/bin/bun run website:dev -- -- --host 0.0.0.0 --port ${devAppPort}`;
export const devServerLogPath = `${vmHome}/.local/state/rigkit/dev-server.log`;
export const devServerPidPath = `${vmHome}/.local/state/rigkit/dev-server.pid`;

// A Freestyle VM reaches nothing it has not been allowed to; setup tasks need
// the public internet for apt, GitHub, and npm.
export const vmFirewall: FirewallSpec = {
  rules: [{ action: "allow", source: {}, destination: { public: true } }],
};
