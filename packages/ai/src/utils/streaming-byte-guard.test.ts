import { describe, expect, it } from "vitest";
import { withTestTimeout } from "../../../../test/helpers/promise.js";
import { createSseByteGuard } from "./streaming-byte-guard.js";

describe("createSseByteGuard cancellation", () => {
  it("reports overflow without waiting for upstream cancellation", async () => {
    let cancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
      },
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => {});
      },
    });
    const guard = createSseByteGuard(body.getReader(), { maxBytes: 1 });

    await expect(
      withTestTimeout(guard.read(), 250, "overflow read did not settle"),
    ).rejects.toThrow("SSE stream exceeds 1 bytes (received 2)");
    expect(cancelStarted).toBe(true);
    expect(guard.overflowed()).toBe(true);
  });

  it("finishes explicit cancellation after handing cleanup upstream", async () => {
    let cancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => {});
      },
    });
    const guard = createSseByteGuard(body.getReader(), { maxBytes: 1 });

    await expect(
      withTestTimeout(guard.cancel("done"), 250, "explicit cancel did not settle"),
    ).resolves.toBeUndefined();
    expect(cancelStarted).toBe(true);
    expect(guard.cancelled()).toBe(true);
  });
});
