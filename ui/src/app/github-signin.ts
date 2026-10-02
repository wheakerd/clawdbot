import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";
import { hasOperatorReadAccess } from "./operator-access.ts";

/** Identity proof completes sign-in; GitHub consent separately supplies personal API authority. */
export function startGitHubSignInConsent(
  context: Pick<ApplicationContext, "gateway" | "connectionBootstrap" | "lifecycleAbortSignal">,
): () => void {
  let owner:
    | {
        client: ApplicationGatewaySnapshot["client"];
        profileId: string;
        hello: object;
        controller: AbortController;
      }
    | undefined;
  const retire = () => {
    owner?.controller.abort();
    owner = undefined;
  };
  const update = (snapshot: ApplicationGatewaySnapshot) => {
    const profileId = snapshot.selfUser?.id;
    if (
      snapshot.phase !== "connected" ||
      !snapshot.client ||
      !snapshot.hello ||
      !profileId ||
      !hasOperatorReadAccess(snapshot.hello.auth ?? null)
    ) {
      retire();
      return;
    }
    if (
      owner?.client === snapshot.client &&
      owner.profileId === profileId &&
      owner.hello === snapshot.hello
    ) {
      return;
    }
    retire();
    const selected = {
      client: snapshot.client,
      profileId,
      hello: snapshot.hello,
      controller: new AbortController(),
    };
    owner = selected;
    const signal = context.lifecycleAbortSignal
      ? AbortSignal.any([selected.controller.signal, context.lifecycleAbortSignal])
      : selected.controller.signal;
    void context.connectionBootstrap.run(
      selected,
      async () => {
        // Consent consumes identity facts without republishing foreground self presentation.
        const profile = await context.gateway.loadSelfProfile({ publish: false });
        if (
          signal.aborted ||
          owner !== selected ||
          profile?.id !== profileId ||
          !profile.githubIdentity
        ) {
          return;
        }
        const { completeGitHubSignInConsent } =
          await import("../features/github-connections/github-signin-consent.ts");
        if (!signal.aborted && owner === selected) {
          // The dialog owns its lifetime; it must not occupy a bootstrap queue slot during consent.
          void completeGitHubSignInConsent(selected.client, profileId, signal);
        }
      },
      { background: true },
    );
  };
  const stop = context.gateway.subscribe(update);
  update(context.gateway.snapshot);
  return () => {
    stop();
    retire();
  };
}
