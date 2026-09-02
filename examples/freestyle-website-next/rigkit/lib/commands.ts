import {
  devEnvironmentPath,
  devServerLogPath,
  devServerPidPath,
  repoPath,
  vmHome,
} from "./config";
import { dirname, shellQuote } from "./shell";

export function installAptDependenciesCommand(): string {
  return `
set -e
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg
mkdir -p /etc/apt/keyrings /usr/local/bin

curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list

rm -f /etc/apt/keyrings/nodesource.gpg
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main\\n' > /etc/apt/sources.list.d/nodesource.list

apt-get update -qq
apt-get install -y -qq build-essential ca-certificates curl gh git gnupg pkg-config python3 unzip xz-utils

nodejs_version=$(apt-cache madison nodejs | awk '$3 ~ /^24[.]/ { print $3; exit }')
if [ -z "$nodejs_version" ]; then
  echo "could not find a Node.js 24.x package candidate" >&2
  apt-cache policy nodejs >&2
  exit 1
fi
apt-get install -y -qq --allow-downgrades "nodejs=$nodejs_version"

for bin in node npm npx corepack; do
  if [ -x "/usr/bin/$bin" ]; then
    ln -sf "/usr/bin/$bin" "/usr/local/bin/$bin"
  fi
done
hash -r

corepack enable
export HOME=/root
export PATH="/usr/local/bin:/root/.local/bin:/opt/bun/bin:$PATH"
npm config set prefix /usr/local
git config --system init.defaultBranch main

node_version=$(node --version)
echo "using Node.js $node_version from $(command -v node)"
case "$node_version" in
  v24.*) ;;
  *) echo "expected Node.js v24.x, got $node_version" >&2; exit 1 ;;
esac

rm -rf /var/lib/apt/lists/*
`;
}

export function installJavaScriptToolsCommand(): string {
  return `
set -e
export HOME=/root
export PATH="/usr/local/bin:/root/.local/bin:/opt/bun/bin:$PATH"
npm config set prefix /usr/local

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

echo "verifying node"
node_version=$(node --version)
echo "$node_version"
case "$node_version" in
  v24.*) ;;
  *) echo "expected Node.js v24.x, got $node_version" >&2; exit 1 ;;
esac

echo "installing bun"
curl -fsSL https://bun.sh/install -o "$tmp_dir/install-bun.sh"
BUN_INSTALL=/opt/bun bash "$tmp_dir/install-bun.sh"
ln -sf /opt/bun/bin/bun /usr/local/bin/bun

echo "installing codex"
# The Freestyle base image ships codex preinstalled as a symlink into its own
# node; remove it so npm can link the pinned install without EEXIST.
rm -f /usr/local/bin/codex
npm install -g @openai/codex
mkdir -p /root/.codex
printf 'cli_auth_credentials_store = "file"\\n' > /root/.codex/config.toml

echo "installing portless"
npm install -g portless@0.15.6

echo "verifying bun"
command -v bun
bun --version

echo "verifying codex"
command -v codex
codex --version

echo "verifying portless"
command -v portless
portless --version
`;
}

export function verifySystemDependenciesCommand(): string {
  return `
set -e
export HOME=/root
export PATH="/usr/local/bin:/root/.local/bin:/opt/bun/bin:$PATH"

command -v node
command -v bun
command -v codex
command -v portless
node --version | grep -E '^v24\\.'
bun --version
codex --version
portless --version
`;
}

// vm.exec does not set HOME, so set it explicitly for commands that expect it.
export function withVmHome(command: string): string {
  return `HOME=${shellQuote(vmHome)} ${command}`;
}

export function agentCliInitCommand(command: "codex"): string {
  return [
    "set -e",
    `export HOME=${shellQuote(vmHome)}`,
    `cd ${shellQuote(repoPath)}`,
    command,
  ].join("\n");
}

export function updateCodexCliAndEnableGoalsCommand(): string {
  const configPath = `${vmHome}/.codex/config.toml`;
  return [
    "set -e",
    `export HOME=${shellQuote(vmHome)}`,
    `export PATH=${shellQuote(devEnvironmentPath)}:"$PATH"`,
    "npm config set prefix /usr/local",
    "npm install -g @openai/codex@latest",
    `mkdir -p ${shellQuote(dirname(configPath))}`,
    `touch ${shellQuote(configPath)}`,
    `python3 - ${shellQuote(configPath)} <<'PY'`,
    "from pathlib import Path",
    "import re",
    "import sys",
    "",
    "path = Path(sys.argv[1])",
    "lines = path.read_text().splitlines() if path.exists() else []",
    "out = []",
    "in_features = False",
    "saw_features = False",
    "set_goals = False",
    "",
    "for line in lines:",
    "    stripped = line.strip()",
    "    is_header = stripped.startswith('[') and stripped.endswith(']') and not stripped.startswith('[[')",
    "    if stripped == '[features]':",
    "        in_features = True",
    "        saw_features = True",
    "        out.append(line)",
    "        continue",
    "    if in_features and is_header:",
    "        if not set_goals:",
    "            out.append('goals = true')",
    "            set_goals = True",
    "        in_features = False",
    "    if in_features and re.match(r'^goals\\s*=', stripped):",
    "        if not set_goals:",
    "            out.append('goals = true')",
    "            set_goals = True",
    "        continue",
    "    out.append(line)",
    "",
    "if in_features and not set_goals:",
    "    out.append('goals = true')",
    "if not saw_features:",
    "    if out and out[-1] != '':",
    "        out.append('')",
    "    out.extend(['[features]', 'goals = true'])",
    "",
    "path.write_text('\\n'.join(out).rstrip() + '\\n')",
    "PY",
    `grep -Eq ${shellQuote("^[[:space:]]*goals[[:space:]]*=[[:space:]]*true[[:space:]]*$")} ${shellQuote(configPath)}`,
    "codex --version",
  ].join("\n");
}

export function configureGitIdentityCommand(): string {
  return [
    "set -e",
    `export HOME=${shellQuote(vmHome)}`,
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

// Start the dev server as a detached background process. shpool used to keep it
// alive across the exec boundary; nohup + a redirected log file does the same job
// without needing an interactive session to snapshot.
export function startDevServerCommand(options: {
  repoPath: string;
  command: string;
}): string {
  return [
    "set -eu",
    `export HOME=${shellQuote(vmHome)}`,
    `export PATH=${shellQuote(devEnvironmentPath)}:"$PATH"`,
    `mkdir -p ${shellQuote(dirname(devServerLogPath))}`,
    `cd ${shellQuote(options.repoPath)}`,
    `if [ -f ${shellQuote(devServerPidPath)} ]; then kill "$(cat ${shellQuote(devServerPidPath)})" 2>/dev/null || true; fi`,
    `: > ${shellQuote(devServerLogPath)}`,
    `printf 'started_at=%s\nrepo=%s\ncommand=%s\n' "$(date -Is)" ${shellQuote(options.repoPath)} ${shellQuote(options.command)} > ${shellQuote(devServerLogPath)}.meta`,
    `nohup ${options.command} </dev/null >${shellQuote(devServerLogPath)} 2>&1 &`,
    `echo $! > ${shellQuote(devServerPidPath)}`,
    `echo "dev server started (pid $(cat ${shellQuote(devServerPidPath)}))"`,
  ].join("\n");
}

export function attachDevServerLogCommand(): string {
  return [
    "set -e",
    `export HOME=${shellQuote(vmHome)}`,
    `export PATH=${shellQuote(devEnvironmentPath)}:"$PATH"`,
    `echo "Tailing dev server log (${devServerLogPath}). Press Ctrl-C to stop."`,
    `exec tail -n +1 -f ${shellQuote(devServerLogPath)}`,
  ].join("\n");
}
