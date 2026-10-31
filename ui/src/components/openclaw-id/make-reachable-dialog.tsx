import "../../styles/secret-reveal.css";
import "../../styles/openclaw-id.css";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { requestOpenClawIdLinkCode } from "../../lib/openclaw-id/account.ts";
import { generateOwnerDeviceKey, saveOwnerDeviceKey } from "../../lib/openclaw-id/device-key.ts";
import {
  canStoreRecoveryKit,
  downloadRecoveryKit,
  printRecoveryKit,
  storeRecoveryKit,
  type RecoveryKitDetails,
} from "../../lib/openclaw-id/kit-export.ts";
import {
  LINK_STEPS,
  runLinkSteps,
  type LinkStep,
  type LinkStepState,
} from "../../lib/openclaw-id/link-steps.ts";
import { createOpenClawIdCeremony, linkCodePageUrl } from "../../lib/openclaw-id/link.ts";
import type {
  OpenClawIdLinkPreparation,
  OpenClawIdPublication,
  OpenClawIdSignedIn,
  OpenClawIdStatusResult,
} from "../../lib/openclaw-id/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { CopyButton } from "../solid/copy-button.tsx";
import { Icon } from "../solid/icon.tsx";
import { SettingsRow, SettingsToggleRow } from "../solid/settings-ui.tsx";
import { clawNameFromHostname } from "./claw-name.ts";

type Step =
  | { kind: "name" }
  | { kind: "ownerKey"; preparation: OpenClawIdLinkPreparation }
  | { kind: "kit"; preparation: OpenClawIdLinkPreparation; details: RecoveryKitDetails }
  | { kind: "linking"; hostname: string }
  | { kind: "done"; hostname: string; publication: OpenClawIdPublication | null }
  | { kind: "error"; message: string };

// Whether the claw's outbound relay connection is up (openclawId.status tunnel).
async function readRelayOnline(client: GatewayBrowserClient): Promise<boolean> {
  const result = await client.request<OpenClawIdStatusResult>("openclawId.status", {});
  const tunnel = result.status.tunnel;
  return result.status.state === "on" && tunnel?.state === "running" && tunnel.relayOnline === true;
}

// The dot of a linking step: waiting, running, done or a problem.
function stepMark(state: LinkStepState["state"]): string {
  return state === "done" ? "✓" : state === "running" ? "…" : state === "waiting" ? "○" : "!";
}

/** The address Discovery offers for a claw name (openclawId.authority check_name). */
type NameCheck = { name: string; accountTag: string; hostname: string; available: boolean };

// The name offered until the owner types one.
const DEFAULT_CLAW_NAME = "claw";

/**
 * "Make reachable" (spec section 4; onboarding mockup steps 5-8): the owner
 * names the claw (Discovery assigns "<name>-<account tag>.<loader domain>" for
 * the link code's account); reads what the owner key is; gets the recovery kit
 * and Continue unlocks only after a save action or the confirmation; then four
 * linking steps run in view: signing with the owner key, pinning it on the
 * claw, registration (possession proof and address reservation) and the relay
 * connection. Only signed statements reach the Gateway. Resolves true once linked.
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
          setStep({ kind: "ownerKey", preparation });
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
          const kit = await ceremony.createKit();
          const owner = params.signedIn?.email ?? params.signedIn?.name ?? null;
          setStep({
            kind: "kit",
            preparation,
            details: { kit, hostname: preparation.hostname, owner, createdAt: new Date() },
          });
        } catch (error) {
          setStep({ kind: "error", message: formatUiError(error) });
        }
      };
      const [linkStates, setLinkStates] = createSignal<Record<LinkStep, LinkStepState>>(
        Object.fromEntries(LINK_STEPS.map((id) => [id, { state: "waiting" }])) as Record<
          LinkStep,
          LinkStepState
        >,
      );
      const [kitNote, setKitNote] = createSignal<string | null>(null);
      // Marks the kit saved after a save action, as ticking the box does.
      const kitAction = async (action: () => boolean | Promise<boolean>) => {
        setKitNote(null);
        try {
          if (await action()) {
            setSaved(true);
          } else {
            setKitNote(t("openclawId.kitActionUnavailable"));
          }
        } catch (error) {
          setKitNote(t("openclawId.kitActionFailed", { error: formatUiError(error) }));
        }
      };
      // The four honest linking steps (lib/openclaw-id/link-steps.ts).
      const link = async (preparation: OpenClawIdLinkPreparation) => {
        setStep({ kind: "linking", hostname: preparation.hostname });
        const device = await generateOwnerDeviceKey();
        let signed: Awaited<ReturnType<typeof ceremony.sign>> | undefined;
        try {
          const publication = await runLinkSteps(
            {
              sign: async () => {
                signed = await ceremony.sign(
                  preparation,
                  device.signer,
                  t("openclawId.thisBrowser"),
                );
                // The owner key is no longer needed once the statements are signed.
                ceremony.discard();
              },
              commit: async () => {
                const result = await params.client.request<{
                  publication: OpenClawIdPublication | null;
                }>("openclawId.authority", {
                  action: "commit",
                  ...signed,
                  enrollmentCode: nameRequest().enrollmentCode,
                });
                await saveOwnerDeviceKey(preparation.claw_id, device.pair);
                return result.publication;
              },
              relayOnline: () => readRelayOnline(params.client),
            },
            {
              notPublished: (detail) => t("openclawId.stepNotPublished", { detail }),
              relayOffline: t("openclawId.stepRelayOffline"),
            },
            (id, state) => setLinkStates((current) => ({ ...current, [id]: state })),
          );
          setStep({ kind: "done", hostname: preparation.hostname, publication });
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
              <Match
                when={step().kind === "ownerKey" && (step() as Extract<Step, { kind: "ownerKey" }>)}
              >
                {(ownerKey) => (
                  <>
                    <div class="secret-reveal__body openclaw-id-owner-key">
                      <p class="openclaw-id-step__title">{t("openclawId.ownerKeyTitle")}</p>
                      <p>{t("openclawId.ownerKeyBody")}</p>
                      <dl class="openclaw-id-facts">
                        <dt>{t("openclawId.ownerKeyFactKey")}</dt>
                        <dd>{t("openclawId.ownerKeyFactKeyValue")}</dd>
                        <dt>{t("openclawId.ownerKeyFactBrowser")}</dt>
                        <dd>{t("openclawId.ownerKeyFactBrowserValue")}</dd>
                        <dt>
                          {t("openclawId.ownerKeyFactClaw", {
                            name: clawNameFromHostname(ownerKey().preparation.hostname),
                          })}
                        </dt>
                        <dd>{t("openclawId.ownerKeyFactClawValue")}</dd>
                      </dl>
                    </div>
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button type="button" class="btn" onClick={() => finish(false)}>
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        class="btn primary"
                        autofocus
                        onClick={() => void createKit(ownerKey().preparation)}
                      >
                        {t("openclawId.createOwnerKey")}
                      </button>
                    </openclaw-modal-actions>
                  </>
                )}
              </Match>
              <Match when={step().kind === "kit" && (step() as Extract<Step, { kind: "kit" }>)}>
                {(kitStep) => (
                  <>
                    <div class="secret-reveal__body">
                      <p class="openclaw-id-step__title">{t("openclawId.kitTitle")}</p>
                      <p>{t("openclawId.kitBody")}</p>
                    </div>
                    <div class="openclaw-id-kit" aria-label={t("openclawId.kitTitle")}>
                      <div class="openclaw-id-kit__head">{t("openclawId.kitHeading")}</div>
                      <code class="secret-reveal__code openclaw-id-kit__secret">
                        {kitStep().details.kit.text}
                      </code>
                      <dl class="openclaw-id-facts">
                        <dt>{t("openclawId.kitOwnerFingerprint")}</dt>
                        <dd>{kitStep().details.kit.rootFingerprint}</dd>
                        <Show when={kitStep().details.owner}>
                          {(owner) => (
                            <>
                              <dt>{t("openclawId.kitOwner")}</dt>
                              <dd>{owner()}</dd>
                            </>
                          )}
                        </Show>
                        <dt>{t("openclawId.kitClaw")}</dt>
                        <dd>https://{kitStep().details.hostname}</dd>
                        <dt>{t("openclawId.kitCreated")}</dt>
                        <dd>{kitStep().details.createdAt.toLocaleDateString()}</dd>
                      </dl>
                    </div>
                    <div class="callout info secret-reveal__callout">
                      {t("openclawId.kitWarning")}
                    </div>
                    <div class="openclaw-id-kit__actions">
                      <button
                        type="button"
                        class="btn btn--sm"
                        onClick={() =>
                          void kitAction(() => {
                            downloadRecoveryKit(kitStep().details);
                            return true;
                          })
                        }
                      >
                        {t("openclawId.downloadKit")}
                      </button>
                      <button
                        type="button"
                        class="btn btn--sm"
                        onClick={() => void kitAction(() => printRecoveryKit(kitStep().details))}
                      >
                        {t("openclawId.printKit")}
                      </button>
                      <Show when={canStoreRecoveryKit()}>
                        <button
                          type="button"
                          class="btn btn--sm"
                          onClick={() => void kitAction(() => storeRecoveryKit(kitStep().details))}
                        >
                          {t("openclawId.storeKit")}
                        </button>
                      </Show>
                      <CopyButton text={kitStep().details.kit.text} idleLabel={t("common.copy")} />
                    </div>
                    <Show when={kitNote()}>
                      {(note) => (
                        <p class="secret-reveal__note" role="status">
                          {note()}
                        </p>
                      )}
                    </Show>
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
                        {t("openclawId.continue")}
                      </button>
                    </openclaw-modal-actions>
                  </>
                )}
              </Match>
              <Match
                when={step().kind === "linking" && (step() as Extract<Step, { kind: "linking" }>)}
              >
                {(linking) => (
                  <div class="secret-reveal__body" role="status">
                    <p class="openclaw-id-step__title">
                      {t("openclawId.linkingTitle", {
                        name: clawNameFromHostname(linking().hostname),
                      })}
                    </p>
                    <ol class="openclaw-id-steps">
                      <For each={LINK_STEPS}>
                        {(id) => {
                          const current = () => linkStates()[id];
                          return (
                            <li class={`openclaw-id-steps__item is-${current().state}`}>
                              <span class="openclaw-id-steps__mark" aria-hidden="true">
                                {stepMark(current().state)}
                              </span>
                              <div>
                                {t(`openclawId.step_${id}`, {
                                  name: clawNameFromHostname(linking().hostname),
                                  host: linking().hostname,
                                })}
                                <small>
                                  {"message" in current()
                                    ? (current() as { message: string }).message
                                    : t(`openclawId.step_${id}_hint`)}
                                </small>
                              </div>
                            </li>
                          );
                        }}
                      </For>
                    </ol>
                  </div>
                )}
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
