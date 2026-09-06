import assert from "node:assert/strict";
import { createQaBusState } from "./bus-state.js";
import type { TelegramUserbotUpdate } from "./live-transports/telegram/userbot-driver.runtime.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import { readQaScenarioById, type QaScenarioFlow } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import type { QaSuiteStep } from "./suite-types.js";

function formatTestTranscript(state: ReturnType<typeof createQaBusState>) {
  return state
    .getSnapshot()
    .messages.map((message) => `${message.direction}:${message.conversation.id}:${message.text}`)
    .join("\n");
}

export async function runLoadedScenarioFlow(
  scenarioId: string,
  params: {
    flow?: QaScenarioFlow;
    api?: Record<string, unknown>;
    state?: ReturnType<typeof createQaBusState>;
    omitOutboundSequence?: boolean;
    onWaitForOutboundMessage?: (params: {
      waitCount: number;
      state: ReturnType<typeof createQaBusState>;
    }) => void;
  } = {},
) {
  const scenario = readQaScenarioById(scenarioId);
  const loadedFlow = scenario.execution.flow;
  if (!loadedFlow) {
    throw new Error(`scenario has no flow: ${scenarioId}`);
  }

  const state = params.state ?? createQaBusState();
  let waitCount = 0;
  const transport = {
    accountId: "qa-channel",
    state,
    reset: async () => {
      state.reset();
    },
    sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) =>
      state.addInboundMessage(input),
    sendNativeCommand: async (
      input: Omit<Parameters<typeof state.addInboundMessage>[0], "nativeCommand" | "text"> & {
        command: string;
      },
    ) => {
      const { command, ...message } = input;
      state.addInboundMessage({
        ...message,
        text: `/${command}`,
        nativeCommand: { name: command },
      });
    },
    waitForNoOutbound: async () => undefined,
    waitForOutbound: async (input: {
      conversation?: { id: string; kind: string };
      sinceIndex?: number;
      textIncludes?: string;
      timeoutMs?: number;
    }) => {
      waitCount += 1;
      params.onWaitForOutboundMessage?.({ waitCount, state });
      const match = state
        .getSnapshot()
        .messages.filter((candidate) => candidate.direction === "outbound")
        .slice(input.sinceIndex ?? 0)
        .find(
          (candidate) =>
            (!input.conversation || candidate.conversation.id === input.conversation.id) &&
            (!input.conversation || candidate.conversation.kind === input.conversation.kind) &&
            (!input.textIncludes || candidate.text.includes(input.textIncludes)),
        );
      if (match) {
        state.resolvePollCursor({
          accountId: "qa-channel",
          cursor: state.getSnapshot().cursor,
          acknowledgedCursor: state.getSnapshot().cursor,
        });
        return match;
      }
      throw new Error(`timed out after ${input.timeoutMs}ms waiting for outbound marker`);
    },
    ...(params.omitOutboundSequence
      ? {}
      : {
          waitForOutboundSequence: async () => {
            throw new Error("outbound sequence not configured for this fixture");
          },
        }),
  };
  const api = {
    env: {
      providerMode: "mock-openai",
      gateway: {
        restartAfterStateMutation: async (mutate: (context: unknown) => Promise<void>) => {
          await mutate({});
        },
      },
    },
    transport,
    state,
    scenario,
    config: scenario.execution.config ?? {},
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
    liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
    waitForGatewayHealthy: async () => undefined,
    waitForTransportReady: async () => undefined,
    waitForQaChannelReady: async () => undefined,
    waitForNoOutbound: async () => undefined,
    waitForCondition: async <T>(check: () => T | Promise<T | undefined>) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const value = await check();
        if (value !== undefined) {
          return value;
        }
      }
      throw new Error("test condition was not met");
    },
    sleep: async () => undefined,
    reset: async () => {
      state.reset();
    },
    resetBus: async () => {
      state.reset();
    },
    runAgentPrompt: async () => undefined,
    formatTransportTranscript: formatTestTranscript,
    waitForOutboundMessage: async (
      stateLocal: ReturnType<typeof createQaBusState>,
      predicate: (candidate: unknown) => boolean,
      timeoutMs: number,
      options?: { sinceIndex?: number },
    ) => {
      waitCount += 1;
      params.onWaitForOutboundMessage?.({ waitCount, state: stateLocal });
      const match = stateLocal
        .getSnapshot()
        .messages.slice(options?.sinceIndex ?? 0)
        .find((candidate) => predicate(candidate));
      if (match) {
        return match;
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for outbound marker`);
    },
    runScenario: async (_name: string, steps: QaSuiteStep[]) => {
      const stepResults = [];
      for (const step of steps) {
        const outcome = await step.run();
        const details = outcome?.details;
        stepResults.push({
          name: step.name,
          status: "pass" as const,
          ...(details !== undefined ? { details } : {}),
        });
      }
      return {
        name: scenario.title,
        status: "pass" as const,
        steps: stepResults,
      };
    },
    ...params.api,
  };

  return await runScenarioFlow({
    api,
    scenarioTitle: scenario.title,
    flow: params.flow ?? loadedFlow,
  });
}

export async function runTelegramRichObservationFlow(delayedKind: "message" | "edit") {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const wrap = (kind: string, text: unknown) => ({ "@type": kind, text });
  const url = (text: unknown) => ({
    ...wrap("richTextUrl", text),
    url: "https://example.com/qa",
  });
  const paragraph = (text: unknown) => ({ "@type": "pageBlockParagraph", text });
  const styled = url(wrap("richTextBold", plain("Download")));
  const list = { "@type": "pageBlockList", items: [{ blocks: [paragraph(styled)] }] };
  const math = { "@type": "richTextMathematicalExpression", expression: "x" };
  const emoji = {
    "@type": "richTextCustomEmoji",
    custom_emoji_id: "5368324170671202286",
    alternative_text: "😀",
  };
  const annotation = (wrapper: (text: unknown) => unknown) =>
    paragraph({
      "@type": "richTexts",
      texts: [
        wrapper(plain("\n")),
        wrap("richTextFixed", plain("user[Thu]")),
        wrapper(plain(" trailing")),
      ],
    });
  const nativeBlocks = [
    { "@type": "pageBlockDetails", header: plain("More"), blocks: [paragraph(styled)] },
    list,
    { "@type": "pageBlockBlockQuote", blocks: [paragraph(styled)] },
    paragraph(url(math)),
    paragraph(wrap("richTextSpoiler", math)),
    paragraph(url(emoji)),
    paragraph(wrap("richTextSpoiler", emoji)),
    annotation(url),
    annotation((text) => wrap("richTextBold", text)),
  ];
  type Observation = Pick<
    TelegramUserbotUpdate,
    "botApiMessageId" | "contentType" | "kind" | "richMessage"
  >;
  const observed: Observation[] = [];
  const observation = (id: number, block: unknown, kind: "message" | "edit"): Observation => ({
    botApiMessageId: id,
    kind,
    contentType: "messageRichMessage",
    richMessage: { "@type": "richMessage", blocks: [block], is_full: true, is_rtl: false },
  });
  const timers: ReturnType<typeof setTimeout>[] = [];
  const deliver = (kind: "message" | "edit", action: () => void) => {
    // Receipts settle first; native updates arrive on a later event-loop turn.
    if (kind === delayedKind) {
      timers.push(setTimeout(action, 1));
    } else {
      action();
    }
  };
  let sends = 0;
  let edits = 0;
  try {
    const result = await runLoadedScenarioFlow("telegram-rich-inline-composition", {
      api: {
        env: {
          providerMode: "mock-openai",
          cfg: { channels: { telegram: { accounts: { sut: { richMessages: true } } } } },
          gateway: {
            call: async (method: string) => {
              assert.equal(method, "send");
              const block = nativeBlocks[sends];
              const id = ++sends;
              deliver("message", () => observed.push(observation(id, block, "message")));
              return { messageId: id };
            },
          },
        },
        transport: {
          id: "telegram",
          accountId: "sut",
          reset() {},
          buildAgentDelivery: () => ({ to: "123" }),
        },
        readTelegramMessages: () => structuredClone(observed),
        waitForCondition: waitForQaTransportCondition,
        runQaCli: async (_env: unknown, args: string[]) => {
          assert.deepEqual(args.slice(0, 2), ["message", "edit"]);
          const id = Number(args[args.indexOf("--message-id") + 1]);
          assert.equal(id, 1);
          edits += 1;
          deliver("edit", () => {
            observed[0] = observation(id, list, "edit");
          });
        },
        runAgentPrompt: () => {
          throw new Error("direct delivery must not invoke a model");
        },
      },
    });
    return { result, sends, edits, observed };
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  }
}
