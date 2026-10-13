// sandbox.ts — extract the `meta` literal and run the workflow script in node:vm.
//
// Two jobs (SPEC §3, §6, §12):
//   extractMeta — balanced-brace scan the `meta` object literal, eval it in an EMPTY
//                 vm context so any var/fn/template ref throws (enforces "pure literal").
//   runScript   — transform the source (drop top-level `export`, wrap in an async fn so
//                 top-level await/return work), bind the hooks as CONTEXT GLOBALS, and
//                 trap the determinism-breaking time/randomness APIs (Date.now,
//                 Math.random, argless `new Date`) so the USER SCRIPT can't call them.

import vm from "node:vm";
import type { WorkflowMeta, ScriptHooks } from "../types.js";

const META_DECL_RE = /(?:^|\n)\s*(?:export\s+)?const\s+meta\s*=/;

// Determinism pre-flight (SPEC §6). The PRIMARY guard is this static source scan — it
// mirrors the official tool, which rejects scripts referencing these APIs at submission
// time (before any vm runs). The buildGlobals traps below are a best-effort SECONDARY
// defense. node:vm is explicitly NOT a security/isolation boundary, and the orchestration
// hooks must be real host functions, so a script that deliberately reflects via the
// Function constructor can still reach the host realm — that is an inherent vm limitation,
// out of the cooperative-determinism threat model. The scan is intentionally naive (it also
// matches inside strings/comments), exactly like the official source check.
const FORBIDDEN_PATTERNS: ReadonlyArray<{ re: RegExp; name: string }> = [
  { re: /\bDate\s*\.\s*now\s*\(/, name: "Date.now()" },
  { re: /\bMath\s*\.\s*random\s*\(/, name: "Math.random()" },
  { re: /\bnew\s+Date\s*\(\s*\)/, name: "new Date()" },
];

/** Reject a script that references the wall-clock / randomness APIs (SPEC §6). */
export function assertDeterministicSource(source: string): void {
  for (const { re, name } of FORBIDDEN_PATTERNS) {
    if (re.test(source)) {
      throw new Error(
        `Workflow scripts must be deterministic: ${name} is unavailable (breaks resume). ` +
          "Pass timestamps via args.",
      );
    }
  }
}

/**
 * Find the `meta` object literal, eval it with an empty sandbox (no hooks, no globals)
 * so a non-literal meta throws, then validate name/description are strings.
 */
export function extractMeta(source: string): WorkflowMeta {
  const decl = META_DECL_RE.exec(source);
  if (decl === null) {
    throw new Error(
      "workflow script must declare `export const meta = { … }` before its body (SPEC §3)",
    );
  }

  // Position of the `=` that begins the literal.
  const eqIndex = source.indexOf("=", decl.index + decl[0].length - 1);
  if (eqIndex === -1) {
    throw new Error("malformed `meta` declaration: missing `=`");
  }

  const literal = scanObjectLiteral(source, eqIndex + 1);

  let value: unknown;
  try {
    // Empty sandbox: any identifier / function / template ref inside the literal is a
    // free variable that is not defined → ReferenceError. That enforces "pure literal".
    value = vm.runInNewContext("(" + literal + ")", Object.create(null), {
      timeout: 1000,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `\`meta\` must be a pure object literal (no variables, calls, spreads, or template interpolation): ${reason}`,
    );
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("`meta` must be a plain object literal");
  }

  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string") {
    throw new Error("`meta.name` is required and must be a string");
  }
  if (typeof obj.description !== "string") {
    throw new Error("`meta.description` is required and must be a string");
  }

  return obj as unknown as WorkflowMeta;
}

/**
 * Balanced-brace scan starting at `from`. Skips whitespace to the opening `{`, then walks
 * to its matching `}` while respecting strings, template literals, and comments. Returns
 * the literal text including the braces.
 */
function scanObjectLiteral(source: string, from: number): string {
  let i = from;
  // Skip leading whitespace to the opening brace.
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    break;
  }
  if (source[i] !== "{") {
    throw new Error("`meta` must be assigned an object literal `{ … }`");
  }

  const start = i;
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString !== null) {
      if (c === "\\") {
        i++; // skip escaped char
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }

    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "{") {
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error("unterminated `meta` object literal: no matching `}` found");
}

/**
 * Transform the source so top-level `export` is dropped and the body is wrapped in an
 * async function (enabling top-level await + return), bind the hooks as context globals,
 * and run it in a vm context whose globals are safe builtins + determinism traps.
 */
export async function runScript(source: string, hooks: ScriptHooks): Promise<unknown> {
  assertDeterministicSource(source);
  const transformed = transformSource(source);
  const wrapped = "async function __wf(){\n" + transformed + "\n}";

  const globals = buildGlobals(hooks);
  const ctx = vm.createContext(globals);
  const fn = vm.runInContext("(" + wrapped + ")", ctx) as () => Promise<unknown>;
  return await fn();
}

/**
 * Drop the leading `export ` from `export const meta` and from any other top-level
 * `export const`/`export function`. Only matches at line starts (top-level), leaving
 * exports inside nested scopes untouched (they'd be syntax errors anyway, but the body
 * shouldn't contain them).
 */
function transformSource(source: string): string {
  // `export const meta` → `const meta` (and any other top-level export decl).
  return source.replace(
    /(^|\n)([ \t]*)export[ \t]+(const|let|var|function|async[ \t]+function|class)\b/g,
    (_m, lead: string, indent: string, kw: string) => lead + indent + kw,
  );
}

/**
 * Build the vm context globals: safe builtins + a Math copy whose random throws + a Date
 * wrapper whose `now` and argless construction throw + the injected hooks. No require /
 * process / global / globalThis / import / fs / child_process.
 */
function buildGlobals(hooks: ScriptHooks): Record<string, unknown> {
  const blocked = "wall-clock/now is unavailable in workflow scripts — pass timestamps via args";

  // Math copy: identical surface, but `random` throws.
  const SafeMath: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(Math)) {
    SafeMath[k] = (Math as unknown as Record<string, unknown>)[k];
  }
  SafeMath.random = () => {
    throw new Error(blocked);
  };

  // Date wrapper: explicit-argument construction and parsing stay usable; argless
  // construction (the "now" path), bare `Date()` calls, and the static `now()` throw.
  //
  // Crucially, the wrapper severs every back-channel from a constructed instance to the
  // real, untrapped Date — `new Date(0).constructor.now()`, `Date.prototype.constructor`,
  // and walking the instance's prototype chain must NOT reach the real Date (that would
  // re-expose live wall-clock and defeat the determinism guarantee in SPEC §6). To achieve
  // that, instances are built with Reflect.construct (so they keep Date's internal slot +
  // methods) but re-homed onto a SANITIZED prototype whose `constructor` is SafeDate and
  // whose own [[Prototype]] is Object.prototype — RealDate.prototype is never in the chain.
  const RealDate = Date;
  const SafeDate = function (this: unknown, ...rawArgs: unknown[]): object {
    if (new.target === undefined) {
      // Bare `Date()` — would need the wall clock to make sense; disallow.
      throw new Error(blocked);
    }
    if (rawArgs.length === 0) {
      throw new Error(blocked);
    }
    // Build a genuine Date (internal [[DateValue]] slot + working methods) but home it on
    // SafeDate.prototype via the newTarget argument rather than on RealDate.prototype.
    return Reflect.construct(RealDate, rawArgs, SafeDate as unknown as new () => object);
  } as unknown as DateConstructor;

  // Sanitized prototype: copy every RealDate.prototype method/symbol, but point
  // `constructor` at SafeDate and let it inherit from Object.prototype (NOT
  // RealDate.prototype), so no proto-walk or `.constructor` hop reaches the real Date.
  const safeProto: object = Object.create(Object.prototype);
  for (const key of Reflect.ownKeys(RealDate.prototype)) {
    if (key === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(RealDate.prototype, key);
    if (desc !== undefined) Object.defineProperty(safeProto, key, desc);
  }
  Object.defineProperty(safeProto, "constructor", {
    value: SafeDate,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(SafeDate, "prototype", {
    value: safeProto,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  SafeDate.parse = RealDate.parse.bind(RealDate);
  SafeDate.UTC = RealDate.UTC.bind(RealDate);
  Object.defineProperty(SafeDate, "now", {
    value: () => {
      throw new Error(blocked);
    },
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // Intl override (SPEC §6). ECMA-402 `DateTimeFormat.format()/formatToParts()/
  // formatRange*()` default a missing or `undefined` date argument to the SYSTEM CLOCK in
  // the engine (C++) — NOT via the sandbox Date — so the SafeDate trap does not cover it and
  // a cooperative author can accidentally leak live wall-clock with `Intl.DateTimeFormat()
  // .format()`. Wrap DateTimeFormat so the now-defaulting path throws; explicit timestamps
  // still work. Other Intl members (NumberFormat, Collator, …) are time-independent.
  // (Temporal — whose `Temporal.Now.*` is another now-defaulting surface — is not shipped in
  //  the current Node baseline; if a future runtime exposes it, it must be trapped here too.)
  const RealIntl = Intl;
  const SafeIntl: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(RealIntl)) {
    SafeIntl[k] = (RealIntl as unknown as Record<string, unknown>)[k];
  }
  const RealDTF = RealIntl.DateTimeFormat;
  const SafeDTF = function (...ctorArgs: unknown[]): object {
    const inst = new (RealDTF as unknown as new (...a: unknown[]) => object)(...ctorArgs);
    return new Proxy(inst, {
      get(target, prop) {
        const tgt = target as Record<string, (...x: unknown[]) => unknown>;
        if (prop === "format" || prop === "formatToParts") {
          const fn = (tgt[prop] as (...x: unknown[]) => unknown).bind(target);
          return (...a: unknown[]) => {
            if (a.length === 0 || a[0] === undefined) throw new Error(blocked);
            return fn(...a);
          };
        }
        if (prop === "formatRange" || prop === "formatRangeToParts") {
          const fn = (tgt[prop] as (...x: unknown[]) => unknown).bind(target);
          return (...a: unknown[]) => {
            if (a.length < 2 || a[0] === undefined || a[1] === undefined) throw new Error(blocked);
            return fn(...a);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
  } as unknown as typeof Intl.DateTimeFormat;
  SafeDTF.supportedLocalesOf = RealDTF.supportedLocalesOf.bind(RealDTF);
  SafeIntl.DateTimeFormat = SafeDTF;

  return {
    // Safe builtins.
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Map,
    Set,
    RegExp,
    Error,
    Symbol,
    // NOTE: structuredClone is deliberately NOT exposed. It is a host intrinsic that
    // deep-clones by RECONSTRUCTING Date instances on the real (untrapped) Date.prototype
    // — a back-channel that hands the script the real Date constructor (.now() / argless
    // construction → live wall clock) and defeats the SPEC §6 determinism guarantee.
    // Scripts that need a plain-data clone can JSON-roundtrip.
    console,
    Math: SafeMath,
    Date: SafeDate,
    Intl: SafeIntl,

    // Injected hooks (referenced as free variables inside the script).
    agent: hooks.agent,
    parallel: hooks.parallel,
    pipeline: hooks.pipeline,
    phase: hooks.phase,
    log: hooks.log,
    args: hooks.args,
    workflow: hooks.workflow,
  };
}
