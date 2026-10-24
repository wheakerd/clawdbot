import { describe, expect, it } from "vitest";
import { withTestTimeout } from "../../../../test/helpers/promise.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import { parseOpenAIChatGptResponsesSse } from "./openai-chatgpt-responses-protocol.js";

const completedEvent = { type: "response.completed", response: { id: "resp_parser" } };
const parse = (body: BodyInit) => parseOpenAIChatGptResponsesSse(new Response(body));
const serializedCompletedEvent = JSON.stringify(completedEvent);
const multilineDataLines = JSON.stringify(completedEvent, null, 2)
  .split("\n")
  .map((line) => `data: ${line}`);

describe("ChatGPT Responses SSE frame boundaries", () => {
  it("parses multiline mixed line endings SSE frame boundaries", async () => {
    const frame = `event: response.completed\r\n${multilineDataLines
      .map((line, index) => `${line}${index % 3 === 0 ? "\r\n" : index % 3 === 1 ? "\r" : "\n"}`)
      .join("")}\r\n`;
    const events = [];

    for await (const event of parse(frame)) {
      events.push(event);
    }

    expect(events).toEqual([completedEvent]);
  });

  it("dispatches a chunk-split lone CR SSE frame before an open response closes", async () => {
    const cleanup = new AbortController();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        cleanup.signal.addEventListener("abort", () => controller.close(), { once: true });
        for (const chunk of [`data: ${serializedCompletedEvent}\r`, "\r"]) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
      },
      cancel() {
        canceled = true;
      },
    });
    const iterator = parse(body);
    let receivedEvent = false;

    try {
      const result = await withTestTimeout(
        iterator.next(),
        1_000,
        "open-response frame did not settle",
      );
      receivedEvent = true;

      expect(result).toEqual({ done: false, value: completedEvent });
      expect(cleanup.signal.aborted).toBe(false);
      expect(canceled).toBe(false);
    } finally {
      if (!receivedEvent) {
        cleanup.abort();
      }
      await iterator.return(undefined);
    }

    expect(canceled).toBe(true);
  });

  it("keeps a final undelimited event after a delimited event", async () => {
    const precedingEvent = { type: "response.output_item.done" };
    const events = [];
    for await (const event of parse(
      `data: ${JSON.stringify(precedingEvent)}\n\ndata: ${serializedCompletedEvent}`,
    )) {
      events.push(event);
    }
    expect(events).toEqual([precedingEvent, completedEvent]);
  });

  it("rejects a malformed EOF frame after a valid event", async () => {
    const iterator = parse(`data: ${serializedCompletedEvent}\n\ndata: {not-json`);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: completedEvent });
    await expect(iterator.next()).rejects.toThrow(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
  });

  it("releases the response reader when upstream cancellation remains pending", async () => {
    let cancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${serializedCompletedEvent}\n\n`));
      },
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => {});
      },
    });
    const iterator = parse(body);

    await expect(
      withTestTimeout(iterator.next(), 250, "first response event did not settle"),
    ).resolves.toEqual({
      done: false,
      value: completedEvent,
    });
    await expect(
      withTestTimeout(iterator.return(undefined), 250, "terminal iterator cleanup did not settle"),
    ).resolves.toEqual({ done: true, value: undefined });
    expect(cancelStarted).toBe(true);

    const replacementReader = body.getReader();
    replacementReader.releaseLock();
  });
});
