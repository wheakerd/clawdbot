/** @jsxImportSource @solidjs/web */
import {
  displayFingerprint,
  fingerprint,
  type MemberRole,
  type PublicKeyText,
} from "@openclaw/openclaw-id-protocol";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, For, Show, untrack } from "solid-js";
import { createInvite, decideInvite, removeMember, type CreatedInvite } from "./invites.js";
import { signOwnerDeviceRevocation, thisOwnerDevice } from "./owner-signing.js";
import type { Invite, Link, OwnerDevice, StatusResult } from "./types.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatDay(seconds: number, locale: string): string {
  return new Date(seconds * 1000).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A short, readable form of a device key for the owner device list.
function shortKey(key: string): string {
  const body = key.slice(key.indexOf(":") + 1);
  return `${body.slice(0, 6)}…${body.slice(-4)}`;
}

// Display fingerprints of the devices pending requests come from, so the owner can
// compare them with what the invitee's screen shows.
async function pendingFingerprints(invites: Invite[]): Promise<ReadonlyMap<string, string>> {
  const keys = invites.flatMap((invite) => (invite.pending ? [invite.pending.devicePub] : []));
  const entries = await Promise.all(
    keys.map(async (key) => {
      try {
        return [key, displayFingerprint(await fingerprint(key as PublicKeyText))] as const;
      } catch {
        return [key, shortKey(key)] as const;
      }
    }),
  );
  return new Map(entries);
}

/** Invite form; shows the created link once with a copy button. */
function InviteForm(props: {
  disabled: boolean;
  locale: string;
  onCreate: (email: string, role: MemberRole) => Promise<CreatedInvite | undefined>;
}) {
  const [email, setEmail] = createSignal("");
  const [role, setRole] = createSignal<MemberRole>("operator");
  const [created, setCreated] = createSignal<CreatedInvite | null>(null);
  const [copied, setCopied] = createSignal(false);
  const submit = async () => {
    const made = await props.onCreate(email().trim().toLowerCase(), role());
    if (made) {
      setCreated(made);
      setCopied(false);
      setEmail("");
    }
  };
  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
  };
  return (
    <section class="ocid-access__section" aria-labelledby="ocid-access-invite">
      <h2 id="ocid-access-invite">Invite someone</h2>
      <p class="ocid-access__hint">
        Create a link and send it to them yourself. They sign in with OpenClaw ID, then you approve
        them here. Invites expire after 7 days.
      </p>
      <div class="ocid-access__form">
        <input
          class="settings-input"
          type="email"
          aria-label="Email address to invite"
          placeholder="name@example.com"
          autocomplete="off"
          spellcheck="false"
          value={email()}
          onInput={(event) => setEmail(event.currentTarget.value)}
        />
        <select
          class="settings-input"
          aria-label="Role"
          value={role()}
          onChange={(event) => setRole(event.currentTarget.value as MemberRole)}
        >
          <option value="operator">Operator</option>
          <option value="viewer">Viewer</option>
        </select>
        <button
          type="button"
          class="btn primary btn--sm"
          disabled={props.disabled || !EMAIL.test(email().trim())}
          onClick={() => void submit()}
        >
          Create invite link
        </button>
      </div>
      <Show when={created()}>
        {(made) => (
          <div class="ocid-access__link" role="status">
            <div>
              Invite link for {made().email} · expires {formatDay(made().expiresAt, props.locale)}
            </div>
            <code class="ocid-access__url">{made().url}</code>
            <button type="button" class="btn btn--sm" onClick={() => void copy(made().url)}>
              {copied() ? "Copied" : "Copy link"}
            </button>
            <p class="ocid-access__hint">
              Send it privately. Anyone with the link can ask to join; nobody gets in until you
              approve.
            </p>
          </div>
        )}
      </Show>
    </section>
  );
}

/** Pending redemptions with approve and deny. */
function PendingRequests(props: {
  invites: Invite[];
  /** Display fingerprint by device key, for the device each request comes from. */
  fingerprints: ReadonlyMap<string, string>;
  disabled: boolean;
  locale: string;
  onDecide: (invite: Invite, approve: boolean) => void;
}) {
  return (
    <section class="ocid-access__section" aria-labelledby="ocid-access-pending">
      <h2 id="ocid-access-pending">Pending requests</h2>
      <Show
        when={props.invites.length > 0}
        fallback={<p class="ocid-access__empty">No one is waiting for approval.</p>}
      >
        <ul class="ocid-access__list">
          <For each={props.invites}>
            {(invite) => {
              const pending = () => invite.pending!;
              const who = () =>
                pending().reported.displayName || pending().reported.email || pending().accountId;
              return (
                <li class="ocid-access__row">
                  <div>
                    <div class="ocid-access__title">
                      {who()} wants to join as {invite.role}
                    </div>
                    <div class="ocid-access__hint">
                      {pending().reported.email ?? pending().accountId} · device{" "}
                      {props.fingerprints.get(pending().devicePub) ?? shortKey(pending().devicePub)}{" "}
                      · {pending().reported.locationHint ?? "location unknown"} · as reported by
                      OpenClaw ID · decide by {formatDay(pending().decideBy, props.locale)}
                    </div>
                  </div>
                  <div class="ocid-access__actions">
                    <button
                      type="button"
                      class="btn btn--sm danger"
                      disabled={props.disabled}
                      onClick={() => props.onDecide(invite, false)}
                    >
                      Deny
                    </button>
                    <button
                      type="button"
                      class="btn primary btn--sm"
                      disabled={props.disabled}
                      onClick={() => props.onDecide(invite, true)}
                    >
                      Approve
                    </button>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** Members and open invites; members can be removed. */
function Members(props: {
  link: Link;
  disabled: boolean;
  locale: string;
  onRemove: (accountId: string) => void;
}) {
  const open = () => (props.link.invites ?? []).filter((invite) => invite.status === "open");
  return (
    <section class="ocid-access__section" aria-labelledby="ocid-access-members">
      <h2 id="ocid-access-members">Members</h2>
      <Show
        when={(props.link.members ?? []).length + open().length > 0}
        fallback={<p class="ocid-access__empty">No members yet.</p>}
      >
        <ul class="ocid-access__list">
          <For each={props.link.members ?? []}>
            {(member) => (
              <li class="ocid-access__row">
                <div>
                  <div class="ocid-access__title">{member.email ?? member.accountId}</div>
                  <div class="ocid-access__hint">
                    {member.role} · {member.peerKeys.length} devices
                  </div>
                </div>
                <button
                  type="button"
                  class="btn btn--sm danger"
                  disabled={props.disabled}
                  onClick={() => props.onRemove(member.accountId)}
                >
                  Remove
                </button>
              </li>
            )}
          </For>
          <For each={open()}>
            {(invite) => (
              <li class="ocid-access__row">
                <div>
                  <div class="ocid-access__title">{invite.label}</div>
                  <div class="ocid-access__hint">
                    {invite.role} · invited · expires {formatDay(invite.expiresAt, props.locale)}
                  </div>
                </div>
                <span class="ocid-access__badge">Invited</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** Active owner devices; another device can be revoked with this browser's owner key. */
function OwnerDevices(props: {
  devices: OwnerDevice[];
  ownDevicePub: string | null;
  disabled: boolean;
  onRevoke: (device: OwnerDevice) => void;
}) {
  return (
    <section class="ocid-access__section" aria-labelledby="ocid-access-owners">
      <h2 id="ocid-access-owners">Owner devices</h2>
      <p class="ocid-access__hint">
        Browsers that can manage this claw. Revoking one disconnects it at once; it can come back
        only with your recovery kit or another owner's approval.
      </p>
      <ul class="ocid-access__list">
        <For each={props.devices}>
          {(device) => (
            <li class="ocid-access__row">
              <div>
                <div class="ocid-access__title">
                  {device.label}
                  <Show when={device.devicePub === props.ownDevicePub}>
                    <span class="ocid-access__badge">This browser</span>
                  </Show>
                </div>
                <div class="ocid-access__hint">
                  {shortKey(device.devicePub)} ·{" "}
                  {device.peerKeys.length ? "remote browser" : "this machine"}
                </div>
              </div>
              <Show when={device.devicePub !== props.ownDevicePub}>
                <button
                  type="button"
                  class="btn btn--sm danger"
                  disabled={props.disabled}
                  onClick={() => props.onRevoke(device)}
                >
                  Revoke
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

/**
 * The "Devices & people" page: invite someone, approve or deny their request,
 * manage members and owner devices. Every change is a statement this browser's
 * owner device signs and sends straight to the Gateway (openclawId.authority).
 */
export function MembersPage(props: { host: ControlUiHost }) {
  // The host is fixed for the page's lifetime.
  const host = untrack(() => props.host);
  const [state, setState] = createSignal<StatusResult | null>(null);
  const [ownDevicePub, setOwnDevicePub] = createSignal<string | null>(null);
  const [fingerprints, setFingerprints] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Reads link state and which listed owner device (if any) is this browser.
  const refresh = async () => {
    try {
      const next = await host.request<StatusResult>("openclawId.status", {});
      const own = await thisOwnerDevice(next.link).catch(() => undefined);
      setOwnDevicePub(own?.devicePub ?? null);
      setFingerprints(await pendingFingerprints(next.link.invites ?? []));
      setState(next);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  // Runs one owner action, then refreshes; failures show above the sections.
  const run = async <T,>(action: (link: Link) => Promise<T>): Promise<T | undefined> => {
    const link = state()?.link;
    if (!link || busy()) {
      return undefined;
    }
    setBusy(true);
    setError(null);
    try {
      return await action(link);
    } catch (failure) {
      setError(errorText(failure));
      return undefined;
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const canManage = () => Boolean(ownDevicePub()) && host.connection.canAdmin && !busy();
  const link = () => state()?.link;
  void refresh();

  return (
    <section class="ocid-access">
      <header class="ocid-access__header">
        <div>
          <h1>Devices & people</h1>
          <Show when={link()?.hostname}>
            {(hostname) => <p class="ocid-access__hint">https://{hostname()}</p>}
          </Show>
        </div>
        <button type="button" class="btn btn--sm" disabled={busy()} onClick={() => void refresh()}>
          Refresh
        </button>
      </header>
      <Show when={error()}>
        {(message) => (
          <div class="callout danger" role="alert">
            {message()}
          </div>
        )}
      </Show>
      <Show when={state()}>
        {(current) => (
          <Show
            when={current().status.state !== "off"}
            fallback={
              <p class="ocid-access__empty">
                OpenClaw ID is off. Turn it on in Settings → Labs, then sign in from the account
                menu.
              </p>
            }
          >
            <Show
              when={current().link.linked}
              fallback={
                <p class="ocid-access__empty">
                  This claw is not reachable yet. Open the account menu on this machine's Control UI
                  and choose Make reachable.
                </p>
              }
            >
              <Show when={!ownDevicePub()}>
                <div class="callout info" role="note">
                  This browser is not an owner device for this claw, so it can only view members.
                  Use an owner device to invite, approve or remove.
                </div>
              </Show>
              <PendingRequests
                invites={(current().link.invites ?? []).filter((i) => i.status === "pending")}
                fingerprints={fingerprints()}
                disabled={!canManage()}
                locale={host.locale}
                onDecide={(invite, approve) =>
                  void run((linkState) => decideInvite(host.request, linkState, invite, approve))
                }
              />
              <InviteForm
                disabled={!canManage()}
                locale={host.locale}
                onCreate={(email, role) =>
                  run((linkState) => createInvite(host.request, linkState, email, role))
                }
              />
              <Members
                link={current().link}
                disabled={!canManage()}
                locale={host.locale}
                onRemove={(accountId) =>
                  void run((linkState) => removeMember(host.request, linkState, accountId))
                }
              />
              <OwnerDevices
                devices={current().link.ownerDevices ?? []}
                ownDevicePub={ownDevicePub()}
                disabled={!canManage()}
                onRevoke={(device) =>
                  void run(async (linkState) => {
                    const statement = await signOwnerDeviceRevocation(linkState, device);
                    await host.request("openclawId.authority", { action: "submit", statement });
                  })
                }
              />
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
}
