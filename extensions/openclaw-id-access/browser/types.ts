// Response shapes of the Gateway's openclawId.* methods that the members page reads.
import type { MemberRole } from "@openclaw/openclaw-id-protocol";

/** An active owner device as `openclawId.status` lists it. */
export type OwnerDevice = { devicePub: string; label: string; peerKeys: string[]; cert: unknown };

/** One member of the claw. */
export type Member = { accountId: string; role: string; peerKeys: string[]; email?: string | null };

/** One invite as the Gateway lists it to owners. */
export type Invite = {
  inviteId: string;
  label: string;
  role: MemberRole;
  audience: { kind: "account_id" | "email"; value: string };
  createdAt: number;
  expiresAt: number;
  status: "open" | "pending" | "approved" | "denied" | "expired";
  pending?: {
    accountId: string;
    devicePub: string;
    peerKey: string;
    requestedAt: number;
    decideBy: number;
    /** Reported by OpenClaw ID; display only. */
    reported: { email: string | null; displayName: string | null; locationHint: string | null };
  };
};

/** The claw's link state (`openclawId.status` result `link`). */
export type Link = {
  linked: boolean;
  clawId?: string;
  hostname?: string;
  rootPub?: string;
  rootEpoch?: number;
  seq?: number;
  ownerDevices?: OwnerDevice[];
  members?: Member[];
  invites?: Invite[];
  publication?:
    | { state: "published"; ownerAccountId: string | null; snapshotSeq: number }
    | { state: "needs_enrollment_code" }
    | { state: "failed"; code: string; message: string };
};

/** The `openclawId.status` result. */
export type StatusResult = {
  status: { state: "off" | "unconfigured" | "on" | "failed" };
  link: Link;
  channel: "local_operator" | "tunnel" | null;
};
