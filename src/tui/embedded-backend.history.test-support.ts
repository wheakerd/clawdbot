import { expect, it, vi, type Mock } from "vitest";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";

export function registerEmbeddedHistoryReadTests({
  createBackend,
  loadSessionEntryMock,
  readChatHistoryPageMock,
  loadAgentRuntimePluginRegistryHandleMock,
}: {
  createBackend: () => EmbeddedTuiBackend;
  loadSessionEntryMock: Mock;
  readChatHistoryPageMock: Mock;
  loadAgentRuntimePluginRegistryHandleMock: Mock;
}) {
  it("uses the canonical gateway projector for embedded TUI history reads", async () => {
    const entry = {
      sessionId: "sess-main",
      retainedHistoryReferences: { sessionIds: ["sess-main"], artifactPaths: [] },
    };
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      agentId: "main",
      canonicalKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
      entry,
    });

    const backend = createBackend();
    const messages = [
      {
        role: "system",
        content: [{ type: "text", text: "Compaction" }],
        __openclaw: {
          kind: "compaction",
          id: "compact",
          tokensBefore: 100,
          tokensAfter: 25,
        },
      },
      {
        role: "toolResult",
        toolCallId: "wait",
        toolName: "collab.wait",
        content: "raw result",
        isError: false,
        __openclaw: { id: "wait-result" },
      },
    ];
    readChatHistoryPageMock.mockResolvedValueOnce({
      messages,
      activity: [{ messageId: "wait-result", items: [] }],
    });
    const history = await backend.loadHistory({ sessionKey: "agent:main:main" });
    expect(history).toMatchObject({
      messages,
      activity: [{ messageId: "wait-result", items: [] }],
    });

    expect(readChatHistoryPageMock).toHaveBeenCalledWith({
      entry,
      provider: "openai",
      sessionId: "sess-main",
      storePath: "/tmp/openclaw-sessions.json",
      sessionAgentId: "main",
      canonicalKey: "agent:main:main",
      max: 200,
      maxHistoryBytes: 100_000,
      effectiveMaxChars: 100_000,
      offset: undefined,
      messageId: undefined,
    });
  });

  it("loads runtime plugins for the send-path workspace before returning embedded history", async () => {
    const cfg = { agents: { list: [{ id: "main" }] } };
    loadSessionEntryMock.mockReturnValue({
      cfg,
      agentId: "main",
      canonicalKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
      entry: { spawnedWorkspaceDir: "/tmp/openclaw-custom-workspace" },
    });

    const backend = createBackend();

    await expect(backend.loadHistory({ sessionKey: "agent:main:main" })).resolves.toMatchObject({
      runtimePluginsPrewarm: { status: "warmed" },
    });
    expect(loadAgentRuntimePluginRegistryHandleMock).toHaveBeenCalledWith({
      config: cfg,
      workspaceDir: "/tmp/openclaw-agent-main",
    });
  });

  it("returns embedded history when runtime plugin loading fails", async () => {
    loadAgentRuntimePluginRegistryHandleMock.mockImplementationOnce(() => {
      throw new Error("runtime unavailable");
    });
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      agentId: "main",
      canonicalKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
      entry: {},
    });

    const backend = createBackend();

    await expect(backend.loadHistory({ sessionKey: "agent:main:main" })).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      messages: [],
      runtimePluginsPrewarm: { status: "failed", error: "runtime unavailable" },
    });
  });
}

export function registerEmbeddedHistoryProjectionTests(params: {
  createBackend: () => EmbeddedTuiBackend;
  loadSessionEntry: Mock;
  describe: Mock;
  present: Mock;
  withPreparedExactRows: Mock;
  buildSessionRow: Mock;
}) {
  it("validates and presents history metadata within its prepared read frame", async () => {
    const entry = { sessionId: "captured-session", lifecycleRevision: "captured-revision" };
    const target = { key: "global", agentId: "work", storePath: "/tmp/physical.sqlite" };
    params.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: target.agentId,
      canonicalKey: target.key,
      storePath: "/tmp/logical.sqlite",
      readSource: { path: target.storePath },
      entry,
    });
    let active = false;
    const row = {
      get entry() {
        expect(active, "history identity must be validated before the read expires").toBe(true);
        return entry;
      },
      target,
    };
    const describe = vi.fn(() => row);
    const present = vi.fn((current: typeof row) => {
      expect(active, "history metadata must be presented before the read expires").toBe(true);
      expect(current).toBe(row);
      return { key: target.key, sessionId: current.entry.sessionId };
    });
    params.withPreparedExactRows.mockImplementationOnce(async (queries, consume) => {
      expect(queries({})).toEqual([target]);
      active = true;
      try {
        return { kind: "complete", value: consume({ describe, present }) };
      } finally {
        active = false;
      }
    });
    const backend = params.createBackend();
    backend.start();
    try {
      const result = await backend.loadHistory({ sessionKey: "global", agentId: "work" });
      expect(result).toMatchObject({
        sessionId: entry.sessionId,
        sessionInfo: { key: target.key, sessionId: entry.sessionId },
      });
      expect(describe).toHaveBeenCalledExactlyOnceWith(target);
      expect(present).toHaveBeenCalledExactlyOnceWith(row);
      expect(params.present).not.toHaveBeenCalled();
      expect(params.buildSessionRow).not.toHaveBeenCalled();
      expect(active).toBe(false);
    } finally {
      await backend.stop();
    }
  });

  it.each([
    { sessionId: "replacement-session", lifecycleRevision: "previous-revision" },
    { sessionId: "previous-session", lifecycleRevision: "replacement-revision" },
  ])("does not attach a replacement session row to captured history: %j", async (currentEntry) => {
    params.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "main",
      canonicalKey: "agent:main:main",
      storePath: "/tmp/main.sqlite",
      entry: { sessionId: "previous-session", lifecycleRevision: "previous-revision" },
    });
    params.describe.mockReturnValue({
      entry: currentEntry,
      target: { key: "agent:main:main" },
    });
    const backend = params.createBackend();
    backend.start();
    try {
      const result = await backend.loadHistory({ sessionKey: "agent:main:main" });
      expect(result.sessionId).toBe("previous-session");
      expect(result.sessionInfo).toBeUndefined();
      expect(params.present).not.toHaveBeenCalled();
      expect(params.buildSessionRow).not.toHaveBeenCalled();
    } finally {
      await backend.stop();
    }
  });
}
