// Owner devices for the account menu's "Your devices" (OCF-280): which listed
// device is this browser, which devices a device approved, and the signed
// Revocation that removes one. Revoking a device also ends every device it
// approved, because an owner device is active only while every certificate in
// its chain is unrevoked (protocol isOwnerDeviceActive; decision pending Josh).
import {
  certificateChain,
  fingerprint,
  formatEd25519PublicKey,
  signStatement,
  type Ed25519PublicKey,
  type SignedStatement,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import { loadOwnerDeviceSigner } from "./device-key.ts";
import type { OpenClawIdOwnerDevice, OpenClawIdStatusResult } from "./types.ts";

/** Raised when this browser holds no active owner device key for the claw. */
export class NotAnOwnerDeviceError extends Error {
  constructor() {
    super("This browser is not an owner device for this claw.");
  }
}

/** The listed owner device this browser signs as, or undefined. */
export async function thisOwnerDevice(
  link: OpenClawIdStatusResult["link"],
): Promise<OpenClawIdOwnerDevice | undefined> {
  const signer = link.clawId ? await loadOwnerDeviceSigner(link.clawId) : undefined;
  const devicePub = signer ? formatEd25519PublicKey(signer.publicKey) : undefined;
  return link.ownerDevices?.find((device) => device.devicePub === devicePub);
}

/**
 * The other listed devices that lose access with `device`: those whose
 * certificate `device` signed, directly or further up their chain.
 */
export function devicesApprovedBy(
  devices: readonly OpenClawIdOwnerDevice[],
  device: OpenClawIdOwnerDevice,
): OpenClawIdOwnerDevice[] {
  return devices.filter(
    (other) =>
      other.devicePub !== device.devicePub &&
      (other.cert.signer === device.devicePub ||
        other.cert.chain.some((link) => link.signer === device.devicePub)),
  );
}

/**
 * Signs a Revocation of `target` as this browser's owner device, chained to
 * the owner key by its own certificate. The Gateway applies it and cuts the
 * revoked devices' connections.
 */
export async function signOwnerDeviceRevocation(
  link: OpenClawIdStatusResult["link"],
  target: OpenClawIdOwnerDevice,
): Promise<SignedStatement<"Revocation">> {
  const signer = link.clawId ? await loadOwnerDeviceSigner(link.clawId) : undefined;
  const ownPub = signer ? formatEd25519PublicKey(signer.publicKey) : undefined;
  const own = link.ownerDevices?.find((device) => device.devicePub === ownPub);
  if (!signer || !own) {
    throw new NotAnOwnerDeviceError();
  }
  return signStatement(
    "Revocation",
    {
      target_fp: await fingerprint(target.devicePub as Ed25519PublicKey),
      target_kind: "owner_device",
      reason: "revoked from the Control UI",
      root_epoch: link.rootEpoch ?? 1,
      issued_at: Math.floor(Date.now() / 1000),
    },
    signer,
    certificateChain(own.cert),
  );
}
