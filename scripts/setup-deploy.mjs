import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Run this setup with Node.js 22 or newer");
  const publicKey = process.argv[2]?.trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [a-zA-Z0-9@._-]+)?$/.test(publicKey ?? "")) {
    throw new Error("Pass the dedicated GitHub Actions Ed25519 public key as the only argument");
  }
  const root = resolve(process.cwd());
  await access(join(root, "dist-server", "server.mjs"));
  let pm2Directory;
  for (const directory of (process.env.PATH ?? "").split(":")) {
    try {
      await access(join(directory, "pm2"), constants.X_OK);
      pm2Directory = directory;
      break;
    } catch { /* Try the next PATH entry. */ }
  }
  if (!pm2Directory) throw new Error("PM2 is not on PATH; run setup in the same shell used to manage the app");
  let processes;
  try {
    processes = JSON.parse(execFileSync(join(pm2Directory, "pm2"), ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch { throw new Error("Could not read PM2 processes"); }
  if (processes.filter(p => p.name === "weekend-merge").length !== 1) {
    throw new Error("Expected exactly one existing weekend-merge PM2 process");
  }

  const deployment = join(root, ".deploy");
  await mkdir(join(deployment, "uploads"), { recursive: true, mode: 0o700 });
  await chmod(deployment, 0o700);
  const runner = join(deployment, "run-node");
  await writeFile(runner, [
    "#!/usr/bin/env bash", "set -euo pipefail",
    `export PATH=${quote(`${dirname(process.execPath)}:${pm2Directory}`)}:"$PATH"`,
    `exec ${quote(process.execPath)} "$@"`, "",
  ].join("\n"), { mode: 0o700 });
  await chmod(runner, 0o700);

  const sshDirectory = join(homedir(), ".ssh");
  await mkdir(sshDirectory, { recursive: true, mode: 0o700 });
  await chmod(sshDirectory, 0o700);
  const authorizedPath = join(sshDirectory, "authorized_keys");
  const existing = await readFile(authorizedPath, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!existing.split(/\r?\n/).some(line => line.split(/\s+/).includes(publicKey.split(" ")[1]))) {
    await appendFile(authorizedPath, `${existing && !existing.endsWith("\n") ? "\n" : ""}restrict ${publicKey}\n`, { mode: 0o600 });
  }
  await chmod(authorizedPath, 0o600);
  console.log("Deployment SSH public key authorized; existing keys and PM2 process preserved.");
  console.log(`Deployment directory: ${root}`);
  console.log(`Node.js: ${process.version}`);
  console.log("Setup complete. Enable DEPLOY_ENABLED in GitHub Actions variables and run test-and-build on main.");
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
