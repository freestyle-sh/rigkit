import { spawnSync } from "node:child_process";

// VS Code Remote-SSH installs a server build matching the *client's* exact
// commit on first connect, which is slow and needs the download to happen
// while the user waits. Detect the local client's commit at workflow
// definition time and prebake that server into the snapshot instead.

export type LocalVscode = {
  version: string;
  commit: string;
};

const vscodeBinaryCandidates = [
  "code",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  "/usr/local/bin/code",
];

export function detectLocalVscode(): LocalVscode | undefined {
  for (const binary of vscodeBinaryCandidates) {
    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status === 0 && result.stdout) {
      const parsed = parseVscodeVersionOutput(result.stdout);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

// `code --version` prints three lines: version, commit sha, architecture.
export function parseVscodeVersionOutput(output: string): LocalVscode | undefined {
  const lines = output.trim().split(/\r?\n/);
  const version = lines[0]?.trim();
  const commit = lines[1]?.trim();
  if (!version || !commit || !/^[0-9a-f]{40}$/.test(commit)) return undefined;
  return { version, commit };
}

export type InstallVscodeServerCommandOptions = {
  /** The client's VS Code commit sha, e.g. from {@link detectLocalVscode}. */
  commit: string;
  /** Home directory of the Linux user the editor connects as. Defaults to /root. */
  home?: string;
};

/**
 * Shell script that installs the VS Code server build for one client commit
 * into `~/.vscode-server`, covering both layouts Remote-SSH looks for: the
 * legacy `bin/<commit>` tree and the exec-server `cli/servers/Stable-<commit>`
 * tree plus the `code-<commit>` CLI binary. Idempotent per commit; the guest
 * architecture is detected inside the script.
 */
export function installVscodeServerCommand(
  options: InstallVscodeServerCommandOptions,
): string {
  const commit = options.commit;
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Invalid VS Code commit sha: ${commit}`);
  }
  const home = options.home ?? "/root";
  return [
    "set -e",
    `export HOME=${shellQuote(home)}`,
    `commit=${commit}`,
    `base=${shellQuote(home)}/.vscode-server`,
    'case "$(uname -m)" in',
    "  x86_64) arch=x64 ;;",
    "  aarch64|arm64) arch=arm64 ;;",
    '  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;',
    "esac",
    'tmp=$(mktemp -d)',
    `trap 'rm -rf "$tmp"' EXIT`,
    'mkdir -p "$base/bin" "$base/cli/servers"',
    'if [ ! -x "$base/bin/$commit/bin/code-server" ]; then',
    '  echo "downloading vscode server $commit ($arch)"',
    '  curl -fsSL "https://update.code.visualstudio.com/commit:$commit/server-linux-$arch/stable" -o "$tmp/server.tar.gz"',
    '  rm -rf "$base/bin/$commit"',
    '  mkdir -p "$base/bin/$commit"',
    '  tar -xzf "$tmp/server.tar.gz" -C "$base/bin/$commit" --strip-components 1',
    "fi",
    'if [ ! -x "$base/cli/servers/Stable-$commit/server/bin/code-server" ]; then',
    '  rm -rf "$base/cli/servers/Stable-$commit"',
    '  mkdir -p "$base/cli/servers/Stable-$commit/server"',
    '  cp -a "$base/bin/$commit/." "$base/cli/servers/Stable-$commit/server/"',
    "fi",
    'if [ ! -x "$base/code-$commit" ]; then',
    '  echo "downloading vscode cli $commit ($arch)"',
    '  curl -fsSL "https://update.code.visualstudio.com/commit:$commit/cli-alpine-$arch/stable" -o "$tmp/cli.tar.gz"',
    '  tar -xzf "$tmp/cli.tar.gz" -C "$tmp"',
    '  mv "$tmp/code" "$base/code-$commit"',
    '  chmod +x "$base/code-$commit"',
    "fi",
    '"$base/bin/$commit/bin/code-server" --version',
    'echo "vscode server $commit ready"',
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
