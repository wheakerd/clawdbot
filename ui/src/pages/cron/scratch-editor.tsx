import { render as renderSolid } from "@solidjs/web";
import { createMemo, createSignal } from "solid-js";
import type { CronScratchGetResult, CronScratchSetResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { i18n, t } from "../../i18n/index.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";

registerCronEnglish();

class CronScratchEditor extends HTMLElement {
  private currentJobId = "";
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private unsubscribeGateway?: () => void;
  private unsubscribeLocale?: () => void;
  private bindingRevision = 0;
  private snapshot: CronScratchGetResult | null = null;
  private draft = "";
  private busy = false;
  private message = "";
  private conflict = false;
  private redacted = false;
  private readonly projection = createSignal(0);
  private disposePresentation?: () => void;
  private readonly connection = createGatewayConnectionLifecycle({
    client: null,
    phase: "stopped",
  });

  get jobId() {
    return this.currentJobId;
  }

  set jobId(value: string) {
    if (value === this.currentJobId) {
      return;
    }
    this.currentJobId = value;
    this.connection.invalidate();
    this.reset();
  }

  get gateway() {
    return this.gatewaySource;
  }

  set gateway(value: ApplicationContext["gateway"] | null) {
    if (value === this.gatewaySource) {
      return;
    }
    this.gatewaySource = value;
    this.bindGateway();
  }

  connectedCallback() {
    this.bindGateway();
    this.unsubscribeLocale = i18n.subscribe(() => this.publish());
    this.disposePresentation = renderSolid(() => this.renderContent(), this);
  }

  disconnectedCallback() {
    this.bindingRevision += 1;
    this.unsubscribeGateway?.();
    this.unsubscribeGateway = undefined;
    this.unsubscribeLocale?.();
    this.unsubscribeLocale = undefined;
    this.connection.transition({ client: null, phase: "stopped" });
    this.reset();
    this.disposePresentation?.();
    this.disposePresentation = undefined;
  }

  private publish() {
    this.projection[1]((revision) => revision + 1);
  }

  private bindGateway() {
    const bindingRevision = ++this.bindingRevision;
    this.unsubscribeGateway?.();
    this.unsubscribeGateway = undefined;
    this.connection.invalidate();
    this.reset();
    const gateway = this.gatewaySource;
    if (!this.isConnected || !gateway) {
      this.connection.transition({ client: null, phase: "stopped" });
      return;
    }
    this.applySnapshot(gateway.snapshot);
    this.unsubscribeGateway = gateway.subscribe((snapshot) => {
      if (bindingRevision === this.bindingRevision && gateway === this.gatewaySource) {
        this.applySnapshot(snapshot);
      }
    });
  }

  private applySnapshot(snapshot: ApplicationGatewaySnapshot) {
    if (this.connection.transition(snapshot)) {
      this.reset();
    }
    if (!this.canManage) {
      this.connection.invalidate();
      this.reset();
    }
    this.publish();
  }

  private reset() {
    this.snapshot = null;
    this.draft = "";
    this.busy = false;
    this.message = "";
    this.conflict = false;
    this.redacted = false;
    this.publish();
  }

  private get canManage() {
    return Boolean(
      this.gatewaySource && readGatewayOperatorAccess(this.gatewaySource.snapshot).canAdmin,
    );
  }

  private get sizeBytes() {
    return new TextEncoder().encode(this.draft).length;
  }

  private accept(snapshot: CronScratchGetResult) {
    const content = snapshot.scratch?.content ?? "";
    this.draft = redactToolDetail(content);
    this.redacted = this.draft !== content;
    // Retain revision metadata only: raw scratch must not leak into diagnostics/state dumps.
    this.snapshot = {
      ...snapshot,
      scratch: snapshot.scratch ? { ...snapshot.scratch, content: "" } : null,
    };
    this.conflict = false;
  }

  private async request(content?: string | null) {
    const scope = this.connection.capture();
    const client = scope?.client;
    const jobId = this.jobId;
    const saving = content !== undefined;
    const snapshot = this.snapshot;
    if (!scope || !client || !jobId || this.busy || !this.canManage) {
      return;
    }
    if (saving && (!this.canManage || !snapshot || this.conflict)) {
      return;
    }
    if (typeof content === "string" && this.redacted) {
      return;
    }
    if (typeof content === "string" && snapshot && this.sizeBytes > snapshot.maxBytes) {
      this.message = t("cron.scratch.tooLarge");
      this.publish();
      return;
    }
    this.busy = true;
    this.message = "";
    this.publish();
    try {
      const result = saving
        ? await client.request<CronScratchSetResult>("cron.scratch.set", {
            id: jobId,
            content,
            expectedRevision: snapshot?.currentRevision,
          })
        : await client.request<CronScratchGetResult>("cron.scratch.get", { id: jobId });
      if (!this.connection.isCurrent(scope) || this.jobId !== jobId || !this.canManage) {
        return;
      }
      if ("reason" in result) {
        // Never adopt the conflicting revision while retaining an older draft: a retry would overwrite it.
        this.conflict = true;
        this.message = t("cron.scratch.conflict");
        return;
      }
      this.accept(result);
      if (saving) {
        this.message = t(content === null ? "cron.scratch.removed" : "cron.scratch.saved");
      }
    } catch (error) {
      if (this.connection.isCurrent(scope) && this.jobId === jobId) {
        this.message = formatUiError(error);
      }
    } finally {
      if (this.connection.isCurrent(scope) && this.jobId === jobId) {
        this.busy = false;
        this.publish();
      }
    }
  }

  private renderContent() {
    // Request fields remain synchronous; Solid only projects the admitted view.
    const view = createMemo(() => {
      this.projection[0]();
      return {
        canManage: this.canManage,
        snapshot: this.snapshot,
        draft: this.draft,
        busy: this.busy,
        connected: this.gatewaySource?.snapshot.phase === "connected",
        disabled:
          this.busy ||
          this.gatewaySource?.snapshot.phase !== "connected" ||
          !this.canManage ||
          this.conflict,
        redacted: this.redacted,
        sizeBytes: this.sizeBytes,
        message: this.message,
      };
    });
    const text: typeof t = (key, params) => {
      this.projection[0]();
      return t(key, params);
    };
    return (
      <>
        {view().canManage && (
          <section class="settings-section">
            <details>
              <summary class="settings-section__heading">{text("cron.scratch.title")}</summary>
              <p class="settings-section__desc">{text("cron.scratch.help")}</p>
              <button
                class="btn btn--sm"
                type="button"
                disabled={view().busy || !view().connected}
                onClick={() => void this.request()}
              >
                {text(view().snapshot ? "cron.scratch.reload" : "cron.scratch.load")}
              </button>
              {view().snapshot && (
                <>
                  {!view().snapshot?.scratch && (
                    <p class="cron-help">{text("cron.scratch.empty")}</p>
                  )}
                  <label class="field">
                    <span>{text("cron.scratch.content")}</span>
                    <textarea
                      class="settings-input mono"
                      rows="8"
                      value={view().draft}
                      readonly={view().disabled || view().redacted}
                      maxlength={view().snapshot?.maxBytes}
                      onInput={(event) => {
                        this.draft = event.currentTarget.value;
                        this.publish();
                      }}
                    ></textarea>
                  </label>
                  <p class="cron-help">
                    {text("cron.scratch.limit", {
                      bytes: String(view().sizeBytes),
                      max: String(view().snapshot?.maxBytes),
                    })}
                  </p>
                  {view().redacted && <p class="cron-help">{text("cron.scratch.redacted")}</p>}
                  <button
                    class="btn btn--sm"
                    type="button"
                    disabled={
                      view().disabled ||
                      view().redacted ||
                      view().sizeBytes > (view().snapshot?.maxBytes ?? 0)
                    }
                    onClick={() => void this.request(this.draft)}
                  >
                    {text("cron.scratch.save")}
                  </button>{" "}
                  <button
                    class="btn btn--sm danger"
                    type="button"
                    disabled={view().disabled || !view().snapshot?.scratch}
                    onClick={() => void this.request(null)}
                  >
                    {text("cron.scratch.clear")}
                  </button>
                </>
              )}
              {view().message && (
                <p class="cron-help" role="status">
                  {view().message}
                </p>
              )}
            </details>
          </section>
        )}
      </>
    );
  }
}

if (!customElements.get("openclaw-cron-scratch-editor")) {
  customElements.define("openclaw-cron-scratch-editor", CronScratchEditor);
}
