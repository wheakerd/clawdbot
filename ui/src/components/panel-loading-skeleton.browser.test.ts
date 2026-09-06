import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../test-helpers/load-styles.ts";
import "./panel-loading-skeleton.ts";

afterEach(() => document.body.replaceChildren());

it("matches full, mobile, and compact chat geometry", async () => {
  const skeleton = document.createElement("openclaw-panel-loading-skeleton");
  skeleton.setAttribute("data-panel-skeleton", "chat");
  document.body.append(skeleton);

  for (const [width, compact, userMin, userMax, assistantMin] of [
    [1280, false, 0.64, 0.72, 0.9],
    [390, false, 0.84, 0.92, 0.9],
    [1280, true, 0.6, 0.68, 0.84],
  ] as const) {
    await page.viewport(width, 900);
    skeleton.toggleAttribute("compact", compact);
    await expect
      .poll(() => skeleton.shadowRoot?.querySelectorAll(".chat-turn").length)
      .toBe(compact ? 3 : 5);

    const conversation = skeleton.shadowRoot!.querySelector<HTMLElement>(".conversation")!;
    const userTurn = conversation.querySelector<HTMLElement>('[data-skeleton-role="user"]')!;
    const assistantTurn = conversation.querySelector<HTMLElement>(
      '[data-skeleton-role="assistant"]',
    )!;
    const bounds = conversation.getBoundingClientRect();
    const userRatio = userTurn.getBoundingClientRect().width / bounds.width;
    const assistantRatio = assistantTurn.getBoundingClientRect().width / bounds.width;

    expect(userRatio).toBeGreaterThan(userMin);
    expect(userRatio).toBeLessThan(userMax);
    expect(assistantRatio).toBeGreaterThan(assistantMin);
    expect(assistantRatio).toBeLessThanOrEqual(compact ? 0.92 : 1);
    expect(bounds.top - skeleton.getBoundingClientRect().top).toBeLessThan(80);
    expect(getComputedStyle(assistantTurn).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(userTurn).backgroundColor).not.toBe(
      getComputedStyle(assistantTurn).backgroundColor,
    );
  }
});
