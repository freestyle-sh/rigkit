import { createHash } from "node:crypto";
import { Freestyle } from "freestyle";
import type { LocalWorkspaceRuntime, ProviderStorage, WorkflowProviderCheckResult } from "@rigkit/engine";
import type { JsonValue } from "@rigkit/sdk";
import { freestyleIdentityId, freestyleToken, freestyleTokenId } from "./auth.ts";
import { createFreestyleStore } from "./store.ts";
import { RIGKIT_PROVIDER_FREESTYLE_VERSION } from "./version.ts";

const DEFAULT_STACK_API_URL = "https://api.stack-auth.com";
const DEFAULT_STACK_APP_URL = "https://dash.freestyle.sh";
const DEFAULT_FREESTYLE_API_URL = "https://api.freestyle.sh";
const DEFAULT_STACK_PROJECT_ID = "0edf478c-f123-46fb-818f-34c0024a9f35";
const DEFAULT_STACK_PUBLISHABLE_CLIENT_KEY = "pck_h2aft7g9pqjzrkdnzs199h1may5wjtdtdxeex7m2wzp1r";
const DEFAULT_CLI_AUTH_TIMEOUT_MILLIS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MILLIS = 2000;
const RIGKIT_HEADER = "x-rigkit";
const RIGKIT_VERSION_HEADER = "x-rigkit-version";
const FREESTYLE_TRACE_ID_HEADER = "x-freestyle-trace-id";

export type FreestyleProviderConfig = {
  apiKey?: string;
  profile?: string;
  teamId?: string;
  apiUrl?: string;
  dashboardUrl?: string;
};

export type FreestyleAuthenticatedClient = {
  client: Freestyle;
  identityId: ReturnType<typeof freestyleIdentityId>;
  tokenId: ReturnType<typeof freestyleTokenId>;
  token: ReturnType<typeof freestyleToken>;
  team?: FreestyleResolvedTeam;
};

type CreateFreestyleAuthenticatedClientInput = {
  config?: FreestyleProviderConfig;
  hostStorage: ProviderStorage;
  local: LocalWorkspaceRuntime;
  fetch?: typeof fetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

type ResolvedClientAuth = {
  client: Freestyle;
  identityKey: string;
  team?: FreestyleResolvedTeam;
};

type StackAuthConfig = {
  stackApiUrl: string;
  appUrl: string;
  dashboardUrl: string;
  projectId: string;
  publishableClientKey: string;
  profile: string;
};

type StackAuthState = {
  refreshToken: string;
  updatedAt: number;
  defaultTeamId?: string;
  defaultTeamName?: string;
  accessToken?: string;
  accessTokenUpdatedAt?: number;
};

type StackTokenRefresh = {
  accessToken: string;
  refreshToken?: string;
};

type FreestyleTeam = {
  id: string;
  displayName?: string;
  sandboxAccountId?: string | null;
};

export type FreestyleResolvedTeam = {
  id: string;
  displayName?: string;
};

export async function createFreestyleAuthenticatedClient(
  input: CreateFreestyleAuthenticatedClientInput,
): Promise<FreestyleAuthenticatedClient> {
  const auth = await resolveClientAuth(input);
  const store = createFreestyleStore(input.hostStorage);
  const savedIdentity = store.getIdentity(auth.identityKey);
  if (savedIdentity) {
    return {
      client: auth.client,
      identityId: savedIdentity.identityId,
      tokenId: savedIdentity.tokenId,
      token: savedIdentity.token,
      team: auth.team,
    };
  }

  const { identity, identityId } = await auth.client.identities.create();
  const { token, id: tokenId } = await identity.tokens.create();
  const createdIdentity = store.saveIdentity({
    key: auth.identityKey,
    identityId: freestyleIdentityId(identityId),
    tokenId: freestyleTokenId(tokenId),
    token: freestyleToken(token),
  });

  return {
    client: auth.client,
    identityId: createdIdentity.identityId,
    tokenId: createdIdentity.tokenId,
    token: createdIdentity.token,
    team: auth.team,
  };
}

export function checkFreestyleProviderAuth(input: {
  config?: FreestyleProviderConfig;
  hostStorage: ProviderStorage;
}): WorkflowProviderCheckResult[] {
  const apiKey = nonEmpty(input.config?.apiKey);
  const apiUrl = nonEmpty(input.config?.apiUrl) ?? nonEmpty(process.env.FREESTYLE_API_URL);
  const store = createFreestyleStore(input.hostStorage);

  if (apiKey) {
    const identityKey = apiKeyIdentityKey({ apiUrl, apiKey });
    return [{
      id: "auth",
      label: "Freestyle auth",
      status: "ok",
      value: "API key",
      fingerprint: providerIdentityFingerprint(identityKey, store.getIdentity(identityKey)),
    }];
  }

  const stack = resolveStackAuthConfig(input.config);
  const stored = readStackAuthState(input.hostStorage.get(stackAuthStateKey(stack))?.value);
  const configuredTeamId = nonEmpty(input.config?.teamId) ?? nonEmpty(process.env.FREESTYLE_TEAM_ID);

  if (!stored?.refreshToken) {
    return [{
      id: "auth",
      label: "Freestyle auth",
      status: "required",
      value: "login required",
      message: "Run rig apply, rig create, or rig run to authenticate with Freestyle.",
      fingerprint: `browser:${stack.profile}:auth:missing`,
    }];
  }

  const teamId = configuredTeamId ?? stored.defaultTeamId;
  if (!teamId) {
    return [{
      id: "team",
      label: "Freestyle team",
      status: "required",
      value: "team selection required",
      message: "Run rig apply, rig create, or rig run to choose a Freestyle team.",
      fingerprint: `browser:${stack.profile}:team:missing`,
    }];
  }

  const identityKey = browserIdentityKey({
    apiUrl,
    dashboardUrl: stack.dashboardUrl,
    profile: stack.profile,
    teamId,
  });
  const storedTeamName = teamId === stored.defaultTeamId ? stored.defaultTeamName : undefined;
  return [{
    id: "team",
    label: "Freestyle team",
    status: "ok",
    value: formatFreestyleTeam({ id: teamId, displayName: storedTeamName }),
    detail: teamId,
    fingerprint: providerIdentityFingerprint(identityKey, store.getIdentity(identityKey)),
    metadata: {
      teamId,
      ...(storedTeamName ? { teamName: storedTeamName } : {}),
    },
  }];
}

export function freestyleProviderChecksFromAuthenticated(
  auth: FreestyleAuthenticatedClient,
): WorkflowProviderCheckResult[] {
  if (auth.team) {
    return [{
      id: "team",
      label: "Freestyle team",
      status: "ok",
      value: formatFreestyleTeam(auth.team),
      detail: auth.team.id,
      fingerprint: `identity:${auth.identityId}`,
      metadata: {
        teamId: auth.team.id,
        ...(auth.team.displayName ? { teamName: auth.team.displayName } : {}),
      },
    }];
  }
  return [{
    id: "auth",
    label: "Freestyle auth",
    status: "ok",
    value: "API key",
    fingerprint: `identity:${auth.identityId}`,
  }];
}

export function createFreestyleSdkFetch(fetchFn: typeof fetch = globalThis.fetch): typeof fetch {
  const backgroundRequests = new Map<string, string>();
  const rigkitFetch = (async (resource, init) => {
    const requestInit: RequestInit = {
      ...init,
      headers: withRigkitHeaders(init?.headers),
    };
    const response = await fetchFn(resource, requestInit);
    await rememberBackgroundRequest(backgroundRequests, resource, requestInit, response);
    if (!response.ok) {
      await logFreestyleApiRequestFailure({
        backgroundRequests,
        resource,
        init: requestInit,
        response,
      });
    }
    return response;
  }) as typeof fetch;
  return Object.assign(rigkitFetch, {
    preconnect: fetchFn.preconnect?.bind(fetchFn) ?? (() => {}),
  }) as typeof fetch;
}

async function resolveClientAuth(input: CreateFreestyleAuthenticatedClientInput): Promise<ResolvedClientAuth> {
  const apiKey = nonEmpty(input.config?.apiKey);
  const apiUrl = nonEmpty(input.config?.apiUrl) ?? nonEmpty(process.env.FREESTYLE_API_URL);
  const fetchFn = input.fetch ?? globalThis.fetch;

  if (apiKey) {
    return {
      client: new Freestyle({
        apiKey,
        ...(apiUrl ? { baseUrl: apiUrl } : {}),
        fetch: createFreestyleSdkFetch(fetchFn),
      }),
      identityKey: apiKeyIdentityKey({ apiUrl, apiKey }),
    };
  }

  const stack = resolveStackAuthConfig(input.config);
  const stackStateKey = stackAuthStateKey(stack);
  const stored = readStackAuthState(input.hostStorage.get(stackStateKey)?.value);
  const refreshed = await resolveStackAccessToken({
    config: stack,
    storage: input.hostStorage,
    storageKey: stackStateKey,
    stored,
    local: input.local,
    fetch: fetchFn,
    timeoutMs: input.timeoutMs ?? DEFAULT_CLI_AUTH_TIMEOUT_MILLIS,
    pollIntervalMs: input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MILLIS,
  });
  const team = await resolveTeam({
    configuredTeamId: input.config?.teamId,
    stored: readStackAuthState(input.hostStorage.get(stackStateKey)?.value) ?? stored,
    accessToken: refreshed.accessToken,
    config: stack,
    storage: input.hostStorage,
    storageKey: stackStateKey,
    fetch: fetchFn,
    local: input.local,
  });
  const client = new Freestyle({
    stackAccessToken: refreshed.accessToken,
    teamId: team.id,
    ...(apiUrl ? { baseUrl: apiUrl } : {}),
    fetch: createFreestyleSdkFetch(fetchFn),
  });

  return {
    client,
    identityKey: browserIdentityKey({
      apiUrl,
      dashboardUrl: stack.dashboardUrl,
      profile: stack.profile,
      teamId: team.id,
    }),
    team,
  };
}

function resolveStackAuthConfig(auth: FreestyleProviderConfig | undefined): StackAuthConfig {
  const dashboardUrl = trimTrailingSlash(
    nonEmpty(auth?.dashboardUrl) ??
      nonEmpty(process.env.FREESTYLE_DASHBOARD_URL) ??
      DEFAULT_STACK_APP_URL,
  );
  return {
    stackApiUrl: trimTrailingSlash(
      nonEmpty(process.env.FREESTYLE_STACK_API_URL) ??
        DEFAULT_STACK_API_URL,
    ),
    appUrl: trimTrailingSlash(
      nonEmpty(process.env.FREESTYLE_STACK_APP_URL) ??
        dashboardUrl,
    ),
    dashboardUrl,
    projectId:
      nonEmpty(process.env.FREESTYLE_STACK_PROJECT_ID) ??
        nonEmpty(process.env.NEXT_PUBLIC_STACK_PROJECT_ID) ??
        nonEmpty(process.env.VITE_STACK_PROJECT_ID) ??
        DEFAULT_STACK_PROJECT_ID,
    publishableClientKey:
      nonEmpty(process.env.FREESTYLE_STACK_PUBLISHABLE_CLIENT_KEY) ??
        nonEmpty(process.env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY) ??
        nonEmpty(process.env.VITE_STACK_PUBLISHABLE_CLIENT_KEY) ??
        DEFAULT_STACK_PUBLISHABLE_CLIENT_KEY,
    profile: nonEmpty(auth?.profile) ?? "default",
  };
}

function withRigkitHeaders(headers: HeadersInit | undefined): Headers {
  const next = new Headers(headers);
  next.set(RIGKIT_HEADER, "true");
  next.set(RIGKIT_VERSION_HEADER, RIGKIT_PROVIDER_FREESTYLE_VERSION);
  return next;
}

async function rememberBackgroundRequest(
  backgroundRequests: Map<string, string>,
  resource: Parameters<typeof fetch>[0],
  init: RequestInit,
  response: Response,
): Promise<void> {
  if (response.status !== 202) return;
  const requestId = await responseBackgroundRequestId(response);
  if (!requestId) return;
  backgroundRequests.set(requestId, formatReplayableFetchRequest(resource, init));
}

async function logFreestyleApiRequestFailure(input: {
  backgroundRequests: Map<string, string>;
  resource: Parameters<typeof fetch>[0];
  init: RequestInit;
  response: Response;
  responseText?: string;
}): Promise<void> {
  const requestId = backgroundRequestIdFromResource(input.resource);
  const replayRequest = requestId ? input.backgroundRequests.get(requestId) : undefined;
  const responseSummary = await formatResponseSummary(input.response, input.responseText);
  const heading = requestId
    ? `Freestyle background request ${requestId} failed. Original API request:`
    : "Freestyle API request failed. Replay request:";
  const request = replayRequest ?? formatReplayableFetchRequest(input.resource, input.init);
  console.error(`${heading}\n${request}\n${responseSummary}`);
}

async function responseBackgroundRequestId(response: Response): Promise<string | undefined> {
  const header = response.headers.get("x-freestyle-background-request-id");
  if (header) return header;
  const data = await response.clone().json().catch(() => undefined);
  return backgroundRequestId(data);
}

function backgroundRequestIdFromResource(resource: Parameters<typeof fetch>[0]): string | undefined {
  const path = resourceUrl(resource).pathname;
  const match = path.match(/\/v5\/background-requests\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

async function formatResponseSummary(response: Response, responseText?: string): Promise<string> {
  const text = responseText ?? await response.clone().text().catch(() => "");
  const status = [response.status, response.statusText].filter(Boolean).join(" ");
  const traceId = responseTraceId(response);
  const redactedBody = formatRedactedResponseBody(text);
  return [
    `Response: ${status}`,
    ...(traceId ? [`TraceId: ${traceId}`] : []),
    ...(redactedBody ? [`Response body: ${redactedBody}`] : []),
  ].join("\n");
}

function responseTraceId(response: Response): string | undefined {
  return nonEmpty(response.headers.get(FREESTYLE_TRACE_ID_HEADER) ?? undefined);
}

function formatRedactedResponseBody(text: string): string | undefined {
  if (!text) return undefined;
  try {
    return JSON.stringify(redactSensitiveFields(JSON.parse(text)));
  } catch {
    return text;
  }
}

function formatReplayableFetchRequest(resource: Parameters<typeof fetch>[0], init: RequestInit): string {
  const lines = [
    `await fetch(${JSON.stringify(resourceUrl(resource).href)}, {`,
    `  method: ${JSON.stringify(resolveRequestMethod(resource, init))},`,
  ];
  const headers = replayableHeaders(resource, init);
  if (Object.keys(headers).length > 0) {
    lines.push(`  headers: ${indentContinuation(JSON.stringify(headers, null, 2), 2)},`);
  }
  const body = replayableBody(init.body);
  if (body) {
    lines.push(`  body: ${indentContinuation(body, 2)},`);
  }
  lines.push("});");
  return lines.join("\n");
}

function replayableHeaders(resource: Parameters<typeof fetch>[0], init: RequestInit): Record<string, string> {
  const headers = resource instanceof Request ? new Headers(resource.headers) : new Headers();
  new Headers(init.headers).forEach((value, key) => {
    headers.set(key, value);
  });
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[displayHeaderName(key)] = redactHeaderValue(key, value);
  });
  return result;
}

function resolveRequestMethod(resource: Parameters<typeof fetch>[0], init?: RequestInit): string {
  return init?.method ?? (resource instanceof Request ? resource.method : "GET");
}

function replayableBody(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown;
      return `JSON.stringify(${JSON.stringify(redactSensitiveFields(parsed), null, 2)})`;
    } catch {
      return JSON.stringify(body);
    }
  }
  if (body instanceof URLSearchParams) {
    return `new URLSearchParams(${JSON.stringify(body.toString())})`;
  }
  return JSON.stringify(String(body));
}

function indentContinuation(value: string, spaces: number): string {
  const lines = value.split("\n");
  const indent = " ".repeat(spaces);
  return [lines[0], ...lines.slice(1).map((line) => `${indent}${line}`)].join("\n");
}

function displayHeaderName(name: string): string {
  const normalized = name.toLowerCase();
  return {
    authorization: "Authorization",
    "content-type": "Content-Type",
    "user-agent": "User-Agent",
    "x-freestyle-identity-access-token": "X-Freestyle-Identity-Access-Token",
    [RIGKIT_HEADER]: RIGKIT_HEADER,
    [RIGKIT_VERSION_HEADER]: RIGKIT_VERSION_HEADER,
  }[normalized] ?? name;
}

function redactHeaderValue(name: string, value: string): string {
  if (name.toLowerCase() === "authorization" && /^Bearer\s+/i.test(value)) {
    return "Bearer <redacted FREESTYLE_API_KEY>";
  }
  return isSensitiveFieldName(name) ? "[redacted]" : value;
}

function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    next[key] = isSensitiveFieldName(key) ? "[redacted]" : redactSensitiveFields(field);
  }
  return next;
}

function isSensitiveFieldName(name: string): boolean {
  return /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credential|cookie/i
    .test(name);
}

async function resolveStackAccessToken(input: {
  config: StackAuthConfig;
  storage: ProviderStorage;
  storageKey: string;
  stored: StackAuthState | undefined;
  local: LocalWorkspaceRuntime;
  fetch: typeof fetch;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<StackTokenRefresh> {
  let refreshToken = input.stored?.refreshToken;
  if (!refreshToken) {
    refreshToken = await startCliLogin(input);
    saveStackAuthState(input.storage, input.storageKey, {
      refreshToken,
      defaultTeamId: input.stored?.defaultTeamId,
      defaultTeamName: input.stored?.defaultTeamName,
      updatedAt: Date.now(),
    });
  }

  let refreshed = await refreshStackAccessToken(input.config, refreshToken, input.fetch);
  if (!refreshed) {
    input.storage.delete(input.storageKey);
    refreshToken = await startCliLogin(input);
    saveStackAuthState(input.storage, input.storageKey, {
      refreshToken,
      defaultTeamId: input.stored?.defaultTeamId,
      defaultTeamName: input.stored?.defaultTeamName,
      updatedAt: Date.now(),
    });
    refreshed = await refreshStackAccessToken(input.config, refreshToken, input.fetch);
  }

  if (!refreshed) {
    throw new Error("Failed to authenticate with Freestyle.");
  }

  const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
  saveStackAuthState(input.storage, input.storageKey, {
    refreshToken: nextRefreshToken,
    defaultTeamId: input.stored?.defaultTeamId,
    defaultTeamName: input.stored?.defaultTeamName,
    accessToken: refreshed.accessToken,
    accessTokenUpdatedAt: Date.now(),
    updatedAt: Date.now(),
  });
  return refreshed;
}

async function startCliLogin(input: {
  config: StackAuthConfig;
  local: LocalWorkspaceRuntime;
  fetch: typeof fetch;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<string> {
  const initResponse = await input.fetch(`${input.config.stackApiUrl}/api/v1/auth/cli`, {
    method: "POST",
    headers: stackClientHeaders(input.config),
    body: JSON.stringify({
      expires_in_millis: input.timeoutMs,
    }),
  });
  if (!initResponse.ok) {
    const errorText = await initResponse.text();
    throw new Error(
      `Failed to start Freestyle authentication (${initResponse.status}). ${errorText || "Check Stack Auth configuration."}`,
    );
  }

  const initData = await initResponse.json() as Record<string, unknown>;
  const pollingCode = stringField(initData, "polling_code");
  const loginCode = stringField(initData, "login_code");
  const loginUrl = `${input.config.appUrl}/handler/cli-auth-confirm?login_code=${encodeURIComponent(loginCode)}`;

  console.log(`Freestyle authentication required. Opening ${loginUrl}`);
  try {
    await input.local.open(loginUrl);
  } catch {
    console.log(`Open this URL to authenticate with Freestyle:\n${loginUrl}`);
  }

  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const pollResponse = await input.fetch(`${input.config.stackApiUrl}/api/v1/auth/cli/poll`, {
      method: "POST",
      headers: stackClientHeaders(input.config),
      body: JSON.stringify({
        polling_code: pollingCode,
      }),
    });
    if (![200, 201].includes(pollResponse.status)) {
      throw new Error(`Failed while polling Freestyle authentication (${pollResponse.status}).`);
    }

    const pollData = await pollResponse.json() as Record<string, unknown>;
    const status = typeof pollData.status === "string" ? pollData.status : "pending";
    if (status === "completed" || status === "success") {
      return stringField(pollData, "refresh_token");
    }
    if (status !== "pending" && status !== "waiting") {
      throw new Error(
        typeof pollData.error === "string"
          ? pollData.error
          : `Freestyle authentication ${status}. Please retry.`,
      );
    }

    await sleep(input.pollIntervalMs);
  }

  throw new Error("Timed out waiting for Freestyle authentication.");
}

async function refreshStackAccessToken(
  config: StackAuthConfig,
  refreshToken: string,
  fetchFn: typeof fetch,
): Promise<StackTokenRefresh | null> {
  const response = await fetchFn(`${config.stackApiUrl}/api/v1/auth/sessions/current/refresh`, {
    method: "POST",
    headers: {
      ...stackClientHeaders(config),
      "x-stack-refresh-token": refreshToken,
    },
    body: "{}",
  });
  if (!response.ok) return null;
  const data = await response.json() as Record<string, unknown>;
  const accessToken = typeof data.access_token === "string" ? data.access_token : undefined;
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
  };
}

async function resolveTeam(input: {
  configuredTeamId: string | undefined;
  stored: StackAuthState | undefined;
  accessToken: string;
  config: StackAuthConfig;
  storage: ProviderStorage;
  storageKey: string;
  fetch: typeof fetch;
  local: LocalWorkspaceRuntime;
}): Promise<FreestyleResolvedTeam> {
  const configuredTeamId =
    nonEmpty(input.configuredTeamId) ?? nonEmpty(process.env.FREESTYLE_TEAM_ID);
  if (configuredTeamId) {
    const storedTeamName = configuredTeamId === input.stored?.defaultTeamId
      ? input.stored?.defaultTeamName
      : undefined;
    saveStackAuthState(input.storage, input.storageKey, {
      ...input.stored,
      refreshToken: input.stored?.refreshToken ?? "",
      defaultTeamId: configuredTeamId,
      defaultTeamName: storedTeamName,
      updatedAt: Date.now(),
    });
    return {
      id: configuredTeamId,
      ...(storedTeamName ? { displayName: storedTeamName } : {}),
    };
  }

  // A stored team is only a cached choice: validate it against the account's
  // current teams so state saved before a platform migration cannot pin a
  // team the gateway no longer accepts.
  const teams = await listTeams(input.config, input.accessToken, input.fetch);
  const storedTeamId = nonEmpty(input.stored?.defaultTeamId);
  const storedTeam = teams.find((team) => team.id === storedTeamId);
  if (storedTeam) {
    saveStackAuthState(input.storage, input.storageKey, {
      ...input.stored,
      refreshToken: input.stored?.refreshToken ?? "",
      defaultTeamId: storedTeam.id,
      defaultTeamName: nonEmpty(storedTeam.displayName),
      updatedAt: Date.now(),
    });
    return freestyleResolvedTeam(storedTeam);
  }
  if (storedTeamId) {
    console.log(
      `Stored Freestyle team ${storedTeamId} is no longer available for this account; choosing again.`,
    );
  }

  if (teams.length === 1) {
    const onlyTeam = teams[0]!;
    saveStackAuthState(input.storage, input.storageKey, {
      ...input.stored,
      refreshToken: input.stored?.refreshToken ?? "",
      defaultTeamId: onlyTeam.id,
      defaultTeamName: nonEmpty(onlyTeam.displayName),
      updatedAt: Date.now(),
    });
    return freestyleResolvedTeam(onlyTeam);
  }

  if (teams.length === 0) {
    throw new Error("Freestyle authentication succeeded, but no teams were available for this account.");
  }

  const selectedTeamId = await selectFreestyleTeam(input.local, teams);
  const selectedTeam = teams.find((team) => team.id === selectedTeamId);
  if (!selectedTeam) {
    throw new Error(`Freestyle team selection returned unknown team ${selectedTeamId}.`);
  }
  saveStackAuthState(input.storage, input.storageKey, {
    ...input.stored,
    refreshToken: input.stored?.refreshToken ?? "",
    defaultTeamId: selectedTeam.id,
    defaultTeamName: nonEmpty(selectedTeam.displayName),
    updatedAt: Date.now(),
  });
  return freestyleResolvedTeam(selectedTeam);
}

async function selectFreestyleTeam(
  local: LocalWorkspaceRuntime,
  teams: FreestyleTeam[],
): Promise<string> {
  if (!local.prompt?.select) {
    const choices = teams.map((team) => `${team.displayName ?? team.id} (${team.id})`).join(", ");
    throw new Error(
      `Freestyle authentication found multiple teams. Set freestyle.provider({ teamId }) or FREESTYLE_TEAM_ID. Teams: ${choices}`,
    );
  }
  return await local.prompt.select({
    message: "Choose Freestyle team",
    options: teams.map((team) => ({
      value: team.id,
      label: team.displayName ? `${team.displayName} (${team.id})` : team.id,
      description: team.sandboxAccountId ? `sandbox ${team.sandboxAccountId}` : undefined,
    })),
  });
}

function freestyleResolvedTeam(team: FreestyleTeam): FreestyleResolvedTeam {
  const displayName = nonEmpty(team.displayName);
  return {
    id: team.id,
    ...(displayName ? { displayName } : {}),
  };
}

function formatFreestyleTeam(team: FreestyleResolvedTeam): string {
  return team.displayName ? `${team.displayName} (${team.id})` : team.id;
}

function providerIdentityFingerprint(
  identityKey: string,
  identity: { identityId: string } | undefined,
): string {
  if (identity) return `identity:${identity.identityId}`;
  return `${identityKey}:missing-identity`;
}

async function listTeams(config: StackAuthConfig, accessToken: string, fetchFn: typeof fetch): Promise<FreestyleTeam[]> {
  const response = await fetchFn(`${config.dashboardUrl}/api/cli/teams`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to list Freestyle teams (${response.status}). ${await response.text()}`);
  }
  const data = await response.json() as unknown;
  const teams = isRecord(data) && Array.isArray(data.teams) ? data.teams : undefined;
  if (!teams) {
    throw new Error("Freestyle team list response was invalid.");
  }
  return teams.filter(isDashboardTeam).map((team) => ({
    id: team.teamId,
    displayName: team.name,
    sandboxAccountId: typeof team.accountId === "string" ? team.accountId : undefined,
  }));
}

type DashboardTeam = {
  teamId: string;
  name?: string;
  accountId?: string | null;
};

function stackClientHeaders(config: StackAuthConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-stack-project-id": config.projectId,
    "x-stack-access-type": "client",
    "x-stack-publishable-client-key": config.publishableClientKey,
  };
}

function stackAuthStateKey(config: StackAuthConfig): string {
  return `stack-auth:${fingerprint({
    stackApiUrl: config.stackApiUrl,
    appUrl: config.appUrl,
    projectId: config.projectId,
    profile: config.profile,
  })}`;
}

function apiKeyIdentityKey(input: { apiUrl: string | undefined; apiKey: string }): string {
  return `api-key:${fingerprint({ apiUrl: input.apiUrl ?? "default", apiKey: input.apiKey })}`;
}

function browserIdentityKey(input: {
  apiUrl: string | undefined;
  dashboardUrl: string;
  profile: string;
  teamId: string;
}): string {
  return `browser:${fingerprint({
    apiUrl: input.apiUrl ?? "default",
    dashboardUrl: input.dashboardUrl,
    profile: input.profile,
    teamId: input.teamId,
  })}`;
}

function readStackAuthState(value: JsonValue | undefined): StackAuthState | undefined {
  if (!isRecord(value)) return undefined;
  const refreshToken = typeof value.refreshToken === "string" ? value.refreshToken : undefined;
  if (!refreshToken) return undefined;
  return {
    refreshToken,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    defaultTeamId: typeof value.defaultTeamId === "string" ? value.defaultTeamId : undefined,
    defaultTeamName: typeof value.defaultTeamName === "string" ? value.defaultTeamName : undefined,
    accessToken: typeof value.accessToken === "string" ? value.accessToken : undefined,
    accessTokenUpdatedAt: typeof value.accessTokenUpdatedAt === "number" ? value.accessTokenUpdatedAt : undefined,
  };
}

function saveStackAuthState(storage: ProviderStorage, key: string, state: StackAuthState): void {
  if (!state.refreshToken) return;
  storage.set(key, {
    refreshToken: state.refreshToken,
    updatedAt: state.updatedAt,
    ...(state.defaultTeamId ? { defaultTeamId: state.defaultTeamId } : {}),
    ...(state.defaultTeamName ? { defaultTeamName: state.defaultTeamName } : {}),
    ...(state.accessToken ? { accessToken: state.accessToken } : {}),
    ...(state.accessTokenUpdatedAt ? { accessTokenUpdatedAt: state.accessTokenUpdatedAt } : {}),
  });
}

function resourceUrl(resource: Parameters<typeof fetch>[0]): URL {
  if (typeof resource === "string") return new URL(resource, DEFAULT_FREESTYLE_API_URL);
  if (resource instanceof URL) return resource;
  return new URL(resource.url);
}

function backgroundRequestId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.requestId === "string"
    ? value.requestId
    : typeof value.request_id === "string"
      ? value.request_id
      : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Freestyle authentication response did not include ${key}.`);
  }
  return value;
}

function isDashboardTeam(value: unknown): value is DashboardTeam {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { teamId?: unknown }).teamId === "string"
  );
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
