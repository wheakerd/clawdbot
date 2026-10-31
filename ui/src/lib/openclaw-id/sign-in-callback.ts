// The OpenClaw ID sign-in popup lands here (<origin>/openclaw-id/callback). It
// hands the issuer's code and state to the Control UI tab that opened it by
// writing them to this origin's localStorage under the state (the opener hears
// a `storage` event and removes the entry; this works even when the issuer's
// pages cut window.opener), then closes. The code is useless without the
// Gateway's PKCE verifier, and the state ties it to the sign-in that tab started.
import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  OPENCLAW_ID_CALLBACK_KEY_PREFIX,
  OPENCLAW_ID_CALLBACK_PATH,
  type OpenClawIdCallbackMessage,
} from "./callback-contract.ts";

/** True when this document is the sign-in popup's return. */
export function isOpenClawIdCallbackPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "").endsWith(OPENCLAW_ID_CALLBACK_PATH);
}

/** Hands the callback's result to the opener tab and closes the popup. */
export function finishOpenClawIdCallback(): void {
  const params = new URLSearchParams(window.location.search);
  const message: OpenClawIdCallbackMessage = {
    state: params.get("state"),
    code: params.get("code"),
    error: params.get("error"),
  };
  if (message.state) {
    getSafeLocalStorage()?.setItem(
      `${OPENCLAW_ID_CALLBACK_KEY_PREFIX}${message.state}`,
      JSON.stringify(message),
    );
  }
  // Drop the code from the address bar and history before closing.
  window.history.replaceState(null, "", window.location.pathname);
  document.body.textContent = message.error
    ? "Sign-in was not completed. You can close this window."
    : "Signed in. You can close this window.";
  window.close();
}
