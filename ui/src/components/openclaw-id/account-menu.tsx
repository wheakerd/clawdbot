// The OpenClaw ID section of the sidebar account (identity) menu. It appears
// only while the Labs flag (gateway.openclawId.enabled) is on and follows the
// onboarding mockup (steps 2, 4 and 9): Sign in with OpenClaw ID, the account,
// Make reachable or the linked address, People (the openclaw-id-access plugin
// page), Your devices (owner devices, revoke) and Sign out. The link-code path
// of Make reachable stays available when signed out.
import { createSignal } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { pluginTabLocation } from "../../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../../app/context.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  openClawIdAccount,
  signInWithOpenClawId,
  signOutOfOpenClawId,
} from "../../lib/openclaw-id/account.ts";
import type { OpenClawIdStatusResult } from "../../lib/openclaw-id/types.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import { renderSidebarMenuAction } from "../app-sidebar-dropdown.tsx";
import type { MenuEntry } from "../solid/menu.tsx";
import { clawNameFromHostname } from "./claw-name.ts";

registerEnglishCatalog(registerOpenClawIdEnglish);

/** The bundled plugin page ("People") for invites, requests and members. */
export const OPENCLAW_ID_PEOPLE_PAGE = { pluginId: "openclaw-id-access", id: "people" } as const;

const VALUE_PREFIX = "openclaw-id:";
const SIGN_IN = `${VALUE_PREFIX}sign-in`;
const MAKE_REACHABLE = `${VALUE_PREFIX}make-reachable`;
const PEOPLE = `${VALUE_PREFIX}people`;
const DEVICES = `${VALUE_PREFIX}devices`;
const SIGN_OUT = `${VALUE_PREFIX}sign-out`;
const ACCOUNT = `${VALUE_PREFIX}account`;

/**
 * Reads `openclawId.status` once for an open menu. Resolves to null while the
 * flag is off, on Gateways without OpenClaw ID, or when the read fails.
 */
export function createOpenClawIdMenuStatus(client: GatewayBrowserClient | null | undefined) {
  const [status, setStatus] = createSignal<OpenClawIdStatusResult | null>(null);
  if (client) {
    void client
      .request<OpenClawIdStatusResult>("openclawId.status", {})
      .then((result) => setStatus(result.status.state === "off" ? null : result))
      .catch(() => setStatus(null));
  }
  return status;
}

// Why sign-in is unavailable here, or undefined when it can start.
function signInBlocker(status: OpenClawIdStatusResult): string | undefined {
  if (status.channel !== "local_operator") {
    return t("openclawId.signInLocalOnly");
  }
  return status.services.clientId ? undefined : t("openclawId.signInUnconfigured");
}

// Why Make reachable is unavailable here, or undefined when it can start.
function makeReachableBlocker(status: OpenClawIdStatusResult): string | undefined {
  if (status.channel !== "local_operator") {
    return t("openclawId.makeReachableLocalOnly");
  }
  return status.services.loaderDomain ? undefined : t("openclawId.needsLoaderDomain");
}

// A non-interactive line of the section (status text, not a command).
function infoLine(id: string, text: string, className = "sidebar-openclaw-id__info"): MenuEntry {
  return {
    kind: "content",
    id: `openclaw-id-${id}`,
    content: <div class={`sidebar-customize-menu__title ${className}`}>{text}</div>,
  };
}

// Signed-out, signed-in or linked account lines (link-flow mockup steps 2 and 9).
function accountEntries(status: OpenClawIdStatusResult): MenuEntry[] {
  const account = openClawIdAccount();
  if (account) {
    const name = account.email ?? account.name ?? account.sub;
    return [
      renderSidebarMenuAction(ACCOUNT, t("openclawId.signedIn", { account: name }), "key", {
        disabled: true,
        className: "sidebar-openclaw-id__account",
      }),
    ];
  }
  const blocker = signInBlocker(status);
  return [
    infoLine("local-operator", t("openclawId.localOperator")),
    renderSidebarMenuAction(SIGN_IN, t("openclawId.signIn"), "key", {
      disabled: Boolean(blocker),
      title: blocker,
    }),
    infoLine("stays-local", t("openclawId.staysLocal")),
  ];
}

// Reachability lines: the linked address and transport, or the Make reachable command.
function reachabilityEntries(status: OpenClawIdStatusResult): MenuEntry[] {
  if (status.link.linked && status.link.hostname) {
    const host = status.link.hostname;
    return [
      renderSidebarMenuAction(
        MAKE_REACHABLE,
        t("openclawId.isReachable", { name: clawNameFromHostname(host) }),
        "radio",
        { disabled: true, className: "sidebar-openclaw-id__reachable" },
      ),
      infoLine("address", `https://${host}`),
      infoLine("encrypted", t("openclawId.encrypted")),
      renderSidebarMenuAction(DEVICES, t("openclawId.yourDevices"), "key"),
    ];
  }
  const blocker = makeReachableBlocker(status);
  return [
    renderSidebarMenuAction(MAKE_REACHABLE, t("openclawId.makeReachable"), "radio", {
      disabled: Boolean(blocker),
      title: blocker,
    }),
  ];
}

/**
 * Menu entries for the OpenClaw ID section; empty while the flag is off.
 * Signed out: local operator, Sign in, "conversations stay on this computer".
 * Signed in: the account. Then Make reachable, or once linked the address and
 * transport and Your devices; People (the openclaw-id-access plugin page);
 * Sign out. Unlink is not offered yet (OCF-281 needs a Discovery endpoint).
 */
export function openClawIdMenuEntries(status: OpenClawIdStatusResult | null): MenuEntry[] {
  if (!status) {
    return [];
  }
  return [
    infoLine("title", t("openclawId.menuTitle"), "sidebar-openclaw-id__title"),
    ...accountEntries(status),
    ...reachabilityEntries(status),
    renderSidebarMenuAction(PEOPLE, t("openclawId.people"), "users"),
    ...(openClawIdAccount()
      ? [renderSidebarMenuAction(SIGN_OUT, t("openclawId.signOut"), "x")]
      : []),
    {
      kind: "content",
      id: "openclaw-id-separator",
      content: <div class="sidebar-customize-menu__separator" role="separator" />,
    },
  ];
}

// Opens Make reachable, with the link code taken from the account when signed in.
function startMakeReachable(client: GatewayBrowserClient, loaderDomain: string) {
  void import("./make-reachable-dialog.tsx")
    .then(({ showMakeReachableDialog }) =>
      showMakeReachableDialog({ client, loaderDomain, signedIn: openClawIdAccount() }),
    )
    .catch((error: unknown) =>
      showToast({
        message: t("openclawId.makeReachableFailed", { error: formatUiError(error) }),
        durationMs: 12_000,
      }),
    );
}

// After sign-in on an unlinked claw: offer Make reachable (dismissing is "Not now").
function offerMakeReachable(
  client: GatewayBrowserClient,
  status: OpenClawIdStatusResult | null,
  account: string,
) {
  const loaderDomain = status?.services.loaderDomain;
  if (!status || status.link.linked || !loaderDomain || makeReachableBlocker(status)) {
    showToast({ message: t("openclawId.signedIn", { account }) });
    return;
  }
  showToast({
    message: t("openclawId.reachOffer", { account }),
    actionLabel: t("openclawId.makeReachable"),
    onAction: () => startMakeReachable(client, loaderDomain),
    durationMs: 30_000,
  });
}

/**
 * Runs an OpenClaw ID menu command. Returns false for values it does not own.
 * Call synchronously from the menu selection so the sign-in popup keeps the
 * click's user activation.
 */
export function selectOpenClawIdMenuValue(
  value: string,
  context: {
    status: OpenClawIdStatusResult | null;
    client: GatewayBrowserClient | null | undefined;
    basePath: string;
    onNavigate: (routeId: "plugin", options?: ApplicationNavigationOptions) => void;
  },
): boolean {
  if (!value.startsWith(VALUE_PREFIX)) {
    return false;
  }
  const { client, status } = context;
  if (value === PEOPLE) {
    context.onNavigate("plugin", pluginTabLocation(OPENCLAW_ID_PEOPLE_PAGE, context.basePath));
  } else if (value === DEVICES && client) {
    void import("./owner-devices-dialog.tsx")
      .then(({ showOwnerDevicesDialog }) => showOwnerDevicesDialog({ client }))
      .catch((error: unknown) =>
        showToast({
          message: t("openclawId.devicesFailed", { error: formatUiError(error) }),
          durationMs: 12_000,
        }),
      );
  } else if (value === SIGN_OUT) {
    signOutOfOpenClawId();
  } else if (value === SIGN_IN && client) {
    signInWithOpenClawId({ client, basePath: context.basePath }).then(
      (signedIn) =>
        offerMakeReachable(client, status, signedIn.email ?? signedIn.name ?? signedIn.sub),
      (error: unknown) =>
        showToast({
          message: t("openclawId.signInFailed", { error: formatUiError(error) }),
          durationMs: 12_000,
        }),
    );
  } else if (value === MAKE_REACHABLE && client && status?.services.loaderDomain) {
    startMakeReachable(client, status.services.loaderDomain);
  }
  return true;
}
