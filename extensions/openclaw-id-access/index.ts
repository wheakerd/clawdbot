import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/**
 * OpenClaw ID members and invites. The plugin only ships a Control UI page;
 * invites, approvals and removals are owner-signed statements it sends to the
 * Gateway's own openclawId.* methods, so it registers nothing on the Gateway.
 */
export default definePluginEntry({
  id: "openclaw-id-access",
  name: "OpenClaw ID members",
  description: "Invite people to this claw, approve their requests, and manage members.",
  register() {},
});
