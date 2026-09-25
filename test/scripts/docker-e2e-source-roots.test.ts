import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const harness = process.cwd();
const posixIt = process.platform === "win32" ? it.skip : it;

describe("Docker E2E source and harness inputs", () => {
  posixIt.each<{
    script: string;
    dockerfiles?: string[];
    harnessDockerfile?: boolean;
    reuse?: boolean;
  }>([
    {
      script: "docker-selected-plugins.sh",
      dockerfiles: ["Dockerfile", "Dockerfile", "Dockerfile"],
    },
    {
      script: "plugin-binding-command-escape-docker.sh",
      dockerfiles: ["scripts/e2e/plugin-binding-command-escape.Dockerfile"],
      harnessDockerfile: true,
    },
    {
      script: "qr-import-docker.sh",
      dockerfiles: ["scripts/e2e/Dockerfile.qr-import"],
      harnessDockerfile: true,
    },
    { script: "agents-delete-shared-workspace-docker.sh", dockerfiles: ["Dockerfile"] },
    {
      script: "sandbox-browser-sidecar-docker.sh",
      dockerfiles: [
        "scripts/docker/sandbox/Dockerfile",
        "scripts/docker/sandbox/Dockerfile.browser",
      ],
      reuse: true,
    },
    { script: "compose-setup.sh", reuse: true },
    { script: "cli-installer-distribution-docker.sh", reuse: true },
  ])(
    "keeps candidate product inputs for $script",
    async ({ script, dockerfiles, harnessDockerfile, reuse }) => {
      const root = tempDirs.make("e2e-src-");
      const target = path.join(root, "candidate source");
      const bin = path.join(root, "bin");
      const log = path.join(root, "commands.jsonl");
      mkdirSync(target);
      mkdirSync(bin);
      writeFileSync(
        path.join(target, "Dockerfile"),
        'HEALTHCHECK CMD ["node", "dist/docker-healthcheck.js"]\n',
      );
      const packageTgz = path.join(root, "candidate.tgz");
      writeFileSync(packageTgz, "fixture package bytes");
      for (const command of ["docker", "git"]) {
        const file = path.join(bin, command);
        writeFileSync(
          file,
          `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command: ${JSON.stringify(command)}, args }) + '\\n');
if (${JSON.stringify(command)} === 'git') {
  if (args.includes('rev-parse')) console.log('a'.repeat(40));
} else if (args[0] === 'build' || args[0] === 'buildx') {
  if (args.some((arg) => arg.includes('OPENCLAW_EXTENSIONS=missing-plugin'))) {
    console.error('unknown OPENCLAW_EXTENSIONS plugin id: missing-plugin');
    process.exit(49);
  }
} else if (
  args[0] === 'compose' ||
  (args[0] === 'run' && !args.some((arg) => arg.endsWith('-dependency-only')))
) {
  console.error('fixture-stop at product input boundary');
  process.exit(49);
}
`,
        );
        chmodSync(file, 0o755);
      }
      const socketPath = path.join(root, "docker.sock");
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(socketPath, resolve);
      });
      try {
        const result = spawnSync("bash", [path.join(harness, "scripts/e2e", script)], {
          cwd: target,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            TMPDIR: root,
            OPENCLAW_DOCKER_E2E_REPO_ROOT: target,
            OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz,
            OPENCLAW_SKIP_DOCKER_BUILD: reuse ? "1" : "0",
            OPENCLAW_DOCKER_SOCKET: socketPath,
          },
        });
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain("fixture-stop at product input boundary");
        const calls = readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { command: string; args: string[] });
        if (dockerfiles) {
          const builds = calls.filter(
            (call) =>
              call.command === "docker" &&
              (call.args[0] === "build" || call.args[0] === "buildx") &&
              call.args.at(-1) === target,
          );
          expect(builds.map((build) => build.args[build.args.indexOf("-f") + 1])).toEqual(
            dockerfiles.map((dockerfile) =>
              path.join(harnessDockerfile ? harness : target, dockerfile),
            ),
          );
        } else if (script === "compose-setup.sh") {
          expect(calls.find((call) => call.args[0] === "compose")?.args).toContain(
            path.join(target, "docker-compose.yml"),
          );
        } else {
          const gitCalls = calls.filter((call) => call.command === "git");
          expect(gitCalls.map((call) => call.args.slice(0, 2))).toEqual([
            ["-C", target],
            ["-C", target],
          ]);
          expect(
            calls.find((call) => call.args[0] === "run" && call.args.includes("-d"))?.args,
          ).toContain(`${target}/scripts/install.sh:/tmp/install.sh:ro`);
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          socket.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
  posixIt.each([
    { runner: "cli", mode: "ready", exit: 0 },
    { runner: "package", mode: "ready", exit: 49 },
    { runner: "cli", mode: "pending", exit: 0 },
    { runner: "package", mode: "stopped", exit: 1 },
    { runner: "cli", mode: "exhausted", exit: 1 },
    { runner: "package", mode: "exhausted", exit: 1 },
    { runner: "cli", mode: "inspect-empty", exit: 1 },
    { runner: "package", mode: "inspect-true", exit: 49 },
    { runner: "cli", mode: "success-log-error", exit: 73 },
    { runner: "package", mode: "failure-log-error", exit: 73 },
  ])("preserves $runner proof settlement: $mode", ({ runner, mode, exit }) => {
    const root = tempDirs.make("e2e-wait-");
    const bin = path.join(root, "bin");
    const log = path.join(root, "commands");
    const packageDir = path.join(root, "package");
    mkdirSync(bin);
    mkdirSync(packageDir);
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.2.3" }),
    );
    const packageTgz = path.join(root, "candidate.tgz");
    expect(spawnSync("tar", ["-czf", packageTgz, "-C", root, "package"]).status).toBe(0);
    for (const [command, body] of Object.entries({
      git: `if [[ "$*" == *rev-parse* ]]; then printf '%040d\\n' 0; fi`,
      sleep: `printf 'sleep %s\\n' "$*" >> "$PROOF_TRACE"`,
      docker: `
case "$1" in
  run)
    shift
    while (($#)); do
      if [[ "$1" == --name ]]; then
        printf 'start %s\\n' "\${2%-*}" >> "$PROOF_TRACE"
        break
      fi
      shift
    done
    ;;
  exec)
    container="$2"
    shift 2
    if [[ "$*" != 'test -f /tmp/openclaw-proof-ready' ]]; then
      printf 'identity %s %s\\n' "\${container%-*}" "$*" >> "$PROOF_TRACE"
      echo 'fixture-stop at package identity boundary' >&2
      exit 49
    fi
    printf 'probe %s\\n' "\${container%-*}" >> "$PROOF_TRACE"
    count=0
    if [[ -f "$PROOF_STATE/$container" ]]; then read -r count < "$PROOF_STATE/$container"; fi
    count=$((count + 1))
    printf '%s\\n' "$count" > "$PROOF_STATE/$container"
    case "$PROOF_MODE" in
      ready|success-log-error) exit 0 ;;
      pending|inspect-true) if ((count > 1)); then exit 0; fi ;;
    esac
    exit 1
    ;;
  inspect)
    printf 'inspect %s %s\\n' "\${4%-*}" "$2 $3" >> "$PROOF_TRACE"
    case "$PROOF_MODE" in
      stopped|failure-log-error) echo false ;;
      inspect-empty) echo 'inspect-error' >&2; exit 72 ;;
      inspect-true) echo true; echo 'inspect-error' >&2; exit 72 ;;
      *) echo true ;;
    esac
    ;;
  logs)
    printf 'logs %s\\n' "\${2%-*}" >> "$PROOF_TRACE"
    printf 'proof-out:%s\\n' "\${2%-*}"
    printf 'proof-err:%s\\n' "\${2%-*}" >&2
    case "$PROOF_MODE" in *log-error) exit 73 ;; esac
    ;;
  rm)
    shift 2
    for container in "$@"; do printf 'cleanup %s\\n' "\${container%-*}" >> "$PROOF_TRACE"; done
    ;;
esac
`,
    })) {
      const file = path.join(bin, command);
      writeFileSync(file, `#!/bin/bash\nset -eu\n${body}\n`);
      chmodSync(file, 0o755);
    }
    const cli = runner === "cli";
    const containers = cli
      ? ["openclaw-hosted-installer-proof", "openclaw-source-installer-proof"]
      : [
          "openclaw-package-npm-proof",
          "openclaw-package-pnpm-proof",
          "openclaw-package-bun-proof",
          "openclaw-package-musl-proof",
        ];
    const result = spawnSync(
      "/bin/bash",
      [
        path.join(
          harness,
          "scripts/e2e",
          cli ? "cli-installer-distribution-docker.sh" : "docker-package-install.sh",
        ),
      ],
      {
        cwd: harness,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          TMPDIR: root,
          OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz,
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
          OPENCLAW_DOCKER_ARTIFACT_IDENTITY_PATH: path.join(root, "identity.json"),
          PROOF_TRACE: log,
          PROOF_STATE: root,
          PROOF_MODE: mode,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(exit);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const expected = containers.map((container) => `start ${container}`);
    const settled = exit === 0 || exit === 49;
    for (const container of settled ? containers : containers.slice(0, 1)) {
      const attempts = mode === "exhausted" ? (cli ? 1200 : 240) : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        expected.push(`probe ${container}`);
        if (mode !== "ready" && mode !== "success-log-error") {
          expected.push(`inspect ${container} --format {{.State.Running}}`);
          if (["pending", "inspect-true", "exhausted"].includes(mode)) {
            expected.push("sleep 1");
          }
        }
      }
      if (mode === "pending" || mode === "inspect-true") {
        expected.push(`probe ${container}`);
      }
      if (cli || !settled) {
        expected.push(`logs ${container}`);
      }
    }
    if (exit === 49) {
      // Waits completed; this fixture does not claim installed package acceptance.
      expected.push("identity openclaw-package-pnpm-proof cat /tmp/openclaw-package-root");
      expect(result.stderr).toContain("fixture-stop at package identity boundary");
    }
    expected.push(...containers.map((container) => `cleanup ${container}`));
    expect(calls).toEqual(expected);
    if (cli && (settled || mode === "success-log-error")) {
      expect(result.stdout).toContain(`proof-out:${containers[0]}`);
      expect(result.stderr).toContain(`proof-err:${containers[0]}`);
      expect(result.stderr).not.toContain("proof-out:");
    } else if (!settled) {
      expect(result.stdout).not.toContain("proof-out:");
      expect(result.stderr).toContain(`proof-out:${containers[0]}`);
      expect(result.stderr).toContain(`proof-err:${containers[0]}`);
    } else {
      expect(result.stdout + result.stderr).not.toContain("proof-out:");
    }
    expect(result.stderr.includes("inspect-error")).toBe(mode.startsWith("inspect-"));
    expect(result.stdout.includes("CLI installer distribution proof passed.")).toBe(
      cli && exit === 0,
    );
    expect(result.stdout).not.toContain("npm, pnpm, and Bun package artifact proofs passed.");
  });
  posixIt("packs candidate source through the sourced trusted package helper", () => {
    const root = tempDirs.make("e2e-pack-");
    const trusted = path.join(root, "trusted harness");
    const target = path.join(root, "candidate source");
    const lib = path.join(trusted, "scripts/lib");
    mkdirSync(lib, { recursive: true });
    mkdirSync(path.join(target, "scripts"), { recursive: true });
    copyFileSync("scripts/lib/docker-e2e-package.sh", path.join(lib, "docker-e2e-package.sh"));
    writeFileSync(
      path.join(target, "scripts/package-openclaw-for-docker.mjs"),
      "process.exit(47);\n",
    );
    const marker = path.join(root, "packer-source");
    writeFileSync(
      path.join(trusted, "scripts/package-openclaw-for-docker.mjs"),
      `
import fs from 'node:fs'; import path from 'node:path';
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
fs.writeFileSync(${JSON.stringify(marker)}, value('--source-dir'));
const output = path.join(value('--output-dir'), value('--output-name'));
fs.writeFileSync(output, 'candidate bytes');
console.log(output);
`,
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
run_logged() { :; }
docker_e2e_docker_cmd() { :; }
docker_e2e_docker_run_cmd() { :; }
source "$TRUSTED/scripts/lib/docker-e2e-package.sh"
package="$(docker_e2e_prepare_package_tgz fixture)"
[[ "$(cat "$package")" == 'candidate bytes' ]]
docker_e2e_cleanup_package_tgz "$package"
`,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          ROOT_DIR: target,
          TRUSTED: trusted,
          TMPDIR: root,
          OPENCLAW_DOCKER_E2E_REPO_ROOT: target,
          OPENCLAW_CURRENT_PACKAGE_TGZ: "",
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe(target);
  });
});
