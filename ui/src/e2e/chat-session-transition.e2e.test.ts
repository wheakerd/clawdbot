import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionA = "agent:main:session-a";
const sessionB = "agent:main:session-b";
const sessionList = chatSessionListResponse([
  { key: sessionA, kind: "direct", label: "Session A", updatedAt: 10, parentSessionKey: sessionB },
  ...Array.from({ length: 5 }, (_, index) => ({
    key: `agent:main:recent-${index}`,
    kind: "direct",
    label: `Recent ${index}`,
    updatedAt: 8 - index,
  })),
  { key: sessionB, kind: "direct", label: "Session B", updatedAt: 0 },
]);

suite.define(() => {
  it.each(["text", "notice", "empty", "error", "slow mobile"] as const)(
    "commits a cold %s transcript without exposing an empty target",
    async (kind) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: kind === "slow mobile" ? 390 : 1280, height: 900 },
      });
      const page = await context.newPage();
      const history = (key: string, messages: unknown[]) => ({
        messages,
        sessionId: `${key}:backing`,
        thinkingLevel: null,
      });
      const responses = {
        cases: [
          {
            match: { sessionKey: sessionA },
            response: history(sessionA, [
              { role: "assistant", content: "Session A complete.", timestamp: 1000 },
            ]),
          },
          {
            match: { sessionKey: sessionB },
            response: history(
              sessionB,
              kind === "empty"
                ? []
                : kind === "notice"
                  ? [{ role: "system", content: "Session B complete.", timestamp: 2000 }]
                  : Array.from({ length: 10 }, (_, index) => ({
                      role: index % 2 === 0 ? "user" : "assistant",
                      content:
                        index === 9
                          ? "Session B complete."
                          : `Planning turn ${index + 1}. ${"Review the session loading behavior and preserve the complete conversation. ".repeat(4)}`,
                      timestamp: 2000 + index,
                    })),
            ),
          },
        ],
      };
      const gateway = await installMockGateway(page, {
        sessionKey: sessionA,
        methodResponses: {
          "sessions.list": sessionList,
          "chat.startup": responses,
          "chat.history": responses,
        },
      });
      const visible = page.locator(".chat-pane-cache__pane--visible");
      const selectedKey = () =>
        visible.evaluate((node) => (node as HTMLElement & { sessionKey: string }).sessionKey);
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
        await page.getByText("Session A complete.", { exact: true }).waitFor();
        const trace = await page.evaluateHandle((target) => {
          const state = { frames: [] as string[], frame: 0 };
          const sample = () => {
            const pane = document.querySelector<HTMLElement & { sessionKey: string }>(
              ".chat-pane-cache__pane--visible",
            );
            const content = pane?.querySelectorAll(
              ".chat-group, .chat-notice, .agent-chat__welcome, .chat-history-error",
            );
            const painted = [...(content ?? [])].some((node) =>
              node.checkVisibility({ contentVisibilityAuto: true }),
            );
            const phase = pane?.querySelector("openclaw-panel-loading-skeleton")
              ? "fallback"
              : painted
                ? pane?.sessionKey === target
                  ? "content"
                  : "source"
                : "blank";
            if (state.frames.at(-1) !== phase) {
              state.frames.push(phase);
            }
            state.frame = requestAnimationFrame(sample);
          };
          sample();
          return state;
        }, sessionB);
        await gateway.deferNext("chat.startup", { sessionKey: sessionB });
        const before = (await gateway.getRequests("chat.startup", { sessionKey: sessionB })).length;

        // A header breadcrumb exercises the canonical pane change, without a sidebar intent.
        await page.locator(".chat-pane__parent-session").click();
        await gateway.waitForRequest("chat.startup", {
          after: before,
          match: { sessionKey: sessionB },
        });
        expect(await selectedKey()).toBe(sessionA);
        expect(await visible.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
        expect(await page.locator('.chat-pane-cache[aria-busy="true"]').count()).toBe(1);
        await page.locator('.chat-pane-cache__status[role="status"]').waitFor();
        await page.keyboard.press("x");
        expect(
          await page
            .locator("openclaw-chat-pane textarea")
            .evaluateAll((nodes) =>
              nodes.every(
                (node) =>
                  node !== document.activeElement && (node as HTMLTextAreaElement).value === "",
              ),
            ),
        ).toBe(true);

        const skeleton = visible.locator(
          'openclaw-panel-loading-skeleton[data-panel-skeleton="chat"]',
        );
        if (kind === "slow mobile") {
          // Keep history deferred past the former timed skeleton swap.
          await page.waitForTimeout(1_000);
          expect(await selectedKey()).toBe(sessionA);
          expect(await skeleton.count()).toBe(0);
        }
        if (kind === "error") {
          await gateway.rejectDeferred("chat.startup", {
            code: "UNAVAILABLE",
            message: "History unavailable",
          });
          await visible.getByText("History unavailable", { exact: false }).first().waitFor();
        } else {
          await gateway.resolveDeferred("chat.startup");
        }
        await expect.poll(selectedKey).toBe(sessionB);
        expect(await skeleton.count()).toBe(0);
        if (kind !== "empty" && kind !== "error") {
          await visible.getByText("Session B complete.", { exact: true }).waitFor();
        }
        expect(await visible.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
        await expect.poll(() => trace.evaluate((state) => state.frames.at(-1))).toBe("content");
        const frames = await trace.evaluate((state) => {
          cancelAnimationFrame(state.frame);
          return state.frames;
        });
        expect(frames).toEqual(["source", "content"]);
        await trace.dispose();
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("acknowledges an unresolved markdown session link before history loading", async () => {
    const context = await suite.newBrowserContext({ locale: "en-US" });
    const page = await context.newPage();
    const target = "agent:main:unlisted-session";
    const reference = { key: target, slug: "unlisted-session" };
    const gateway = await installMockGateway(page, {
      sessionKey: sessionA,
      historyMessages: [{ role: "assistant", content: `Open ${target}`, timestamp: 1000 }],
      methodResponses: {
        "sessions.resolve": {
          cases: [
            {
              match: { reference },
              response: { ok: true, key: target, agentId: "main" },
            },
          ],
        },
        "sessions.list": chatSessionListResponse([
          { key: sessionA, kind: "direct", label: "Session A", updatedAt: 10 },
        ]),
      },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
      const link = page.locator(`.markdown-session-link[data-session-key="${target}"]`).first();
      await link.waitFor();
      await gateway.deferNext("sessions.resolve", { reference });
      await link.click();
      await gateway.waitForRequest("sessions.resolve", { match: { reference } });
      const outlet = page.locator("openclaw-router-outlet");
      expect(await outlet.getAttribute("aria-busy")).toBe("true");
      expect(await outlet.evaluate((node) => (node as HTMLElement).inert)).toBe(true);
      const visible = page.locator(".chat-pane-cache__pane--visible");
      expect(await visible.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
      await page.locator('.chat-pane-cache__status[role="status"]').waitFor();
      await page.keyboard.press("Control+Shift+b");
      expect(await visible.locator('[data-panel-slot="workspace"]').count()).toBe(0);
      expect(await gateway.getRequests("chat.startup", { sessionKey: target })).toHaveLength(0);
      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${sessionA}"] a.sidebar-recent-session__link`,
        )
        .click();
      await expect.poll(() => outlet.getAttribute("aria-busy")).toBe("false");
      expect(await outlet.evaluate((node) => (node as HTMLElement).inert)).toBe(false);
      // A cancelled lookup cannot mount its target when the late reply arrives.
      await gateway.resolveDeferred("sessions.resolve");
      expect(await gateway.getRequests("chat.startup", { sessionKey: target })).toHaveLength(0);
      await link.click();
      await expect
        .poll(() =>
          page
            .locator(".chat-pane-cache__pane--visible")
            .evaluate((node) => (node as HTMLElement & { sessionKey: string }).sessionKey),
        )
        .toBe(target);
      expect(await outlet.getAttribute("aria-busy")).toBe("false");
      expect(await outlet.evaluate((node) => (node as HTMLElement).inert)).toBe(false);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
