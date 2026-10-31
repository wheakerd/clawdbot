// OpenClaw ID sign-in for the Control UI's account menu: an OpenID Connect
// authorization code flow with PKCE for a public client. The browser opens the
// authorization URL in a popup and hands the returned code back; the Gateway
// holds the verifier and redeems the code, because the issuer serves no CORS.
// The ID token goes back to the browser, which keeps the account; the Gateway
// stores nothing beyond the short-lived pending sign-ins.
import { createHash, randomBytes } from "node:crypto";

/** The signed-in account the Control UI shows. */
export type OpenClawIdAccount = {
  sub: string;
  email: string | null;
  name: string | null;
  /** ID token expiry, seconds since the epoch. */
  exp: number;
};

/** A refusal with a stable code, mapped to an RPC error by the method handler. */
export type OpenClawIdSignInRefusal = { ok: false; code: string; detail: string };

type IssuerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
};

type PendingSignIn = {
  issuerUrl: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
  nonce: string;
  createdAt: number;
};

type IdTokenClaims = {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  nonce?: unknown;
  email?: unknown;
  name?: unknown;
};

/** Where the Control UI receives the issuer's redirect (registered per client). */
export const OPENCLAW_ID_CALLBACK_PATH = "/openclaw-id/callback";

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 16;

function refusal(code: string, detail: string): OpenClawIdSignInRefusal {
  return { ok: false, code, detail };
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// Accepts only a Control UI callback URL: http(s), the fixed path, no query or fragment.
function isCallbackUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname.endsWith(OPENCLAW_ID_CALLBACK_PATH) &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

// Decodes a JWT payload. The token arrives straight from the issuer's token
// endpoint over TLS, which OIDC Core 3.1.3.7 accepts in place of a signature check.
function decodeClaims(idToken: string): IdTokenClaims | null {
  const payload = idToken.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return claims && typeof claims === "object" ? (claims as IdTokenClaims) : null;
  } catch {
    return null;
  }
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

// Checks the claims the browser relies on: issuer, audience, nonce, expiry and subject.
function acceptedClaims(
  claims: IdTokenClaims | null,
  expected: { issuer: string; clientId: string; nonce: string; nowMs: number },
): claims is IdTokenClaims & { sub: string; exp: number } {
  if (!claims) {
    return false;
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return (
    typeof claims.iss === "string" &&
    trimSlash(claims.iss) === trimSlash(expected.issuer) &&
    audiences.includes(expected.clientId) &&
    claims.nonce === expected.nonce &&
    typeof claims.exp === "number" &&
    claims.exp * 1000 > expected.nowMs &&
    typeof claims.sub === "string" &&
    claims.sub.length > 0
  );
}

/**
 * Creates the sign-in flow for one Gateway. `begin` returns the authorization
 * URL for the popup; `complete` redeems the returned code once; `enrollmentCode`
 * asks Discovery for a link code with the signed-in account's ID token.
 */
export function createOpenClawIdSignIn(
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const pending = new Map<string, PendingSignIn>();

  // Drops expired sign-ins, then the oldest ones past the cap (Map keeps insertion order).
  const prune = () => {
    for (const [state, entry] of pending) {
      if (now() - entry.createdAt > PENDING_TTL_MS || pending.size >= MAX_PENDING) {
        pending.delete(state);
      }
    }
  };

  // Reads the issuer's discovery document and checks it names this issuer and
  // keeps its token endpoint on the issuer's origin.
  const metadata = async (issuerUrl: string): Promise<IssuerMetadata | OpenClawIdSignInRefusal> => {
    const response = await fetchImpl(`${trimSlash(issuerUrl)}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return refusal("issuer_unavailable", `issuer discovery failed with HTTP ${response.status}`);
    }
    const meta = (await response.json()) as Partial<IssuerMetadata>;
    if (
      typeof meta.issuer !== "string" ||
      trimSlash(meta.issuer) !== trimSlash(issuerUrl) ||
      typeof meta.authorization_endpoint !== "string" ||
      typeof meta.token_endpoint !== "string" ||
      new URL(meta.token_endpoint).origin !== new URL(issuerUrl).origin
    ) {
      return refusal("issuer_invalid", "issuer metadata does not match the configured issuer");
    }
    return meta as IssuerMetadata;
  };

  return {
    /** Starts a sign-in and returns the issuer URL the browser opens in a popup. */
    async begin(params: {
      issuerUrl: string;
      clientId: string;
      redirectUri: unknown;
    }): Promise<{ authorizationUrl: string; state: string } | OpenClawIdSignInRefusal> {
      if (!isCallbackUrl(params.redirectUri)) {
        return refusal("malformed", `redirectUri must end with ${OPENCLAW_ID_CALLBACK_PATH}`);
      }
      const meta = await metadata(params.issuerUrl);
      if ("ok" in meta) {
        return meta;
      }
      const verifier = base64url(randomBytes(32));
      const state = base64url(randomBytes(16));
      const nonce = base64url(randomBytes(16));
      prune();
      pending.set(state, {
        issuerUrl: params.issuerUrl,
        clientId: params.clientId,
        redirectUri: params.redirectUri,
        verifier,
        nonce,
        createdAt: now(),
      });
      const url = new URL(meta.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
        scope: "openid profile email",
        state,
        nonce,
        code_challenge: base64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      }).toString();
      return { authorizationUrl: url.href, state };
    },

    /** Redeems the code for a pending sign-in (once) and returns the account and ID token. */
    async complete(params: {
      state: unknown;
      code: unknown;
    }): Promise<{ account: OpenClawIdAccount; idToken: string } | OpenClawIdSignInRefusal> {
      const entry = typeof params.state === "string" ? pending.get(params.state) : undefined;
      if (typeof params.state === "string") {
        pending.delete(params.state);
      }
      if (
        !entry ||
        now() - entry.createdAt > PENDING_TTL_MS ||
        typeof params.code !== "string" ||
        !params.code
      ) {
        return refusal("state_mismatch", "sign-in expired or was already used; start again");
      }
      const meta = await metadata(entry.issuerUrl);
      if ("ok" in meta) {
        return meta;
      }
      const response = await fetchImpl(meta.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: params.code,
          redirect_uri: entry.redirectUri,
          client_id: entry.clientId,
          code_verifier: entry.verifier,
        }),
      });
      if (!response.ok) {
        return refusal(
          "token_exchange_failed",
          `token exchange failed with HTTP ${response.status}`,
        );
      }
      const tokens = (await response.json()) as { id_token?: unknown };
      const idToken = typeof tokens.id_token === "string" ? tokens.id_token : "";
      const claims = decodeClaims(idToken);
      const expected = {
        issuer: meta.issuer,
        clientId: entry.clientId,
        nonce: entry.nonce,
        nowMs: now(),
      };
      if (!acceptedClaims(claims, expected)) {
        return refusal("id_token_invalid", "the issuer returned an unusable ID token");
      }
      return {
        idToken,
        account: {
          sub: claims.sub,
          email: optionalText(claims.email),
          name: optionalText(claims.name),
          exp: claims.exp,
        },
      };
    },

    /** Asks Discovery for a one-time link code for the signed-in account. */
    async enrollmentCode(params: {
      discoveryUrl: string;
      idToken: unknown;
    }): Promise<{ code: string; expiresAt: number } | OpenClawIdSignInRefusal> {
      if (typeof params.idToken !== "string" || !params.idToken) {
        return refusal("malformed", "idToken is required");
      }
      const response = await fetchImpl(new URL("/v1/enrollment-codes", params.discoveryUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${params.idToken}`, accept: "application/json" },
      });
      if (response.status === 401) {
        return refusal("signed_out", "your OpenClaw ID sign-in expired; sign in again");
      }
      if (!response.ok) {
        return refusal("unavailable", `Discovery refused a link code (HTTP ${response.status})`);
      }
      const body = (await response.json()) as { code?: unknown; expires_at?: unknown };
      if (typeof body.code !== "string" || typeof body.expires_at !== "number") {
        return refusal("unavailable", "Discovery returned no link code");
      }
      return { code: body.code, expiresAt: body.expires_at };
    },
  };
}

export type OpenClawIdSignIn = ReturnType<typeof createOpenClawIdSignIn>;
