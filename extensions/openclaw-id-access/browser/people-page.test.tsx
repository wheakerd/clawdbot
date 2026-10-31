/* @vitest-environment jsdom */

import { formatEd25519PublicKey } from "@openclaw/openclaw-id-protocol";
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
    devicePub: formatEd25519PublicKey(new Uint8Array(32).fill(7)),
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
// Activation reads the status once (the flag gate) before the page reads its own.
function hostFor(statuses: StatusResult[], submitResult: unknown = {}) {
  const request = vi.fn(async (method: string) => {
    if (method === "openclawId.status") {
      return statuses.length > 1 ? statuses.shift() : statuses[0];
    }
    return submitResult;
  });
  const registerPage = vi.fn<(page: UI.ControlUiPage) => () => void>(() => () => {});
  const controller = new AbortController();
  const host = {
    locale: "en-US",
    signal: controller.signal,
    connection: { connected: true, canRead: true, canWrite: true, canAdmin: true },
    request,
    subscribe: () => () => {},
    sessions: {
      rows: [{ key: "agent:main:trip", derivedTitle: "Trip ideas" }],
      normalizeKey: (key: string) => key,
    },
    ui: { registerPage },
  } as unknown as UI.ControlUiHost;
  return { host, request, registerPage, controller };
}

async function mountPage(statuses: StatusResult[], submitResult?: unknown) {
  const { host, request, registerPage, controller } = hostFor(
    [statuses[0]!, ...statuses],
    submitResult,
  );
  await plugin.activate(host);
  await vi.waitFor(() => expect(registerPage).toHaveBeenCalled());
  const [page] = registerPage.mock.calls[0]!;
  expect(page).toMatchObject({ id: "people", label: "People" });
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

describe("People page", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("registers no page while OpenClaw ID is off", async () => {
    const { host, request, registerPage } = hostFor([
      { status: { state: "off" }, channel: null, link: { linked: false } },
    ]);
    await plugin.activate(host);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("openclawId.status", {}));
    await Promise.resolve();
    expect(registerPage).not.toHaveBeenCalled();
  });

  it("shows who is asking, from which device, and which invite they used", async () => {
    const { container } = await mountPage([linked()]);
    await vi.waitFor(() => expect(container.textContent).toMatch(/· device [0-9A-Z]{5}-/));
    expect(container.textContent).toContain(
      "Using your invite for member@example.test · Operator · created",
    );
    // Owner devices live in the account menu, not on People.
    expect(container.textContent).not.toContain("Old laptop");
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

  it("shows each member's devices and what they are running, and says what a removal cut", async () => {
    const member = {
      accountId: "acct-bob",
      role: "operator",
      peerKeys: ["iroh:bob"],
      email: "bob@example.test",
      displayName: "Bob",
      approvedAt: 1_800_000_000,
      devices: [
        {
          peerKey: "iroh:bob",
          connections: 1,
          lastSeenAt: Date.now(),
          runs: [{ runId: "r1", sessionKey: "agent:main:trip" }],
        },
      ],
    };
    const { container, request } = await mountPage(
      [linked({ invites: [], members: [member] }), linked({ invites: [], members: [] })],
      { removal: { devices: 1, connectionsClosed: 1, runsCancelled: 1 } },
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "bob@example.test · 1 device · active now · running “Trip ideas”",
      ),
    );
    await vi.waitFor(() => expect(button(container, "Remove")?.disabled).toBe(false));
    button(container, "Remove")!.click();
    await vi.waitFor(() => expect(button(container, "Remove Bob")).toBeDefined());
    expect(request).not.toHaveBeenCalledWith("openclawId.authority", expect.anything());
    button(container, "Remove Bob")!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("openclawId.authority", {
        action: "submit",
        statement: { signed: { op: "remove", account_id: "acct-bob" } },
      }),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Bob removed · 1 connection closed · 1 run stopped"),
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
