import { once } from "node:events";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  WebSocket,
  WebSocketServer,
} from "../../packages/gateway-client/src/websocket.test-support.js";
import {
  WorkerConnectRequestFrameSchema,
  WORKER_PUBLIC_INGRESS_PATH,
  type WorkerConnectParams,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { PRESENCE_QUERY_TIMEOUT_MS } from "../agents/tools/presence-tool-contract.js";
import {
  WorkerAdmissionError,
  WorkerConnectionInterruptedError,
  WorkerConnectionStoppedError,
  type WorkerConnectionOptions,
} from "./worker-connection-contract.js";
import { createWorkerConnection } from "./worker-connection.js";

export function registerWorkerAdmissionWriteTests(
  FRAME_CONNECT_PARAMS: WorkerConnectParams,
  sendWorkerHello: (
    socket: WebSocket,
    id: string,
    admission: WorkerConnectParams["admission"],
  ) => void,
) {
  async function createAdmissionWriteFixture(
    onAdmissionRequestSent: () => void,
    onHeartbeat?: WorkerConnectionOptions["onHeartbeat"],
  ) {
    type WriteCallback = NonNullable<Parameters<WebSocket["send"]>[2]>;
    type WriteOptions = Parameters<WebSocket["send"]>[1];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test gateway did not allocate a TCP port");
    }
    const slot = () => ({
      written: createDeferred<WriteCallback>(),
      received: createDeferred<{ peer: WebSocket; id: string }>(),
    });
    let expected: ReturnType<typeof slot> | undefined;
    const connection = createWorkerConnection({
      endpoint: {
        kind: "websocket",
        url: `ws://127.0.0.1:${address.port}${WORKER_PUBLIC_INGRESS_PATH}`,
      },
      connectParams: FRAME_CONNECT_PARAMS,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      onAdmissionRequestSent,
      onHeartbeat,
      createSocket: (url, options) => {
        const attempt = expected;
        if (!attempt) {
          throw new Error("unexpected worker connection attempt");
        }
        expected = undefined;
        const socket = new WebSocket(url, options);
        const send = socket.send.bind(socket);
        socket.send = (
          data: Parameters<WebSocket["send"]>[0],
          optionsOrCallback?: WriteOptions | WriteCallback,
          callback?: WriteCallback,
        ) => {
          const onWritten = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
          const holdCompletion: WriteCallback = (error) => {
            if (error) {
              onWritten?.(error);
              attempt.written.reject(error);
              return;
            }
            // Bytes really crossed the socket; admission observes completion only when released.
            attempt.written.resolve((writeError) => onWritten?.(writeError));
          };
          if (typeof optionsOrCallback === "function" || optionsOrCallback === undefined) {
            send(data, holdCompletion);
          } else {
            send(data, optionsOrCallback, holdCompletion);
          }
        };
        return socket;
      },
    });
    const nextAttempt = () => {
      if (expected) {
        throw new Error("worker connection attempt is already expected");
      }
      const attempt = slot();
      expected = attempt;
      server.once("connection", (peer) => {
        peer.once("message", (data) => {
          try {
            const frame: unknown = JSON.parse(rawDataToString(data));
            if (!Value.Check(WorkerConnectRequestFrameSchema, frame)) {
              throw new Error("expected the worker admission request");
            }
            attempt.received.resolve({ peer, id: frame.id });
          } catch (error) {
            attempt.received.reject(error);
          }
        });
      });
      return Promise.all([attempt.written.promise, attempt.received.promise]).then(
        ([completeWrite, received]) => ({ completeWrite, ...received }),
      );
    };
    const first = nextAttempt();
    const starting = connection.start();
    const settled = starting.catch((error: unknown) => error);
    return {
      connection,
      first,
      starting,
      settled,
      nextAttempt,
      async close() {
        await connection.stop();
        for (const peer of server.clients) {
          peer.terminate();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await settled;
      },
    };
  }

  describe("worker admission write completion", () => {
    it("settles admitted heartbeat work before stop releases cleanup", async () => {
      const entered = createDeferred<() => void>();
      const release = createDeferred();
      const f = await createAdmissionWriteFixture(
        () => {},
        async (_result, assertCurrent) => {
          entered.resolve(assertCurrent);
          await release.promise;
        },
      );
      try {
        const attempt = await f.first;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        attempt.completeWrite();
        sendWorkerHello(attempt.peer, attempt.id, FRAME_CONNECT_PARAMS.admission);
        await f.starting;
        const heartbeat = once(attempt.peer, "message");
        await vi.advanceTimersByTimeAsync(60_000);
        const [data] = await heartbeat;
        const frame = JSON.parse(rawDataToString(data));
        attempt.peer.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              receivedAtMs: Date.now(),
              status: "ok",
              ownerEpoch: FRAME_CONNECT_PARAMS.admission.ownerEpoch,
            },
          }),
        );
        const assertCurrent = await entered.promise;
        let stopped = false;
        const stopping = f.connection.stop().then(() => {
          stopped = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(f.connection.state.kind).toBe("stopped");
        expect(assertCurrent).toThrow(WorkerConnectionInterruptedError);
        expect(stopped).toBe(false);
        release.resolve();
        await stopping;
        expect(stopped).toBe(true);
      } finally {
        release.resolve();
        vi.useRealTimers();
        await f.close();
      }
    });

    it("keeps a presence read pending through both cold geolocation download windows", async () => {
      const f = await createAdmissionWriteFixture(() => {});
      try {
        const attempt = await f.first;
        attempt.completeWrite();
        sendWorkerHello(attempt.peer, attempt.id, FRAME_CONNECT_PARAMS.admission);
        await f.starting;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const received = once(attempt.peer, "message");
        const pending = f.connection.invokeGatewayTool(
          {
            generation: "presence-surface",
            toolId: "presence",
            toolCallId: "cold-presence",
            arguments: { action: "list", include: ["location"] },
          },
          { timeoutMs: PRESENCE_QUERY_TIMEOUT_MS },
        );
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const [data] = await received;
        const frame = JSON.parse(rawDataToString(data));
        await vi.advanceTimersByTimeAsync(240_001);
        expect(settled).toBe(false);
        attempt.peer.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { content: [], details: { status: "ok" } },
          }),
        );
        await expect(pending).resolves.toMatchObject({ ok: true });
      } finally {
        vi.useRealTimers();
        await f.close();
      }
    });

    it.each([false, true])(
      "notifies only after the request write completes, isolating observer failure: %s",
      async (throws) => {
        const sent = vi.fn(() => {
          if (throws) {
            throw new Error("induced admission observer failure");
          }
        });
        const f = await createAdmissionWriteFixture(sent);
        try {
          const attempt = await f.first;
          expect(sent).not.toHaveBeenCalled();
          expect(f.connection.state.kind).toBe("admitting");
          expect(() => attempt.completeWrite()).not.toThrow();
          expect(sent).toHaveBeenCalledOnce();
          expect(f.connection.state.kind).toBe("admitting");
          sendWorkerHello(attempt.peer, attempt.id, FRAME_CONNECT_PARAMS.admission);
          await f.starting;
          expect(f.connection.state.kind).toBe("ready");
          expect(sent).toHaveBeenCalledOnce();
        } finally {
          await f.close();
        }
      },
    );

    it.each(["stop", "denied hello", "accepted hello"] as const)(
      "ignores late request-write completion after %s",
      async (boundary) => {
        const sent = vi.fn();
        const f = await createAdmissionWriteFixture(sent);
        try {
          const attempt = await f.first;
          if (boundary === "stop") {
            await f.connection.stop();
            expect(await f.settled).toBeInstanceOf(WorkerConnectionStoppedError);
          } else if (boundary === "denied hello") {
            attempt.peer.send(
              JSON.stringify({
                type: "res",
                id: attempt.id,
                ok: false,
                error: {
                  code: "INVALID_REQUEST",
                  message: "invalid admission",
                  details: { reason: "invalid-handshake" },
                  retryable: false,
                },
              }),
            );
            expect(await f.settled).toBeInstanceOf(WorkerAdmissionError);
          } else {
            sendWorkerHello(attempt.peer, attempt.id, FRAME_CONNECT_PARAMS.admission);
            await f.starting;
            expect(f.connection.state.kind).toBe("ready");
          }
          expect(() => attempt.completeWrite()).not.toThrow();
          expect(sent).not.toHaveBeenCalled();
        } finally {
          await f.close();
        }
      },
    );

    it.each(["failed write", "replaced socket"] as const)(
      "only notifies for the current successful attempt after %s",
      async (interruption) => {
        const sent = vi.fn();
        const f = await createAdmissionWriteFixture(sent);
        try {
          const first = await f.first;
          const replacement = f.nextAttempt();
          if (interruption === "failed write") {
            first.completeWrite(new Error("induced admission write failure"));
          } else {
            first.peer.close(1012, "gateway-unavailable");
          }
          const second = await replacement;
          expect(second.peer).not.toBe(first.peer);
          expect(f.connection.state).toEqual({ kind: "admitting", attempt: 1 });
          if (interruption === "replaced socket") {
            first.completeWrite();
          }
          expect(sent).not.toHaveBeenCalled();
          second.completeWrite();
          expect(sent).toHaveBeenCalledOnce();
          sendWorkerHello(second.peer, second.id, FRAME_CONNECT_PARAMS.admission);
          await f.starting;
          expect(f.connection.state.kind).toBe("ready");
        } finally {
          await f.close();
        }
      },
    );
  });
}
