import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewer = path.join(root, "viewer");
const command = process.argv[2] ?? "dev";
if (!new Set(["dev", "build", "start", "test", "lint"]).has(command)) throw new Error(`Unsupported viewer command: ${command}`);

const node = findNode22();
const cli = path.join(viewer, "node_modules", "vinext", "dist", "cli.js");
if (!existsSync(cli)) throw new Error(`Viewer dependencies are missing. Run npm install in ${viewer} with Node 22+.`);

const result = spawnSync(node, [cli, command, ...process.argv.slice(3)], { cwd: viewer, stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

function findNode22() {
  const requested = process.env.AICOURT_VIEWER_NODE;
  if (requested && existsSync(requested)) return requested;
  if (Number(process.versions.node.split(".")[0]) >= 22) return process.execPath;
  throw new Error("The Court viewer requires Node 22+. Set AICOURT_VIEWER_NODE to a compatible node executable.");
}
