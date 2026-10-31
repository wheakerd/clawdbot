// Response shapes of the OpenClaw ID Gateway methods (openclawId.*) the Control UI reads.
import type { OpenClawIdLinkPreparation } from "./link.ts";

export type OpenClawIdPublication =
  | { state: "published"; ownerAccountId: string | null; snapshotSeq: number }
  | { state: "needs_enrollment_code" }
  | { state: "failed"; code: string; message: string };

/** The parts of `openclawId.status` the account menu needs. */
export type OpenClawIdStatusResult = {
  status: { state: "off" | "unconfigured" | "on" | "failed" };
  link: { linked: boolean; clawId?: string; hostname?: string };
  /** How this browser reaches the Gateway: only `local_operator` may link or sign in. */
  channel: "local_operator" | "tunnel" | null;
  services: {
    issuerUrl: string | null;
    discoveryUrl: string | null;
    loaderDomain: string | null;
    /** The Control UI's sign-in client; absent means sign-in is not configured. */
    clientId?: string | null;
  };
};

/** The signed-in OpenClaw ID account the Control UI holds (`openclawId.authority` account_complete). */
export type OpenClawIdSignedIn = {
  sub: string;
  email: string | null;
  name: string | null;
  /** ID token expiry, seconds since the epoch. */
  exp: number;
  idToken: string;
};

export type { OpenClawIdLinkPreparation };
