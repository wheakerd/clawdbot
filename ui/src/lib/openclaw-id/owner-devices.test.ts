import { describe, expect, it } from "vitest";
import { devicesApprovedBy } from "./owner-devices.ts";
import type { OpenClawIdOwnerDevice } from "./types.ts";

// A device whose certificate `signer` signed, with the given chain signers.
function device(pub: string, signer: string, chainSigners: string[] = []): OpenClawIdOwnerDevice {
  return {
    devicePub: pub,
    label: pub,
    peerKeys: [],
    cert: {
      signer,
      chain: chainSigners.map((chainSigner) => ({ signer: chainSigner })),
    } as unknown as OpenClawIdOwnerDevice["cert"],
  };
}

describe("owner devices", () => {
  it("names every device a revoked device approved, directly or further down", () => {
    const local = device("ed25519:local", "ed25519:root");
    const laptop = device("ed25519:laptop", "ed25519:local", ["ed25519:root"]);
    const phone = device("ed25519:phone", "ed25519:laptop", ["ed25519:local", "ed25519:root"]);
    const kitDevice = device("ed25519:kit", "ed25519:root");
    const all = [local, laptop, phone, kitDevice];
    expect(devicesApprovedBy(all, laptop).map((d) => d.devicePub)).toEqual(["ed25519:phone"]);
    expect(devicesApprovedBy(all, local).map((d) => d.devicePub)).toEqual([
      "ed25519:laptop",
      "ed25519:phone",
    ]);
    expect(devicesApprovedBy(all, kitDevice)).toEqual([]);
  });
});
