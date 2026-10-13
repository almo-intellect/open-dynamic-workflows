// executor/platform.ts — cross-platform process plumbing shared by every executor.
//
// POSIX: spawn the CLI by name in a fresh process group and kill the group via a negative
// pid. Windows supports neither: npm-installed CLIs (claude, codex, gemini) are `.cmd`
// shims that spawn() refuses to launch without a shell (EINVAL since Node 20.12),
// `detached` pops up a console window per agent, and process.kill(-pid) throws — so a
// cancel would orphan the CLI's whole process tree. Here an npm shim resolves to
// `node <entry.js>` (no shell, no quoting hazards) and trees die via `taskkill /T /F`.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** What spawn() should actually launch for a CLI name. */
export interface ResolvedCommand {
  /** Executable handed to spawn(). */
  file: string;
  /** Args placed before the executor's own argv (e.g. an npm shim's JS entry). */
  prefixArgs: string[];
  /** Last resort for non-npm .cmd/.bat shims: launch through cmd.exe. */
  shell: boolean;
}

// npm's cmd-shim ends with  "%_prog%"  "%dp0%\node_modules\pkg\bin.js" %*
// (older shims: "%~dp0\node_modules\pkg\bin.js" %*). Capture the entry relative to the shim.
const NPM_SHIM_ENTRY_RE = /"%~?dp0%?\\([^"]+?\.(?:js|mjs|cjs))"\s+%\*/i;

/** Extract the JS entry (relative to the shim's dir) from an npm `.cmd` shim, or null. */
export function parseNpmCmdShim(content: string): string | null {
  return NPM_SHIM_ENTRY_RE.exec(content)?.[1] ?? null;
}

function pathEnv(env: NodeJS.ProcessEnv): string {
  // A copied env object is case-sensitive, unlike process.env on Windows.
  return env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Every file `command` could mean under Windows lookup rules (PATH order × PATHEXT). */
export function findOnWindowsPath(command: string, env: NodeJS.ProcessEnv): string[] {
  const exts = (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((e) => e.length > 0)
    .map((e) => e.toLowerCase());
  const names = path.win32.extname(command) !== "" ? [command] : exts.map((e) => command + e);
  const hasDir = command.includes("/") || command.includes("\\");
  const dirs = hasDir ? [""] : pathEnv(env).split(";").filter((d) => d.length > 0);
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir === "" ? name : path.win32.join(dir, name);
      if (isFile(candidate)) found.push(candidate);
    }
  }
  return found;
}

function resolveOnWindows(command: string, env: NodeJS.ProcessEnv): ResolvedCommand {
  for (const candidate of findOnWindowsPath(command, env)) {
    const ext = path.win32.extname(candidate).toLowerCase();
    if (ext === ".exe" || ext === ".com") return { file: candidate, prefixArgs: [], shell: false };
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      return { file: process.execPath, prefixArgs: [candidate], shell: false };
    }
    if (ext === ".cmd" || ext === ".bat") {
      let entry: string | null = null;
      try {
        entry = parseNpmCmdShim(readFileSync(candidate, "utf8"));
      } catch {
        entry = null;
      }
      if (entry !== null) {
        const abs = path.win32.join(path.win32.dirname(candidate), entry);
        if (existsSync(abs)) return { file: process.execPath, prefixArgs: [abs], shell: false };
      }
      return { file: candidate, prefixArgs: [], shell: true };
    }
  }
  // Not found: hand the bare name to spawn() so it reports a normal ENOENT.
  return { file: command, prefixArgs: [], shell: false };
}

const resolveCache = new Map<string, ResolvedCommand>();

/**
 * Map a CLI name to what spawn() should launch. Identity on POSIX; on Windows it walks
 * PATH × PATHEXT and unwraps npm shims into `node <entry.js>`. Cached per (command, PATH).
 */
export function resolveCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedCommand {
  if (platform !== "win32") return { file: command, prefixArgs: [], shell: false };
  const key = `${command}\0${pathEnv(env)}\0${env["PATHEXT"] ?? ""}`;
  const hit = resolveCache.get(key);
  if (hit !== undefined) return hit;
  const resolved = resolveOnWindows(command, env);
  resolveCache.set(key, resolved);
  return resolved;
}

/**
 * Quote one argv token for cmd.exe — used only by the shell fallback. Best effort: cmd
 * still expands %VAR% inside quotes, which is why npm shims are unwrapped instead.
 */
export function quoteForCmd(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^%!()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** spawn() options that give each platform a killable, window-less child. */
export function treeSpawnOptions(
  platform: NodeJS.Platform = process.platform,
): { detached: boolean; windowsHide: boolean } {
  // POSIX: a new process group, so killProcessTree() can signal -pid.
  // Windows: no `detached` (it opens a console window); taskkill /T reaches the tree.
  return { detached: platform !== "win32", windowsHide: true };
}

/**
 * Kill a child and everything it spawned (MCP servers, tool subprocesses, shells).
 * POSIX signals the process group; Windows runs `taskkill /pid <pid> /T /F`. Never throws.
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  const killChild = (): void => {
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  };
  const pid = child.pid;
  if (pid === undefined) return killChild();
  if (platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", killChild);
    } catch {
      killChild();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    killChild();
  }
}
