import "../../styles/secret-reveal.css";
import { createSignal, Match, Show, Switch } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { requestOpenClawIdLinkCode } from "../../lib/openclaw-id/account.ts";
import { generateOwnerDeviceKey, saveOwnerDeviceKey } from "../../lib/openclaw-id/device-key.ts";
import {
  createOpenClawIdCeremony,
  linkCodePageUrl,
  type OpenClawIdKit,
} from "../../lib/openclaw-id/link.ts";
import type {
  OpenClawIdLinkPreparation,
  OpenClawIdPublication,
  OpenClawIdSignedIn,
} from "../../lib/openclaw-id/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { CopyButton } from "../solid/copy-button.tsx";
import { Icon } from "../solid/icon.tsx";
import { SettingsRow, SettingsToggleRow } from "../solid/settings-ui.tsx";

type Step =
  | { kind: "name" }
  | { kind: "intro"; preparation: OpenClawIdLinkPreparation }
  | { kind: "kit"; preparation: OpenClawIdLinkPreparation; kit: OpenClawIdKit }
  | { kind: "linking" }
  | { kind: "done"; hostname: string; publication: OpenClawIdPublication | null }
  | { kind: "error"; message: string };

// Offers the kit as a text file so the owner can store it with their passwords.
function downloadKit(kit: OpenClawIdKit, hostname: string) {
  const text = [
    "OpenClaw recovery kit",
    "",
    `Kit: ${kit.text}`,
    `Owner fingerprint: ${kit.rootFingerprint}`,
    `First claw: https://${hostname}`,
    "",
    "Anyone with this kit can take ownership of your claws. Keep it private.",
    "",
  ].join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "openclaw-recovery-kit.txt";
  link.click();
  URL.revokeObjectURL(url);
}

/** The address Discovery offers for a claw name (openclawId.authority check_name). */
type NameCheck = { name: string; accountTag: string; hostname: string; available: boolean };

// The name offered until the owner types one.
const DEFAULT_CLAW_NAME = "claw";

/**
 * "Make reachable" (spec section 4): the owner names the claw (Discovery assigns
 * "<name>-<account tag>.<loader domain>" for the link code's account), then
 * creates the recovery kit, blocks until the
 * owner confirms it is saved, signs the claw's binding with the kit's root and
 * hands only signed statements to the Gateway. Resolves true once linked.
 * When the Control UI is signed in to OpenClaw ID, the link code comes from the
 * account; otherwise (or if that fails) the owner pastes one.
 */
export function showMakeReachableDialog(params: {
  client: GatewayBrowserClient;
  loaderDomain: string;
  signedIn?: OpenClawIdSignedIn | null;
}): Promise<boolean> {
  const ceremony = createOpenClawIdCeremony();
  return withPromiseModalHost<boolean>(undefined, (modal) => {
    modal.render(() => {
      const [step, setStep] = createSignal<Step>({ kind: "name" });
      const [saved, setSaved] = createSignal(false);
      const [enrollmentCode, setEnrollmentCode] = createSignal("");
      const [name, setName] = createSignal(DEFAULT_CLAW_NAME);
      const [check, setCheck] = createSignal<NameCheck | null>(null);
      const [nameError, setNameError] = createSignal<string | null>(null);
      const [codeFromAccount, setCodeFromAccount] = createSignal(false);
      const [codeNote, setCodeNote] = createSignal<string | null>(null);
      const nameRequest = () => ({
        enrollmentCode: enrollmentCode().trim(),
        name: name().trim().toLowerCase(),
      });
      // Asks the Gateway (and through it Discovery) whether the name is free.
      const checkName = async () => {
        setCheck(null);
        setNameError(null);
        if (!nameRequest().enrollmentCode || !nameRequest().name) {
          return;
        }
        try {
          setCheck(
            await params.client.request<NameCheck>("openclawId.authority", {
              action: "check_name",
              ...nameRequest(),
            }),
          );
        } catch (error) {
          setNameError(formatUiError(error));
        }
      };
      // Fills the link code from the signed-in account, then checks the default name.
      const fillCodeFromAccount = async (signedIn: OpenClawIdSignedIn) => {
        const account = signedIn.email ?? signedIn.name ?? signedIn.sub;
        try {
          setEnrollmentCode(await requestOpenClawIdLinkCode(params.client, signedIn));
          setCodeFromAccount(true);
          setCodeNote(t("openclawId.signedInLinkCode", { account }));
          await checkName();
        } catch (error) {
          setCodeNote(t("openclawId.linkCodeFailed", { error: formatUiError(error) }));
        }
      };
      // The account is fixed for this dialog; prefill once it has rendered.
      const signedIn = params.signedIn;
      if (signedIn) {
        queueMicrotask(() => void fillCodeFromAccount(signedIn));
      }
      // Records the address the owner root will sign; Discovery assigns it at registration.
      const prepare = async () => {
        setNameError(null);
        try {
          const preparation = await params.client.request<OpenClawIdLinkPreparation>(
            "openclawId.authority",
            { action: "prepare", ...nameRequest() },
          );
          setStep({ kind: "intro", preparation });
        } catch (error) {
          setNameError(formatUiError(error));
        }
      };
      const finish = (linked: boolean) => {
        ceremony.discard();
        modal.finish(linked);
      };
      const createKit = async (preparation: OpenClawIdLinkPreparation) => {
        try {
          setStep({ kind: "kit", preparation, kit: await ceremony.createKit() });
        } catch (error) {
          setStep({ kind: "error", message: formatUiError(error) });
        }
      };
      const link = async (preparation: OpenClawIdLinkPreparation) => {
        setStep({ kind: "linking" });
        try {
          const device = await generateOwnerDeviceKey();
          const statements = await ceremony.sign(
            preparation,
            device.signer,
            t("openclawId.thisBrowser"),
          );
          // R is no longer needed once the statements are signed.
          ceremony.discard();
          const result = await params.client.request<{ publication: OpenClawIdPublication | null }>(
            "openclawId.authority",
            {
              action: "commit",
              ...statements,
              enrollmentCode: nameRequest().enrollmentCode,
            },
          );
          await saveOwnerDeviceKey(preparation.claw_id, device.pair);
          setStep({
            kind: "done",
            hostname: preparation.hostname,
            publication: result.publication,
          });
        } catch (error) {
          ceremony.discard();
          setStep({ kind: "error", message: formatUiError(error) });
        }
      };
      const cancel = (event: Event) => {
        // The kit is shown once: closing before linking discards it, so confirm intent.
        if (step().kind === "linking") {
          event.preventDefault();
          return;
        }
        finish(step().kind === "done");
      };
      return (
        <openclaw-modal-dialog
          label={t("openclawId.dialogTitle")}
          description={t("openclawId.dialogDescription")}
          onModal-cancel={cancel}
        >
          <div class="exec-approval-card">
            <div class="secret-reveal__header">
              <Show when={step().kind === "done"}>
                <span class="secret-reveal__status" aria-hidden="true">
                  <Icon name="check" />
                </span>
              </Show>
              <div class="exec-approval-title">{t("openclawId.dialogTitle")}</div>
            </div>
            <Switch>
              <Match when={step().kind === "name"}>
                <div class="secret-reveal__body">
                  <p>{t("openclawId.nameBody")}</p>
                </div>
                <Show when={codeNote()}>
                  {(note) => (
                    <p class="secret-reveal__note" role="status">
                      {note()}
                    </p>
                  )}
                </Show>
                <Show when={!codeFromAccount()}>
                  <SettingsRow
                    title={t("openclawId.enrollmentCode")}
                    description={t("openclawId.enrollmentCodeHint")}
                    control={
                      <input
                        class="settings-input"
                        type="text"
                        aria-label={t("openclawId.enrollmentCode")}
                        autocomplete="off"
                        spellcheck="false"
                        value={enrollmentCode()}
                        onInput={(event) => {
                          setEnrollmentCode(event.currentTarget.value);
                          setCheck(null);
                        }}
                        onChange={() => void checkName()}
                      />
                    }
                  />
                  <a
                    class="btn btn--sm"
                    href={linkCodePageUrl(params.loaderDomain)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("openclawId.getLinkCode")}
                  </a>
                </Show>
                <SettingsRow
                  title={t("openclawId.clawName")}
                  description={t("openclawId.clawNameHint")}
                  control={
                    <input
                      class="settings-input"
                      type="text"
                      aria-label={t("openclawId.clawName")}
                      autocomplete="off"
                      spellcheck="false"
                      maxlength={57}
                      value={name()}
                      onInput={(event) => {
                        setName(event.currentTarget.value);
                        setCheck(null);
                      }}
                      onChange={() => void checkName()}
                    />
                  }
                />
                <Show when={check()}>
                  {(checked) => (
                    <p class="secret-reveal__note" role="status">
                      {checked().available
                        ? t("openclawId.nameAvailable", { host: checked().hostname })
                        : t("openclawId.nameTaken", { host: checked().hostname })}
                    </p>
                  )}
                </Show>
                <Show when={nameError()}>
                  {(message) => (
                    <div class="callout danger" role="alert">
                      {message()}
                    </div>
                  )}
                </Show>
                <openclaw-modal-actions class="exec-approval-actions">
                  <button type="button" class="btn" onClick={() => finish(false)}>
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    class="btn primary"
                    disabled={
                      !nameRequest().enrollmentCode ||
                      !nameRequest().name ||
                      check()?.available === false
                    }
                    onClick={() => void prepare()}
                  >
                    {t("openclawId.continue")}
                  </button>
                </openclaw-modal-actions>
              </Match>
              <Match when={step().kind === "intro" && (step() as Extract<Step, { kind: "intro" }>)}>
                {(intro) => (
                  <>
                    <div class="secret-reveal__body">
                      <p>{t("openclawId.introBody", { host: intro().preparation.hostname })}</p>
                      <p>{t("openclawId.introKit")}</p>
                    </div>
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button type="button" class="btn" onClick={() => finish(false)}>
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        class="btn primary"
                        autofocus
                        onClick={() => void createKit(intro().preparation)}
                      >
                        {t("openclawId.createKit")}
                      </button>
                    </openclaw-modal-actions>
                  </>
                )}
              </Match>
              <Match when={step().kind === "kit" && (step() as Extract<Step, { kind: "kit" }>)}>
                {(kitStep) => (
                  <>
                    <div class="secret-reveal__body">
                      <p>{t("openclawId.kitBody")}</p>
                    </div>
                    <div class="secret-reveal__value">
                      <code class="secret-reveal__code">{kitStep().kit.text}</code>
                      <CopyButton text={kitStep().kit.text} idleLabel={t("common.copy")} />
                    </div>
                    <p class="secret-reveal__note">
                      {t("openclawId.kitFingerprint", {
                        fingerprint: kitStep().kit.rootFingerprint,
                      })}
                    </p>
                    <div class="callout info secret-reveal__callout">
                      {t("openclawId.kitWarning")}
                    </div>
                    <button
                      type="button"
                      class="btn btn--sm"
                      onClick={() => downloadKit(kitStep().kit, kitStep().preparation.hostname)}
                    >
                      {t("openclawId.downloadKit")}
                    </button>
                    <SettingsToggleRow
                      title={t("openclawId.kitSaved")}
                      checked={saved()}
                      onChange={(next) => setSaved(next)}
                    />
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button type="button" class="btn" onClick={() => finish(false)}>
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        class="btn primary"
                        disabled={!saved()}
                        onClick={() => void link(kitStep().preparation)}
                      >
                        {t("openclawId.makeReachable")}
                      </button>
                    </openclaw-modal-actions>
                  </>
                )}
              </Match>
              <Match when={step().kind === "linking"}>
                <div class="secret-reveal__body" role="status">
                  <p>{t("openclawId.linking")}</p>
                </div>
              </Match>
              <Match when={step().kind === "done" && (step() as Extract<Step, { kind: "done" }>)}>
                {(done) => (
                  <>
                    <div class="secret-reveal__body">
                      <p>{t("openclawId.doneBody", { host: done().hostname })}</p>
                      <Show when={done().publication?.state !== "published"}>
                        <p>{t("openclawId.doneNotPublished")}</p>
                      </Show>
                    </div>
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button
                        type="button"
                        class="btn primary"
                        autofocus
                        onClick={() => finish(true)}
                      >
                        {t("openclawId.done")}
                      </button>
                    </openclaw-modal-actions>
                  </>
                )}
              </Match>
              <Match when={step().kind === "error" && (step() as Extract<Step, { kind: "error" }>)}>
                {(failed) => (
                  <>
                    <div class="callout danger" role="alert">
                      {failed().message}
                    </div>
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button type="button" class="btn" autofocus onClick={() => finish(false)}>
                        {t("common.close")}
                      </button>
                    </openclaw-modal-actions>
                  </>
                )}
              </Match>
            </Switch>
          </div>
        </openclaw-modal-dialog>
      );
    });
  });
}
