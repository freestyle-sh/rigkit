export const repo = "freestyle-sh/freestyle-website-next";
export const repoUrl = `https://github.com/${repo}.git`;
export const repoPath = "/workspace/freestyle-website-next";

export const devPort = 4321;
export const vmIdleTimeoutSeconds = 43200;
export const vmHome = "/root";

export const devEnvironmentPath =
  "/usr/local/bin:/root/.local/bin:/opt/bun/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export const devCommand = `/usr/local/bin/bun run website:dev -- -- --host 0.0.0.0 --port ${devPort}`;
export const devServerLogPath = `${vmHome}/.local/state/rigkit/dev-server.log`;
export const devServerPidPath = `${vmHome}/.local/state/rigkit/dev-server.pid`;
