import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = path.join(MODULE_DIR, "agent-decision.schema.json");

export class CodexPlayerPool {
  constructor({ campaignRoot, codexHome, tempRoot, cliPath, concurrency = 2, attempts = 2, timeoutMs = 1_200_000, spawnImpl = spawnWithInput } = {}) {
    if (!campaignRoot) throw new Error("campaignRoot is required");
    if (!codexHome) throw new Error("codexHome is required; use an isolated campaign-specific Codex home");
    this.campaignRoot = path.resolve(campaignRoot);
    this.codexHome = path.resolve(codexHome);
    this.tempRoot = path.resolve(tempRoot ?? path.join(this.campaignRoot, "tmp"));
    this.cliPath = resolveCodexCli(cliPath);
    this.concurrency = concurrency;
    this.attempts = attempts;
    this.timeoutMs = timeoutMs;
    this.spawnImpl = spawnImpl;
    this.active = 0;
    this.waiters = [];
  }

  async decide({ episodeId, seat, assignment, prompt, outputSchema = DEFAULT_SCHEMA, maxAttempts = this.attempts }) {
    return this.withSlot(async () => {
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try { return await this.runAttempt({ episodeId, seat, assignment, prompt, outputSchema, attempt }); }
        catch (error) { lastError = error; }
      }
      throw new Error(`${seat} failed after ${maxAttempts} attempts: ${lastError?.message}`, { cause: lastError });
    });
  }

  async runAttempt({ episodeId, seat, assignment, prompt, outputSchema, attempt }) {
    const assignmentKey = [assignment.model, assignment.reasoning_effort, assignment.disposition, assignment.disposition_prompt_id].join("-");
    const key = safeKey(`${episodeId}-${seat}-${assignmentKey}`);
    const root = path.join(this.campaignRoot, "model_calls", key);
    const workspace = path.join(root, "workspace");
    const statePath = path.join(root, "thread.json");
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(this.codexHome, { recursive: true }), mkdir(this.tempRoot, { recursive: true })]);
    const state = existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) : {};
    if (state.model && (state.model !== assignment.model || state.reasoning_effort !== assignment.reasoning_effort)) throw new Error(`Persistent assignment changed for ${key}`);
    const callSequence = Number(state.call_sequence ?? 0) + 1;
    const callKey = `call-${String(callSequence).padStart(6, "0")}-attempt-${String(attempt).padStart(2, "0")}`;
    const sequencedEventPath = path.join(root, `${callKey}.events.jsonl`);
    const sequencedStderrPath = path.join(root, `${callKey}.stderr.txt`);
    const sequencedResponsePath = path.join(root, `${callKey}.response.json`);
    const args = buildArgs({ workspace, responsePath: sequencedResponsePath, threadId: state.thread_id, assignment, outputSchema });
    const startedAt = new Date().toISOString();
    let spawnError = null;
    let child;
    try {
      child = await this.spawnImpl(this.cliPath, args, prompt, workspace, {
        ...process.env,
        CODEX_HOME: this.codexHome,
        TEMP: this.tempRoot,
        TMP: this.tempRoot,
        NO_COLOR: "1"
      }, this.timeoutMs);
    } catch (error) {
      spawnError = error;
      child = { exitCode: null, stdout: "", stderr: error?.message ?? String(error) };
    }
    await Promise.all([atomicWrite(sequencedEventPath, child.stdout), atomicWrite(sequencedStderrPath, redact(child.stderr))]);
    const events = parseCodexEvents(child.stdout);
    const threadId = events.threadId ?? state.thread_id;
    const responseText = existsSync(sequencedResponsePath) ? (await readFile(sequencedResponsePath, "utf8")).trim() : "";
    let response = null, responseParseError = null;
    try { response = JSON.parse(responseText); } catch (error) { responseParseError = error; }
    const receipt = {
      schema: "aicourt.codex-player-attempt.v1", episode_id: episodeId, seat, call_sequence: callSequence, attempt, started_at: startedAt,
      completed_at: new Date().toISOString(), model: assignment.model, reasoning_effort: assignment.reasoning_effort,
      disposition: assignment.disposition, disposition_prompt_id: assignment.disposition_prompt_id,
      thread_id: threadId, exit_code: child.exitCode, usage: events.usage, failure: events.failure,
      spawn_error: spawnError?.message ?? null, response_valid_json: responseParseError == null,
      prompt_sha256: sha256(prompt), response_sha256: sha256(responseText)
    };
    await atomicWrite(path.join(root, `${callKey}.receipt.json`), JSON.stringify(receipt, null, 2) + "\n");
    await atomicWrite(statePath, JSON.stringify({ thread_id: threadId ?? null, model: assignment.model, reasoning_effort: assignment.reasoning_effort, call_sequence: callSequence, updated_at: new Date().toISOString() }, null, 2) + "\n");
    if (spawnError) throw new Error(`Codex CLI invocation failed for ${seat}: ${spawnError.message}`, { cause: spawnError });
    if (child.exitCode !== 0 || events.failure) throw new Error(`Codex CLI failure for ${seat}: ${redact(child.stderr).slice(0, 700)}`);
    if (!threadId) throw new Error(`No thread id emitted for ${seat}`);
    if (responseParseError) throw new Error(`Invalid JSON response from ${seat}`);
    return { response, responseText, threadId, usage: events.usage, receipt };
  }

  async withSlot(work) {
    if (this.active >= this.concurrency) await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try { return await work(); }
    finally { this.active -= 1; this.waiters.shift()?.(); }
  }
}

export function buildArgs({ workspace, responsePath, threadId, assignment, outputSchema = DEFAULT_SCHEMA }) {
  const args = ["-s", "read-only", "-a", "never", "-C", workspace, "-m", assignment.model,
    "-c", `model_reasoning_effort=\"${assignment.reasoning_effort}\"`];
  for (const feature of ["multi_agent", "shell_tool", "apps", "browser_use", "computer_use", "image_generation", "goals", "hooks"]) args.push("--disable", feature);
  args.push("exec");
  if (threadId) args.push("resume");
  args.push("--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json", "--output-schema", outputSchema, "--output-last-message", responsePath);
  if (threadId) args.push(threadId); else args.push("--color", "never");
  args.push("-");
  return args;
}

export function resolveCodexCli(explicit) {
  const candidates = [explicit, process.env.CODEX_PLAYER_CLI_PATH];
  const appBin = path.join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  if (existsSync(appBin)) {
    const versions = []; try { versions.push(...requireDirectoryNames(appBin)); } catch {}
    for (const version of versions.sort().reverse()) candidates.push(path.join(appBin, version, "codex.exe"));
  }
  candidates.push(path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"));
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("Native Codex CLI not found; set CODEX_PLAYER_CLI_PATH");
  return path.resolve(found);
}

function requireDirectoryNames(dir) {
  // Synchronous discovery happens once during construction and avoids invoking a shell.
  return globalThis.process.getBuiltinModule("node:fs").readdirSync(dir);
}

function spawnWithInput(executable, args, input, cwd, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true });
    const stdout = [], stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`Codex CLI timed out after ${timeoutMs}ms`));
      resolve({ exitCode: exitCode ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function parseCodexEvents(raw) {
  let threadId = null, failure = null;
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "thread.started") threadId = event.thread_id;
    if (event.type === "turn.completed" && event.usage) for (const key of Object.keys(usage)) usage[key] = Number(event.usage[key] ?? 0);
    if (event.type === "turn.failed") failure = JSON.stringify(event).slice(0, 2000);
  }
  return { threadId, usage, failure };
}

async function atomicWrite(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, "utf8");
  try { await rename(temp, target); } catch (error) { await rm(target, { force: true }); await rename(temp, target); }
}

function safeKey(value) { return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 180); }
function redact(value) { return String(value ?? "").replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1…REDACTED"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
