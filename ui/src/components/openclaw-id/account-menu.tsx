// The OpenClaw ID section of the sidebar account (identity) menu. It appears
// only while the Labs flag (gateway.openclawId.enabled) is on: Sign in with
// OpenClaw ID, then the account with Make reachable, Members & invites (the
// openclaw-id-access plugin page) and Sign out. The link-code path of Make
// reachable stays available when signed out.
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

registerEnglishCatalog(registerOpenClawIdEnglish);

/** The bundled plugin and page that own invites, requests, members and owner devices. */
export const OPENCLAW_ID_MEMBERS_PAGE = { pluginId: "openclaw-id-access", id: "members" } as const;

const VALUE_PREFIX = "openclaw-id:";
const SIGN_IN = `${VALUE_PREFIX}sign-in`;
const MAKE_REACHABLE = `${VALUE_PREFIX}make-reachable`;
const MEMBERS = `${VALUE_PREFIX}members`;
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

/** Menu entries for the OpenClaw ID section; empty while the flag is off. */
export function openClawIdMenuEntries(status: OpenClawIdStatusResult | null): MenuEntry[] {
  if (!status) {
    return [];
  }
  const account = openClawIdAccount();
  const title: MenuEntry = {
    kind: "content",
    id: "openclaw-id-title",
    content: <div class="sidebar-customize-menu__title">{t("openclawId.menuTitle")}</div>,
  };
  const items: MenuEntry[] = [title];
  if (account) {
    const name = account.email ?? account.name ?? account.sub;
    items.push(
      renderSidebarMenuAction(ACCOUNT, t("openclawId.signedIn", { account: name }), "key", {
        disabled: true,
        className: "sidebar-openclaw-id__account",
      }),
    );
  } else {
    const blocker = signInBlocker(status);
    items.push(
      renderSidebarMenuAction(SIGN_IN, t("openclawId.signIn"), "key", {
        disabled: Boolean(blocker),
        title: blocker,
      }),
    );
  }
  if (status.link.linked) {
    const reachable = t("openclawId.reachableAt", { host: status.link.hostname ?? "" });
    items.push(renderSidebarMenuAction(MAKE_REACHABLE, reachable, "radio", { disabled: true }));
  } else {
    const blocker = makeReachableBlocker(status);
    items.push(
      renderSidebarMenuAction(MAKE_REACHABLE, t("openclawId.makeReachable"), "radio", {
        disabled: Boolean(blocker),
        title: blocker,
      }),
    );
  }
  items.push(renderSidebarMenuAction(MEMBERS, t("openclawId.members"), "users"));
  if (account) {
    items.push(renderSidebarMenuAction(SIGN_OUT, t("openclawId.signOut"), "x"));
  }
  items.push({
    kind: "content",
    id: "openclaw-id-separator",
    content: <div class="sidebar-customize-menu__separator" role="separator" />,
  });
  return items;
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
  if (value === MEMBERS) {
    context.onNavigate("plugin", pluginTabLocation(OPENCLAW_ID_MEMBERS_PAGE, context.basePath));
  } else if (value === SIGN_OUT) {
    signOutOfOpenClawId();
  } else if (value === SIGN_IN && client) {
    signInWithOpenClawId({ client, basePath: context.basePath }).then(
      (signedIn) =>
        showToast({
          message: t("openclawId.signedIn", {
            account: signedIn.email ?? signedIn.name ?? signedIn.sub,
          }),
        }),
      (error: unknown) =>
        showToast({
          message: t("openclawId.signInFailed", { error: formatUiError(error) }),
          durationMs: 12_000,
        }),
    );
  } else if (value === MAKE_REACHABLE && client && status?.services.loaderDomain) {
    const loaderDomain = status.services.loaderDomain;
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
  return true;
}
