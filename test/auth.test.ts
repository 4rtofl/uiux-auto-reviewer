import assert from "node:assert/strict";
import { test } from "node:test";
import { AUDIENCE, githubIdentityToken, resolveAuth } from "../src/auth.ts";

test("resolveAuth prefers the federation rule over an API key", () => {
  const auth = resolveAuth({
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_1",
    ANTHROPIC_ORGANIZATION_ID: "org",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_1",
    ANTHROPIC_WORKSPACE_ID: "",
    ANTHROPIC_API_KEY: "sk-ant-api03-x",
  });
  assert.deepEqual(auth, {
    kind: "federation",
    federation: { federationRuleId: "fdrl_1", organizationId: "org", serviceAccountId: "svac_1" },
  });
});

test("resolveAuth falls back to the API key, then to the SDK's own lookup", () => {
  assert.deepEqual(resolveAuth({ ANTHROPIC_API_KEY: "k", ANTHROPIC_FEDERATION_RULE_ID: "" }), { kind: "api-key", apiKey: "k" });
  assert.deepEqual(resolveAuth({}), { kind: "sdk-default" });
});

test("resolveAuth needs the organization with a federation rule", () => {
  assert.throws(() => resolveAuth({ ANTHROPIC_FEDERATION_RULE_ID: "fdrl_1" }), /ANTHROPIC_ORGANIZATION_ID/);
});

test("githubIdentityToken asks for the Anthropic audience on every call", async () => {
  const urls: string[] = [];
  let count = 0;
  const fakeFetch = (async (url: URL, init?: RequestInit) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer request-token");
    count += 1;
    return Response.json({ value: `jwt-${count}` });
  }) as typeof fetch;
  const provider = githubIdentityToken(
    { ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/token?api-version=2.0", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token" },
    fakeFetch,
  );
  assert.equal(await provider(), "jwt-1");
  assert.equal(await provider(), "jwt-2");
  const url = new URL(urls[0]!);
  assert.equal(url.searchParams.get("audience"), AUDIENCE);
  assert.equal(url.searchParams.get("api-version"), "2.0");
});

test("githubIdentityToken explains a job without id-token: write", async () => {
  await assert.rejects(githubIdentityToken({})(), /id-token: write/);
});
