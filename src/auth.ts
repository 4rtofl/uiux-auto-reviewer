// How the Claude API client authenticates: Workload Identity Federation when a federation rule is configured, else an
// API key, else whatever the SDK finds on its own (an `ant auth login` profile when run locally).
import type { ClientOptions } from "@anthropic-ai/sdk";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";

export const AUDIENCE = "https://api.anthropic.com";

type Env = Record<string, string | undefined>;

export interface Federation {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId?: string;
  workspaceId?: string;
}

export type ClaudeAuth =
  | { kind: "federation"; federation: Federation }
  | { kind: "api-key"; apiKey: string }
  | { kind: "sdk-default" };

export function resolveAuth(env: Env): ClaudeAuth {
  const federationRuleId = env.ANTHROPIC_FEDERATION_RULE_ID;
  if (federationRuleId) {
    const organizationId = env.ANTHROPIC_ORGANIZATION_ID;
    if (!organizationId) throw new Error("ANTHROPIC_FEDERATION_RULE_ID is set but ANTHROPIC_ORGANIZATION_ID is not");
    return {
      kind: "federation",
      federation: {
        federationRuleId,
        organizationId,
        ...(env.ANTHROPIC_SERVICE_ACCOUNT_ID ? { serviceAccountId: env.ANTHROPIC_SERVICE_ACCOUNT_ID } : {}),
        ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
    };
  }
  if (env.ANTHROPIC_API_KEY) return { kind: "api-key", apiKey: env.ANTHROPIC_API_KEY };
  return { kind: "sdk-default" };
}

// GitHub's OIDC tokens live about 5 minutes and Anthropic accepts each one once, so a fresh one is fetched for every
// exchange rather than read from a file. The request URL and token are there only in a job with `id-token: write`.
export function githubIdentityToken(env: Env, fetchImpl: typeof fetch = fetch): () => Promise<string> {
  return async () => {
    const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken) {
      throw new Error("no GitHub OIDC token: the job needs `permissions: id-token: write` (Workload Identity Federation)");
    }
    const url = new URL(requestUrl);
    url.searchParams.set("audience", AUDIENCE);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${requestToken}` } });
    if (!response.ok) throw new Error(`GitHub OIDC token request failed: ${response.status} ${response.statusText}`);
    const body = (await response.json()) as { value?: unknown };
    if (typeof body.value !== "string" || body.value === "") throw new Error("GitHub OIDC token response has no value");
    return body.value;
  };
}

export function clientOptions(auth: ClaudeAuth, env: Env): ClientOptions {
  switch (auth.kind) {
    case "federation":
      // With credentials passed, the SDK reads neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN, so a leftover key
      // cannot take over. The client caches the access token and exchanges again before it expires.
      return {
        credentials: oidcFederationProvider({
          ...auth.federation,
          identityTokenProvider: githubIdentityToken(env),
          baseURL: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
          fetch,
        }),
      };
    case "api-key":
      return { apiKey: auth.apiKey };
    case "sdk-default":
      return {};
  }
}

export function describeAuth(auth: ClaudeAuth): string {
  switch (auth.kind) {
    case "federation":
      return `Workload Identity Federation (${auth.federation.federationRuleId})`;
    case "api-key":
      return "API key";
    case "sdk-default":
      return "SDK default credentials";
  }
}
