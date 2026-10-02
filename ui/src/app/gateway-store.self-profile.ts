import type { UserProfile, UsersSelfResult } from "../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { userProfileAvatarUrl } from "../pages/profile/profile-avatar-url.ts";
import type { ApplicationGatewayConnection, ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorReadAccess, hasOperatorSelfReadAccess } from "./operator-access.ts";
import {
  readPresenceEntries,
  resolveSelfPresenceUser,
  sameSelfUser,
  type AuthenticatedUser,
} from "./user-profile.ts";

export function createGatewaySelfProfile(options: {
  getSnapshot: () => ApplicationGatewaySnapshot;
  getConnection: () => ApplicationGatewayConnection;
  publish: (selfUser: AuthenticatedUser | null) => void;
  resourceBasePath?: string;
}) {
  let selfProfileRequest: {
    promise: Promise<UserProfile | null>;
    publish: boolean;
  } | null = null;
  let fallbackAvatarUrl: string | undefined;
  const loadSelfProfile = (readOptions?: { publish?: boolean }): Promise<UserProfile | null> => {
    const requestClient = options.getSnapshot().client;
    const hello = options.getSnapshot().hello;
    if (
      !requestClient ||
      !hello ||
      options.getSnapshot().phase !== "connected" ||
      !hasOperatorSelfReadAccess(hello.auth ?? null)
    ) {
      return Promise.resolve(null);
    }
    // Foreground loads joining a background read retain their publication intent.
    if (selfProfileRequest) {
      selfProfileRequest.publish ||= readOptions?.publish !== false;
      return selfProfileRequest.promise;
    }
    const selfAtStart = options.getSnapshot().selfUser;
    const isCurrent = (): boolean =>
      options.getSnapshot().client === requestClient &&
      options.getSnapshot().hello === hello &&
      options.getSnapshot().phase === "connected" &&
      selfProfileRequest?.promise === request;
    const request: Promise<UserProfile | null> = requestClient
      .request<UsersSelfResult>("users.self", {})
      .then(({ profile }) => profile)
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return null;
        }
        if (error instanceof GatewayRequestError && error.code === "FORBIDDEN") {
          return null;
        }
        throw error;
      })
      .then((profile) => {
        if (!isCurrent()) {
          return null;
        }
        if (pending.publish) {
          if (profile) {
            const currentSelf = options.getSnapshot().selfUser;
            const currentProfile = currentSelf?.id === profile.id ? currentSelf : null;
            const newerDisplay =
              currentProfile && currentSelf !== selfAtStart ? currentProfile : null;
            const presence = resolveSelfPresenceUser(
              readPresenceEntries(hello.snapshot) ?? [],
              requestClient.instanceId,
            );
            const previousAvatar =
              currentProfile?.avatarUrl ??
              (presence?.id === profile.id ? presence.avatarUrl : undefined);
            const fallback =
              userProfileAvatarUrl(
                options.getConnection().gatewayUrl,
                profile.id,
                profile.updatedAt,
                options.resourceBasePath,
              ) ?? undefined;
            const avatarUrl =
              previousAvatar && previousAvatar !== fallbackAvatarUrl ? previousAvatar : fallback;
            fallbackAvatarUrl = fallback;
            const selfUser = {
              id: profile.id,
              identity: { type: "profile" as const, id: profile.id },
              name: newerDisplay ? newerDisplay.name : (profile.displayName ?? undefined),
              email: profile.emails[0],
              // Refresh our timestamp fallback without replacing a precise presence/upload revision.
              avatarUrl,
            };
            if (!sameSelfUser(options.getSnapshot().selfUser, selfUser)) {
              options.publish(selfUser);
            }
          } else {
            options.publish(null);
          }
        }
        // Publication and retirement are atomic so late callers cannot lose their intent.
        // Publishing identity can synchronously stop or replace the connection.
        const result = isCurrent() ? profile : null;
        if (selfProfileRequest?.promise === request) {
          selfProfileRequest = null;
        }
        return result;
      })
      .finally(() => {
        if (selfProfileRequest?.promise === request) {
          selfProfileRequest = null;
        }
      });
    const pending = { promise: request, publish: readOptions?.publish !== false };
    selfProfileRequest = pending;
    return request;
  };
  return {
    load: loadSelfProfile,
    applyPresence: (payload: unknown) => {
      const snapshot = options.getSnapshot();
      const current = snapshot.selfUser;
      if (snapshot.phase !== "connected") {
        return;
      }
      const presence = resolveSelfPresenceUser(
        readPresenceEntries(payload) ?? [],
        snapshot.client?.instanceId,
      );
      if (!presence) {
        return;
      }
      if (
        hasOperatorReadAccess(snapshot.hello?.auth ?? null) &&
        (presence.id !== current?.id ||
          (presence.identity && presence.identity.id !== current.identity?.id))
      ) {
        // Broad readers receive live identity attachment changes through their own presence row.
        selfProfileRequest = null;
        fallbackAvatarUrl = undefined;
        options.publish(presence);
      } else if (presence.id === current?.id) {
        const updated = {
          ...current,
          // An omitted presence name clears the display name; profile facts stay canonical.
          name: presence.name,
          avatarUrl: presence.avatarUrl ?? current.avatarUrl,
        };
        if (!sameSelfUser(current, updated)) {
          options.publish(updated);
        }
      }
    },
    invalidate: () => {
      selfProfileRequest = null;
      if (options.getSnapshot().phase !== "connected") {
        fallbackAvatarUrl = undefined;
      }
    },
  };
}
