/* @vitest-environment jsdom */

import type * as UI from "openclaw/plugin-sdk/control-ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatusResult } from "./types.js";

// Signing needs this browser's owner key from IndexedDB; the tests stand in for it.
vi.mock("./owner-signing.js", () => ({
  thisOwnerDevice: vi.fn(async (link: { ownerDevices?: Array<{ devicePub: string }> }) =>
    link.ownerDevices?.find((device) => device.devicePub === "ed25519:mine"),
  ),
  signMembershipChange: vi.fn(async (_link: unknown, target: unknown) => ({ signed: target })),
  signAsOwner: vi.fn(async () => ({ signed: "cap" })),
  signOwnerDeviceRevocation: vi.fn(async (_link: unknown, device: { devicePub: string }) => ({
    revoked: device.devicePub,
  })),
}));

const { default: plugin } = await import("./index.js");

const pendingInvite = {
  inviteId: "inv-1",
  label: "member@example.test",
  role: "operator",
  audience: { kind: "email", value: "member@example.test" },
  createdAt: 1_800_000_000,
  expiresAt: 1_800_600_000,
  status: "pending",
  pending: {
    accountId: "acct-member",
    devicePub: "ed25519:member",
    peerKey: "iroh:member",
    requestedAt: 1_800_000_100,
    decideBy: 1_800_086_400,
    reported: { email: "member@example.test", displayName: "Mia", locationHint: "Falkenstein, DE" },
  },
};

function linked(overrides: Partial<StatusResult["link"]> = {}): StatusResult {
  return {
    status: { state: "on" },
    channel: "tunnel",
    link: {
      linked: true,
      clawId: "claw-1",
      hostname: "studio-e61zr.crabd.xyz",
      rootPub: "ed25519:root",
      seq: 4,
      ownerDevices: [
        { devicePub: "ed25519:mine", label: "This browser", peerKeys: ["iroh:a"], cert: {} },
        { devicePub: "ed25519:old-laptop", label: "Old laptop", peerKeys: ["iroh:b"], cert: {} },
      ],
      members: [],
      invites: [pendingInvite as never],
      ...overrides,
    },
  };
}

// Activates the plugin, mounts its page and returns the host's request spy.
async function mountPage(statuses: StatusResult[]) {
  const request = vi.fn(async (method: string) => {
    if (method === "openclawId.status") {
      return statuses.length > 1 ? statuses.shift() : statuses[0];
    }
    return {};
  });
  const registerPage = vi.fn<(page: UI.ControlUiPage) => () => void>(() => () => {});
  const controller = new AbortController();
  const host = {
    locale: "en-US",
    signal: controller.signal,
    connection: { connected: true, canRead: true, canWrite: true, canAdmin: true },
    request,
    subscribe: () => () => {},
    ui: { registerPage },
  } as unknown as UI.ControlUiHost;
  await plugin.activate(host);
  const [page] = registerPage.mock.calls[0]!;
  expect(page).toMatchObject({ id: "members", label: "Members & invites" });
  const container = document.createElement("div");
  document.body.append(container);
  const view = page.mount(container, {
    host,
    props: {},
    signal: controller.signal,
    presented: true,
  } as UI.ControlUiViewContext);
  return { request, container, dispose: () => view?.dispose?.() };
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);

describe("Members & invites page", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("points to Labs while OpenClaw ID is off", async () => {
    const { container } = await mountPage([
      { status: { state: "off" }, channel: null, link: { linked: false } },
    ]);
    await vi.waitFor(() => expect(container.textContent).toContain("OpenClaw ID is off"));
  });

  it("approves a pending request with an owner-signed change", async () => {
    const { container, request } = await mountPage([
      linked(),
      linked({
        invites: [],
        members: [
          {
            accountId: "acct-member",
            role: "operator",
            peerKeys: ["iroh:member"],
            email: "member@example.test",
          },
        ],
      }),
    ]);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Mia wants to join as operator"),
    );
    await vi.waitFor(() => expect(button(container, "Approve")?.disabled).toBe(false));
    button(container, "Approve")!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("openclawId.authority", {
        action: "submit",
        statement: {
          signed: {
            op: "add",
            account_id: "acct-member",
            role: "operator",
            peer_keys: ["iroh:member"],
            invite_id: "inv-1",
          },
        },
      }),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("member@example.test"));
    expect(container.textContent).toContain("No one is waiting for approval.");
  });

  it("lists owner devices and revokes another one, never this browser", async () => {
    const { container, request } = await mountPage([linked()]);
    await vi.waitFor(() => expect(container.textContent).toContain("Old laptop"));
    const revokes = () =>
      [...container.querySelectorAll("button")].filter(
        (node) => node.textContent?.trim() === "Revoke",
      );
    await vi.waitFor(() => expect(revokes()).toHaveLength(1));
    await vi.waitFor(() => expect(revokes()[0]!.disabled).toBe(false));
    revokes()[0]!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("openclawId.authority", {
        action: "submit",
        statement: { revoked: "ed25519:old-laptop" },
      }),
    );
  });

  it("is read-only in a browser that is not an owner device", async () => {
    const status = linked({
      ownerDevices: [{ devicePub: "ed25519:other", label: "Other", peerKeys: [], cert: {} }],
    });
    const { container } = await mountPage([status]);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("is not an owner device for this claw"),
    );
    expect(button(container, "Approve")?.disabled).toBe(true);
  });
});
