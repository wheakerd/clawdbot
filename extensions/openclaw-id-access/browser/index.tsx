/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import {
  defineControlUiPlugin,
  type ControlUiDisposer,
  type ControlUiHost,
  type ControlUiView,
} from "openclaw/plugin-sdk/control-ui";
import { PeoplePage } from "./people-page.js";
import type { StatusResult } from "./types.js";
import "./control-ui.css";

/** The page id the Control UI account menu opens ("People"). */
export const PEOPLE_PAGE_ID = "people";

const mountPeople: ControlUiView = (container, context) => {
  const dispose = render(() => <PeoplePage host={context.host} />, container);
  return { dispose };
};

// True when the Gateway has OpenClaw ID on (the Labs flag); false when off or unknown.
async function openClawIdEnabled(host: ControlUiHost): Promise<boolean> {
  if (!host.connection.connected) {
    return false;
  }
  try {
    const status = await host.request<StatusResult>("openclawId.status", {});
    return status.status.state !== "off";
  } catch {
    return false;
  }
}

/**
 * Registers the People page only while the OpenClaw ID flag is on,
 * and follows the flag as the connection changes.
 */
export default defineControlUiPlugin({
  id: "openclaw-id-access",
  activate(host) {
    let disposePage: ControlUiDisposer | undefined;
    let generation = 0;
    const sync = async () => {
      const id = ++generation;
      const enabled = await openClawIdEnabled(host);
      if (id !== generation || host.signal.aborted) {
        return;
      }
      if (enabled && !disposePage) {
        disposePage = host.ui.registerPage({
          id: PEOPLE_PAGE_ID,
          label: "People",
          mount: mountPeople,
        });
      } else if (!enabled && disposePage) {
        disposePage();
        disposePage = undefined;
      }
    };
    let connected = host.connection.connected;
    const unsubscribe = host.subscribe(() => {
      if (host.connection.connected !== connected) {
        connected = host.connection.connected;
        void sync();
      }
    });
    void sync();
    return () => {
      generation += 1;
      unsubscribe();
      disposePage?.();
    };
  },
});
