/** @jsxImportSource @solidjs/web */
// The People page: invite someone, approve or deny their request, see who is
// active and what they are running, and remove members. Every change is a
// statement this browser's owner device signs and sends straight to the
// Gateway (openclawId.authority); everything shown is read from the Gateway.
// Owner devices and the recovery kit live in the account menu, not here.
import {
  displayFingerprint,
  fingerprint,
  type MemberRole,
  type PublicKeyText,
} from "@openclaw/openclaw-id-protocol";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Show, untrack } from "solid-js";
import { createInvite, decideInvite, removeMember } from "./invites.js";
import { thisOwnerDevice } from "./owner-signing.js";
import { memberName, removalNote } from "./people-format.js";
import { InviteForm, Members, PendingRequests } from "./people-sections.js";
import type { Invite, Link, Member, StatusResult } from "./types.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Display fingerprints of the devices pending requests come from, so the owner
// can compare them with what the invitee's screen shows.
async function pendingFingerprints(invites: Invite[]): Promise<ReadonlyMap<string, string>> {
  const keys = invites.flatMap((invite) => (invite.pending ? [invite.pending.devicePub] : []));
  const entries = await Promise.all(
    keys.map(async (key) => {
      try {
        return [key, displayFingerprint(await fingerprint(key as PublicKeyText))] as const;
      } catch {
        return undefined;
      }
    }),
  );
  return new Map(entries.filter((entry) => entry !== undefined));
}

// The title the host shows for a session, if the session is in its roster.
function sessionTitleFrom(host: ControlUiHost) {
  return (sessionKey: string): string | undefined => {
    const key = host.sessions.normalizeKey(sessionKey);
    const row = host.sessions.rows.find((candidate) => candidate.key === key);
    return row?.derivedTitle || row?.displayName || row?.label || undefined;
  };
}

/** The People page for one Control UI host. */
export function PeoplePage(props: { host: ControlUiHost }) {
  // The host is fixed for the page's lifetime.
  const host = untrack(() => props.host);
  const [state, setState] = createSignal<StatusResult | null>(null);
  const [ownDevicePub, setOwnDevicePub] = createSignal<string | null>(null);
  const [fingerprints, setFingerprints] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

  // Reads link state and which listed owner device (if any) is this browser.
  const refresh = async () => {
    try {
      const next = await host.request<StatusResult>("openclawId.status", {});
      const own = await thisOwnerDevice(next.link).catch(() => undefined);
      setOwnDevicePub(own?.devicePub ?? null);
      setFingerprints(await pendingFingerprints(next.link.invites ?? []));
      setNowMs(Date.now());
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
    setNotice(null);
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

  const remove = (member: Member) =>
    void run(async (link) => {
      const removal = await removeMember(host.request, link, member.accountId);
      setNotice(removalNote(memberName(member), removal));
    });

  const canManage = () => Boolean(ownDevicePub()) && host.connection.canAdmin && !busy();
  void refresh();

  return (
    <section class="ocid-access">
      <header class="ocid-access__header">
        <div>
          <h1>People</h1>
          <Show when={state()?.link.hostname}>
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
      <Show when={notice()}>
        {(message) => (
          <div class="callout success ocid-access__notice" role="status">
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
                  This browser is not an owner device for this claw, so it can only view people. Use
                  an owner device to invite, approve or remove.
                </div>
              </Show>
              <PendingRequests
                invites={(current().link.invites ?? []).filter((i) => i.status === "pending")}
                fingerprints={fingerprints()}
                disabled={!canManage()}
                locale={host.locale}
                onDecide={(invite, approve) =>
                  void run((link) => decideInvite(host.request, link, invite, approve))
                }
              />
              <Members
                members={current().link.members ?? []}
                invites={current().link.invites ?? []}
                ownerDevices={current().link.ownerDevices?.length ?? 0}
                disabled={!canManage()}
                locale={host.locale}
                nowMs={nowMs()}
                sessionTitle={sessionTitleFrom(host)}
                onRemove={remove}
              />
              <InviteForm
                disabled={!canManage()}
                locale={host.locale}
                onCreate={(email, role: MemberRole) =>
                  run((link) => createInvite(host.request, link, email, role))
                }
              />
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
}
