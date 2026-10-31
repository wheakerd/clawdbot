import { describe, expect, it, vi } from "vitest";
import { createOpenClawIdSignIn } from "./account-sign-in.js";

const ISSUER = "https://issuer.example.test/api/auth";
const REDIRECT = "http://127.0.0.1:18789/openclaw-id/callback";

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "EdDSA" })}.${part(claims)}.sig`;
}

// A fake issuer and Discovery: metadata, token endpoint and enrollment codes.
function fakeServices(tokenClaims: (nonce: string) => Record<string, unknown>) {
  let nonce = "";
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/authorize`,
        token_endpoint: `${ISSUER}/oauth2/token`,
      });
    }
    if (url.endsWith("/oauth2/token")) {
      const form = new URLSearchParams(String(init?.body));
      if (!form.get("code_verifier") || form.get("code") !== "the-code") {
        return new Response("bad", { status: 400 });
      }
      return Response.json({ id_token: jwt(tokenClaims(nonce)) });
    }
    if (url === "https://discovery.example.test/v1/enrollment-codes") {
      const auth = new Headers(init?.headers).get("authorization");
      return auth === "Bearer good"
        ? Response.json({ code: "ABCDE-FGHJK", expires_at: 1_700_000_600 }, { status: 201 })
        : new Response("{}", { status: 401 });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl, setNonce: (value: string) => (nonce = value) };
}

async function begin(signIn: ReturnType<typeof createOpenClawIdSignIn>) {
  const started = await signIn.begin({ issuerUrl: ISSUER, clientId: "ui", redirectUri: REDIRECT });
  if ("ok" in started) {
    throw new Error(started.detail);
  }
  return started;
}

describe("createOpenClawIdSignIn", () => {
  const now = () => 1_700_000_000_000;
  const valid = (nonce: string) => ({
    iss: ISSUER,
    aud: "ui",
    sub: "acct-1",
    nonce,
    exp: 1_700_003_600,
    email: "owner@example.test",
    name: "Owner",
  });

  it("builds a PKCE authorization URL and redeems the code once", async () => {
    const services = fakeServices(valid);
    const signIn = createOpenClawIdSignIn({ fetchImpl: services.fetchImpl, now });
    const started = await begin(signIn);
    const url = new URL(started.authorizationUrl);
    expect(url.pathname).toBe("/api/auth/oauth2/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(started.state);
    services.setNonce(url.searchParams.get("nonce") ?? "");

    const done = await signIn.complete({ state: started.state, code: "the-code" });
    expect(done).toMatchObject({
      account: { sub: "acct-1", email: "owner@example.test", name: "Owner" },
    });
    const again = await signIn.complete({ state: started.state, code: "the-code" });
    expect(again).toMatchObject({ ok: false, code: "state_mismatch" });
  });

  it("refuses an ID token with the wrong nonce or audience", async () => {
    const services = fakeServices((nonce) => ({ ...valid(nonce), aud: "someone-else" }));
    const signIn = createOpenClawIdSignIn({ fetchImpl: services.fetchImpl, now });
    const started = await begin(signIn);
    services.setNonce(new URL(started.authorizationUrl).searchParams.get("nonce") ?? "");
    const done = await signIn.complete({ state: started.state, code: "the-code" });
    expect(done).toMatchObject({ ok: false, code: "id_token_invalid" });
  });

  it("only accepts the Control UI callback path as redirect URI", async () => {
    const signIn = createOpenClawIdSignIn({ fetchImpl: fakeServices(valid).fetchImpl, now });
    const refused = await signIn.begin({
      issuerUrl: ISSUER,
      clientId: "ui",
      redirectUri: "https://evil.example.test/steal?x=1",
    });
    expect(refused).toMatchObject({ ok: false, code: "malformed" });
  });

  it("gets a Discovery link code with the ID token", async () => {
    const signIn = createOpenClawIdSignIn({ fetchImpl: fakeServices(valid).fetchImpl, now });
    const discoveryUrl = "https://discovery.example.test";
    expect(await signIn.enrollmentCode({ discoveryUrl, idToken: "good" })).toEqual({
      code: "ABCDE-FGHJK",
      expiresAt: 1_700_000_600,
    });
    expect(await signIn.enrollmentCode({ discoveryUrl, idToken: "stale" })).toMatchObject({
      ok: false,
      code: "signed_out",
    });
  });
});
