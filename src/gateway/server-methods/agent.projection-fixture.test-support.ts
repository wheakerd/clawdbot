import { expect, it, vi } from "vitest";
import { getAgentTestMocks } from "./agent.test-harness.js";

export function registerAgentProjectionFixtureTests() {
  const mocks = getAgentTestMocks();
  it.each(["cleared", "no-op", "discarded result"])(
    "returns the replacement projection result with a %s store fixture",
    async (mode) => {
      mocks.updateSessionStore.mockReset();
      if (mode === "no-op") {
        mocks.updateSessionStore.mockResolvedValue(undefined);
      } else if (mode === "discarded result") {
        mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
          await updater({});
        });
      }
      const result = { transition: "empty-fixture" };
      const update = vi.fn(async () => ({ result }));

      await expect(
        mocks.applySessionEntryReplacements({ storePath: "/tmp/sessions.json", update }),
      ).resolves.toBe(result);
      expect(update).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledWith([]);
    },
  );

  it("keeps backing store replacements when its delegate discards the result", async () => {
    const sessionKey = "agent:main:main";
    const entry = { sessionId: "session-1", updatedAt: 1 };
    const store = { [sessionKey]: entry };
    const replacement = { ...entry, updatedAt: 2 };
    const result = { transition: "replaced" };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      await updater(store);
    });
    const update = vi.fn(async () => ({
      replacements: [{ sessionKey, entry: replacement }],
      result,
    }));

    await expect(
      mocks.applySessionEntryReplacements({
        storePath: "/tmp/sessions.json",
        sessionKeys: [sessionKey],
        update,
      }),
    ).resolves.toBe(result);
    expect(update).toHaveBeenCalledWith([{ sessionKey, entry }]);
    expect(store[sessionKey]).toEqual(replacement);
    expect(store[sessionKey]).not.toBe(replacement);
  });

  it("does not repeat a replacement projection whose result is undefined", async () => {
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      await updater({});
    });
    const update = vi.fn(async () => ({ result: undefined }));

    await expect(
      mocks.applySessionEntryReplacements({ storePath: "/tmp/sessions.json", update }),
    ).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledOnce();
  });

  it("does not run a replacement projection after its store fixture rejects", async () => {
    const failure = new Error("fixture write rejected");
    mocks.updateSessionStore.mockRejectedValueOnce(failure);
    const update = vi.fn(async () => ({ result: "unexpected projection" }));

    await expect(
      mocks.applySessionEntryReplacements({ storePath: "/tmp/sessions.json", update }),
    ).rejects.toBe(failure);
    expect(update).not.toHaveBeenCalled();
  });
}
