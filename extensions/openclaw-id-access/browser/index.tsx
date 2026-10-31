/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import { defineControlUiPlugin, type ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { MembersPage } from "./members-page.js";
import "./control-ui.css";

/** The page id the Control UI account menu opens ("Members & invites"). */
export const MEMBERS_PAGE_ID = "members";

const mountMembers: ControlUiView = (container, context) => {
  const dispose = render(() => <MembersPage host={context.host} />, container);
  return { dispose };
};

export default defineControlUiPlugin({
  id: "openclaw-id-access",
  activate(host) {
    return host.ui.registerPage({
      id: MEMBERS_PAGE_ID,
      label: "Members & invites",
      mount: mountMembers,
    });
  },
});
