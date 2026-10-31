import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enOpenClawId = {
  openclawId: {
    menuTitle: "OpenClaw ID",
    signIn: "Sign in with OpenClaw ID",
    signInLocalOnly: "Sign in from the Control UI on this machine (127.0.0.1).",
    signInUnconfigured: "Set gateway.openclawId.clientId to sign in.",
    signingIn: "Finish signing in in the OpenClaw ID window…",
    signedIn: "Signed in to OpenClaw ID as {account}",
    signInFailed: "OpenClaw ID sign-in failed: {error}",
    signOut: "Sign out of OpenClaw ID",
    localOperator: "Local operator · Not signed in · this computer only",
    staysLocal: "Your conversations stay on this computer",
    devicesAndPeople: "Devices & people",
    isReachable: "{name} is reachable",
    encrypted: "End-to-end encrypted · relays can't read it",
    reachOffer: "Signed in as {account}. Reach this claw from anywhere?",
    makeReachableLocalOnly:
      "Open the Control UI on this machine (127.0.0.1) to make it reachable. Linking never runs over a remote connection.",
    needsLoaderDomain:
      "Set gateway.openclawId.loaderDomain to choose the address this claw is reachable at.",
    makeReachableFailed: "Couldn't make this claw reachable: {error}",
    signedInLinkCode: "Signed in as {account}. Your link code is ready.",
    linkCodeFailed: "Couldn't get a link code for your account: {error}. Paste one instead.",
    dialogTitle: "Make this claw reachable",
    dialogDescription: "Create a recovery kit and link this claw to it.",
    nameBody:
      "Name your claw. The name becomes its address; the ending is unique to your account, so names never collide.",
    enrollmentCode: "OpenClaw ID link code",
    enrollmentCodeHint:
      "Get one while signed in to OpenClaw ID. It lists this claw in your account.",
    getLinkCode: "Get a link code",
    clawName: "Claw name",
    clawNameHint:
      "Lower-case letters, digits and hyphens. Your address ends with your account's tag.",
    nameAvailable: "Available: https://{host}",
    nameTaken: "https://{host} is taken. Choose another name.",
    continue: "Continue",
    introBody: "This claw will be reachable at https://{host} from devices you approve.",
    introKit:
      "First you'll get a recovery kit. It is the only way to prove you own your claws if you lose your devices, so save it somewhere safe, like your password manager.",
    createKit: "Create recovery kit",
    kitBody: "This is your recovery kit. It is shown once.",
    kitFingerprint: "Owner fingerprint: {fingerprint}",
    kitWarning:
      "Anyone with this kit can take ownership of your claws. Never share it or read it to anyone.",
    downloadKit: "Download as text file",
    kitSaved: "I saved my recovery kit somewhere safe",
    makeReachable: "Make reachable",
    thisBrowser: "This browser",
    linking: "Linking this claw…",
    doneBody: "This claw is now linked to your recovery kit and reachable at https://{host}.",
    doneNotPublished: "It is not listed in OpenClaw ID yet. Add an enrollment code to publish it.",
    done: "Done",
  },
} satisfies TranslationMap;

/** Registers the OpenClaw ID account menu and Make reachable strings. */
export const registerOpenClawIdEnglish = Object.assign(
  () => Object.assign(en.openclawId, enOpenClawId.openclawId),
  { catalog: enOpenClawId },
);
