import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entries: [] as Array<
    [
      string,
      { adapter: { requester?: { connectionId?: string } }; active: boolean; sessionKey: string },
    ]
  >,
  dispatch: vi.fn(async () => ({ aborted: true })),
  invalidate: vi.fn(),
  revoke: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../sessions/session-controller.rpc-sources.js", () => ({
  listRpcSourceEntries: () => mocks.entries,
  isRpcSourceActive: (ref: { active: boolean }) => ref.active,
  getRpcSourceIdentity: (ref: { sessionKey: string }) => ({ sessionKey: ref.sessionKey }),
}));
vi.mock("../server-in-process-dispatch.js", () => ({
  dispatchGatewayRequestInProcess: mocks.dispatch,
}));
vi.mock("../server/ws-policy-close.js", () => ({
  invalidateGatewayPolicyClient: mocks.invalidate,
}));
vi.mock("../../infra/device-pairing-tokens.js", () => ({ revokeDeviceToken: mocks.revoke }));

const { createOpenClawIdRemovalEffects } = await import("./removal-effects.js");

const BOB = `iroh:${"bb".repeat(32)}`;
const ALICE = `iroh:${"aa".repeat(32)}`;
const client = (connId: string, peerKey?: string) =>
  ({ connId, internal: peerKey ? { openclawIdPeerKey: peerKey } : {} }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entries = [
    [
      "run-bob",
      {
        adapter: { requester: { connectionId: "c-bob" } },
        active: true,
        sessionKey: "agent:main:bob",
      },
    ],
    [
      "run-bob-done",
      {
        adapter: { requester: { connectionId: "c-bob" } },
        active: false,
        sessionKey: "agent:main:bob",
      },
    ],
    [
      "run-alice",
      {
        adapter: { requester: { connectionId: "c-alice" } },
        active: true,
        sessionKey: "agent:main:a",
      },
    ],
  ];
});

describe("removal effects", () => {
  // Spec section 11 #12: removing a member mid-run cancels the run through the
  // ordinary Stop path, which keeps the transcript up to the cut.
  it("stops only the removed member's active runs, then closes its sessions", async () => {
    const effects = createOpenClawIdRemovalEffects({
      clients: () => [client("c-bob", BOB), client("c-alice", ALICE), client("c-local")],
      context: () => ({}) as never,
      log: { warn: vi.fn() },
    });
    const connections = effects.captureConnections([BOB]);
    expect(connections).toEqual(["c-bob"]);
    expect(await effects.cancelRuns?.(connections)).toBe(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "chat.abort",
      { sessionKey: "agent:main:bob", runId: "run-bob" },
      expect.objectContaining({
        client: expect.objectContaining({
          internal: expect.objectContaining({ syntheticClient: true }),
        }),
      }),
    );
    effects.closeConnections(connections);
    expect(mocks.invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ connId: "c-bob" }),
      expect.objectContaining({ reason: "openclaw-id-removed", code: 1008 }),
    );
    await effects.revokeDeviceTokens([{ deviceId: "bob-device", role: "operator" }]);
    expect(mocks.revoke).toHaveBeenCalledWith({ deviceId: "bob-device", role: "operator" });
  });
});
