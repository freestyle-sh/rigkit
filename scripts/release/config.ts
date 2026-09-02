import { join } from "node:path";

export type ReleasePackage = {
  name: string;
  dir: string;
  versionFile: string;
  versionConstant: string;
};

export const root = join(import.meta.dir, "..", "..");

export const releasePackages: ReleasePackage[] = [
  {
    name: "@rigkit/engine",
    dir: "packages/engine",
    versionFile: "packages/engine/src/version.ts",
    versionConstant: "RIGKIT_ENGINE_VERSION",
  },
  {
    name: "@rigkit/runtime-client",
    dir: "packages/runtime-client",
    versionFile: "packages/runtime-client/src/version.ts",
    versionConstant: "RIGKIT_RUNTIME_CLIENT_VERSION",
  },
  {
    name: "@rigkit/sdk",
    dir: "packages/sdk",
    versionFile: "packages/sdk/src/version.ts",
    versionConstant: "RIGKIT_SDK_VERSION",
  },
  {
    name: "@rigkit/provider-freestyle",
    dir: "packages/provider-freestyle",
    versionFile: "packages/provider-freestyle/src/version.ts",
    versionConstant: "RIGKIT_PROVIDER_FREESTYLE_VERSION",
  },
  {
    name: "@rigkit/provider-cmux",
    dir: "packages/provider-cmux",
    versionFile: "packages/provider-cmux/src/version.ts",
    versionConstant: "RIGKIT_PROVIDER_CMUX_VERSION",
  },
  {
    name: "@rigkit/provider-gcloud-cli",
    dir: "packages/provider-gcloud-cli",
    versionFile: "packages/provider-gcloud-cli/src/version.ts",
    versionConstant: "RIGKIT_PROVIDER_GCLOUD_CLI_VERSION",
  },
  {
    name: "@rigkit/provider-portless",
    dir: "packages/provider-portless",
    versionFile: "packages/provider-portless/src/version.ts",
    versionConstant: "RIGKIT_PROVIDER_PORTLESS_VERSION",
  },
  {
    name: "@rigkit/provider-vscode",
    dir: "packages/provider-vscode",
    versionFile: "packages/provider-vscode/src/version.ts",
    versionConstant: "RIGKIT_PROVIDER_VSCODE_VERSION",
  },
  {
    name: "@rigkit/fragments",
    dir: "packages/fragments",
    versionFile: "packages/fragments/src/version.ts",
    versionConstant: "RIGKIT_FRAGMENTS_VERSION",
  },
  {
    name: "@rigkit/cli",
    dir: "packages/cli",
    versionFile: "packages/cli/src/version.ts",
    versionConstant: "RIGKIT_CLI_VERSION",
  },
];

export const sdkRuntimeVersion = {
  file: "packages/sdk/src/runtime/version.ts",
  constant: "RIGKIT_RUNTIME_VERSION",
};

export const cliRelease = {
  packageName: "@rigkit/cli",
  binaryName: "rig",
};

export const sdkVersionExpectationFiles = ["packages/sdk/src/index.test.ts"];

export const releaseLabels = [
  "release:none",
  "release:patch",
  "release:minor",
  "release:major",
] as const;

export type ReleaseLabel = (typeof releaseLabels)[number];
export type ReleaseType = "patch" | "minor" | "major";

export function tarballNameForPackage(packageName: string, version: string) {
  const normalized = packageName.replace(/^@/, "").replace("/", "-");
  return `${normalized}-${version}.tgz`;
}

export function versionLineForVersion(version: string) {
  const parsed = parseVersion(version);
  return `${parsed.major}.${parsed.minor}`;
}

export function parseVersion(version: string) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/);
  if (!match) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function bumpVersion(version: string, releaseType: ReleaseType) {
  const parsed = parseVersion(version);

  if (releaseType === "patch") {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }

  if (releaseType === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }

  return `${parsed.major + 1}.0.0`;
}
