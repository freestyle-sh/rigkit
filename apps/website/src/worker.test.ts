import { afterEach, describe, expect, test } from "bun:test";
import worker from "./worker.ts";
import {
  DOCS_VERSIONS,
  type ConfiguredDocsVersion,
} from "./worker/docs-versions.ts";

type MetadataBody = {
  version: string;
  tag: string;
  installerUrl: string;
  downloads: Record<string, unknown>;
};

type ErrorBody = {
  error: string;
};

const release = {
  tag_name: "v0.1.6",
  target_commitish: "941775b",
  published_at: "2026-05-02T23:18:46Z",
  html_url: "https://github.com/freestyle-sh/rigkit/releases/tag/v0.1.6",
  assets: [
    asset("checksums.txt"),
    asset("rig-darwin-arm64.tar.gz"),
    asset("rig-darwin-x64.tar.gz"),
    asset("rig-linux-arm64.tar.gz"),
    asset("rig-linux-x64.tar.gz"),
  ],
};

const checksums = [
  `${"a".repeat(64)}  rig-darwin-arm64.tar.gz`,
  `${"b".repeat(64)}  rig-darwin-x64.tar.gz`,
  `${"c".repeat(64)}  rig-linux-arm64.tar.gz`,
  `${"d".repeat(64)}  rig-linux-x64.tar.gz`,
].join("\n");

const originalFetch = globalThis.fetch;
const originalDocsVersions = DOCS_VERSIONS.map(cloneDocsVersion);

afterEach(() => {
  globalThis.fetch = originalFetch;
  setDocsVersions(originalDocsVersions);
});

function setDocsVersions(versions: ConfiguredDocsVersion[]) {
  DOCS_VERSIONS.splice(0, DOCS_VERSIONS.length, ...versions.map(cloneDocsVersion));
}

function cloneDocsVersion(version: ConfiguredDocsVersion): ConfiguredDocsVersion {
  return { ...version };
}

describe("website worker · install routes", () => {
  test("serves latest release metadata from GitHub releases", async () => {
    mockGithubFetch();

    const response = await dispatch("https://www.rigkit.dev/latest.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=30, s-maxage=30");

    const body = await response.json() as MetadataBody;
    expect(body.version).toBe("0.1.6");
    expect(body.tag).toBe("v0.1.6");
    expect(body.installerUrl).toBe("https://www.rigkit.dev/install");
    expect(body.downloads["darwin-arm64"]).toEqual({
      url: "https://www.rigkit.dev/download/v0.1.6/darwin-arm64",
      githubUrl: "https://github.com/freestyle-sh/rigkit/releases/download/v0.1.6/rig-darwin-arm64.tar.gz",
      sha256: "a".repeat(64),
    });
  });

  test("redirects latest downloads to the GitHub release asset", async () => {
    mockGithubFetch();

    const response = await dispatch("https://www.rigkit.dev/download/latest/darwin-arm64");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://github.com/freestyle-sh/rigkit/releases/download/v0.1.6/rig-darwin-arm64.tar.gz");
    expect(response.headers.get("cache-control")).toBe("public, max-age=30");
  });

  test("uses the GitHub token for release API requests when configured", async () => {
    const requests = mockGithubFetch();

    const response = await dispatch("https://www.rigkit.dev/latest.json", {
      GITHUB_TOKEN: "github-token",
    });
    expect(response.status).toBe(200);

    const releaseRequest = requests.find((item) => item.url === "https://api.github.com/repos/freestyle-sh/rigkit/releases/latest");
    expect(releaseRequest?.headers.get("authorization")).toBe("Bearer github-token");
    expect(releaseRequest?.headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  test("does not require the GitHub token locally", async () => {
    const requests = mockGithubFetch();

    const response = await dispatch("https://www.rigkit.dev/latest.json");
    expect(response.status).toBe(200);

    const releaseRequest = requests.find((item) => item.url === "https://api.github.com/repos/freestyle-sh/rigkit/releases/latest");
    expect(releaseRequest?.headers.has("authorization")).toBe(false);
  });

  test("redirects versioned checksum requests to GitHub", async () => {
    mockGithubFetch();

    const response = await dispatch("https://www.rigkit.dev/checksums/v0.1.6");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://github.com/freestyle-sh/rigkit/releases/download/v0.1.6/checksums.txt");
  });

  test("serves an installer script that uses the worker endpoints", async () => {
    const response = await dispatch("https://www.rigkit.dev/install");
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('base_url="${RIGKIT_BASE_URL:-https://www.rigkit.dev}"');
    expect(body).toContain('version="${RIGKIT_VERSION:-latest}"');
    expect(body).toContain('/download/${version}/${target}');
    expect(body).toContain('/checksums/${version}');
    expect(body).toContain('rig completion fish | source');
    expect(body).toContain('eval \\"\\$(rig completion zsh)\\"');
    expect(body).toContain('echo "Shell setup"');
    expect(body).toContain('rig is already on PATH for this terminal.');
    expect(body).toContain('Restart your terminal, or refresh $shell_label now:');
    expect(body).toContain('source \\"$profile\\"');
    expect(body).toContain('Restart your terminal, or run this command to use rig in $shell_label now:');
  });

  test("serves a canary installer script targeting the canary channel", async () => {
    const response = await dispatch("https://www.rigkit.dev/install/canary");
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('version="${RIGKIT_VERSION:-canary}"');
    expect(body).toContain('Installing rig CANARY build');
  });

  test("serves the installer with canonical www.rigkit.dev URLs", async () => {
    const response = await dispatch("https://www.rigkit.dev/install");
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('base_url="${RIGKIT_BASE_URL:-https://www.rigkit.dev}"');
  });

  test("rejects unknown targets", async () => {
    mockGithubFetch();

    const response = await dispatch("https://www.rigkit.dev/download/latest/windows-x64");
    expect(response.status).toBe(400);
    expect(await response.json() as ErrorBody).toEqual({ error: "Unknown target windows-x64. Expected darwin-arm64, darwin-x64, linux-arm64, linux-x64." });
  });

  test("forwards non-install routes to the static asset binding", async () => {
    const assetCalls: string[] = [];
    const env: Env = {
      GITHUB_REPO: "freestyle-sh/rigkit",
      PUBLIC_BASE_URL: "https://www.rigkit.dev",
      CACHE_TTL_SECONDS: "30",
      ASSETS: {
        async fetch(request: Request) {
          assetCalls.push(new URL(request.url).pathname);
          return new Response("<html>hello</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        },
      },
    };

    const response = await worker.fetch(new Request("https://www.rigkit.dev/"), env, ctx());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>hello</html>");
    expect(assetCalls).toEqual(["/index.html"]);
  });

  test("routes latest docs through the docs Worker binding and injects the selector", async () => {
    const docsCalls: string[] = [];
    const env: Env = {
      ...baseEnv(),
      ASSETS: rejectAssets("ASSETS.fetch should not be called for docs routes"),
      DOCS_LATEST: {
        async fetch(request: Request) {
          docsCalls.push(new URL(request.url).pathname);
          return new Response("<!doctype html><html><head></head><body><main>docs</main></body></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
    };

    const response = await worker.fetch(
      new Request("https://www.rigkit.dev/docs/guides/quickstart"),
      env,
      ctx(),
    );

    expect(response.status).toBe(200);
    expect(docsCalls).toEqual(["/docs/guides/quickstart"]);
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(await response.text()).toContain('/docs/docs-version-selector.js');
  });

  test("routes archived docs through their version Worker binding and marks them noindex", async () => {
    const docsCalls: string[] = [];
    setDocsVersions([
      {
        version: "v0.2.17",
        label: "v0.2.17 · Latest",
        basePath: "/docs",
        startPath: "/docs",
        binding: "DOCS_LATEST",
        current: true,
      },
      {
        version: "v0.1",
        label: "v0.1 · v0.1.9",
        basePath: "/docs/v0.1",
        startPath: "/docs/v0.1",
        binding: "DOCS_V0_1",
        archive: true,
      },
    ]);

    const env: Env = {
      ...baseEnv(),
      ASSETS: rejectAssets("ASSETS.fetch should not be called for archived docs routes"),
      DOCS_LATEST: rejectDocs("DOCS_LATEST should not be called for archived docs routes"),
      DOCS_V0_1: {
        async fetch(request: Request) {
          docsCalls.push(new URL(request.url).pathname);
          return new Response("just-bash", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        },
      },
    };

    const response = await worker.fetch(
      new Request("https://www.rigkit.dev/docs/v0.1/bash"),
      env,
      ctx(),
    );

    expect(response.status).toBe(200);
    expect(docsCalls).toEqual(["/docs/v0.1/bash"]);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toBe("just-bash");
  });

  test("serves the public docs versions manifest from the website Worker", async () => {
    setDocsVersions([
      {
        version: "v0.2.17",
        label: "v0.2.17 · Latest",
        basePath: "/docs",
        startPath: "/docs",
        binding: "DOCS_LATEST",
        current: true,
      },
      {
        version: "v0.1",
        label: "v0.1 · v0.1.9",
        basePath: "/docs/v0.1",
        startPath: "/docs/v0.1",
        binding: "DOCS_V0_1",
        archive: true,
      },
    ]);

    const response = await worker.fetch(
      new Request("https://www.rigkit.dev/docs/api/versions.json"),
      {
        ...baseEnv(),
        ASSETS: rejectAssets("ASSETS.fetch should not be called for docs manifest"),
        DOCS_LATEST: rejectDocs("DOCS_LATEST should not be called for docs manifest"),
      },
      ctx(),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toEqual([
      {
        version: "v0.2.17",
        label: "v0.2.17 · Latest",
        basePath: "/docs",
        startPath: "/docs",
        current: true,
        archive: false,
      },
      {
        version: "v0.1",
        label: "v0.1 · v0.1.9",
        basePath: "/docs/v0.1",
        startPath: "/docs/v0.1",
        current: false,
        archive: true,
      },
    ]);
    for (const entry of body.entries) {
      expect(entry).not.toHaveProperty("binding");
    }
  });

  test("serves the docs version selector script from the website Worker", async () => {
    const response = await worker.fetch(
      new Request("https://www.rigkit.dev/docs/docs-version-selector.js"),
      {
        ...baseEnv(),
        ASSETS: rejectAssets("ASSETS.fetch should not be called for docs selector"),
        DOCS_LATEST: rejectDocs("DOCS_LATEST should not be called for docs selector"),
      },
      ctx(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/javascript");
    const script = await response.text();
    expect(script).toContain("/docs/api/versions.json");
    expect(script).toContain("brand-version-select");
    expect(script).not.toContain("sidebar.prepend");
    expect(script).not.toContain('className = "version-select"');
  });

  test("redirects apex and legacy Freestyle domains to www.rigkit.dev", async () => {
    const cases = [
      ["https://rigkit.dev/install", "https://www.rigkit.dev/install"],
      ["https://rigkit.freestyle.sh/install", "https://www.rigkit.dev/install"],
      ["https://docs.rigkit.dev/guides/quickstart", "https://www.rigkit.dev/docs/guides/quickstart"],
      ["http://rig.freestyle.sh/latest.json", "https://www.rigkit.dev/latest.json"],
      ["https://rigkit.freestyle.sh/releases/v0.2.9#assets", "https://www.rigkit.dev/releases/v0.2.9#assets"],
    ] as const;

    for (const [input, location] of cases) {
      const response = await worker.fetch(new Request(input), noopAssetsEnv(), ctx());
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe(location);
    }
  });
});

function noopAssetsEnv(): Env {
  return {
    ...baseEnv(),
    ASSETS: rejectAssets("ASSETS.fetch should not be called for redirect-only paths"),
  };
}

type Env = {
  GITHUB_REPO?: string;
  GITHUB_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
  CACHE_TTL_SECONDS?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  DOCS_LATEST?: { fetch(request: Request): Promise<Response> };
  DOCS_V0_1?: { fetch(request: Request): Promise<Response> };
  [key: string]: unknown;
};

function dispatch(url: string, overrides: Partial<Record<"GITHUB_TOKEN", string>> = {}): Promise<Response> {
  const env: Env = {
    ...baseEnv(),
    ASSETS: rejectAssets("ASSETS.fetch should not be called for install paths"),
    ...overrides,
  };

  return worker.fetch(new Request(url), env, ctx());
}

function baseEnv(): Omit<Env, "ASSETS"> {
  return {
    GITHUB_REPO: "freestyle-sh/rigkit",
    PUBLIC_BASE_URL: "https://www.rigkit.dev",
    CACHE_TTL_SECONDS: "30",
  };
}

function rejectAssets(message: string): Env["ASSETS"] {
  return {
    async fetch() {
      throw new Error(message);
    },
  };
}

function rejectDocs(message: string): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch() {
      throw new Error(message);
    },
  };
}

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: undefined,
  } as unknown as ExecutionContext;
}

function mockGithubFetch(): Array<{ url: string; headers: Headers }> {
  const requests: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, headers: new Headers(input instanceof Request ? input.headers : init?.headers) });

    if (url === "https://api.github.com/repos/freestyle-sh/rigkit/releases/latest") {
      return Response.json(release);
    }
    if (url === "https://api.github.com/repos/freestyle-sh/rigkit/releases/tags/v0.1.6") {
      return Response.json(release);
    }
    if (url === "https://github.com/freestyle-sh/rigkit/releases/download/v0.1.6/checksums.txt") {
      return new Response(checksums, { headers: { "content-type": "text/plain" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return requests;
}

function asset(name: string): { name: string; browser_download_url: string } {
  return {
    name,
    browser_download_url: `https://github.com/freestyle-sh/rigkit/releases/download/v0.1.6/${name}`,
  };
}
