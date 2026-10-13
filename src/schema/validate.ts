// schema/validate.ts — ajv wrapper, --json-schema arg building, safety-net validate (SPEC §7).

import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import type { JsonSchema } from "../types.js";

// Single shared ajv instance. strict:false so unknown keywords (CLI-flavored schemas,
// vendor extensions) don't crash compilation; allErrors so errorsText reports everything.
const ajv = new Ajv({ allErrors: true, strict: false });

// Compiled validators cached by a stable stringify of the schema.
const validatorCache = new Map<string, ValidateFunction>();

/** The exact JSON handed to `claude --json-schema <json>`. */
export function schemaToCliArg(schema: JsonSchema): string {
  return JSON.stringify(schema);
}

export interface ValidationResult {
  ok: boolean;
  errors?: string;
}

function getValidator(schema: JsonSchema): ValidateFunction {
  const cacheKey = JSON.stringify(schema);
  const existing = validatorCache.get(cacheKey);
  if (existing) return existing;
  const compiled = ajv.compile(schema);
  validatorCache.set(cacheKey, compiled);
  return compiled;
}

/** Re-validate a value against the schema as a safety net for the CLI's structured output. */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): ValidationResult {
  const validate = getValidator(schema);
  const valid = validate(value);
  if (valid) return { ok: true };
  const errors = ajv.errorsText(validate.errors, { separator: "; " });
  return { ok: false, errors };
}

/** SPEC §7: structured-output schema root MUST be type:"object". */
export function assertObjectRootSchema(schema: JsonSchema): void {
  if (schema["type"] !== "object") {
    throw new Error(
      `structured-output schema root must be type:"object" (got ${JSON.stringify(
        schema["type"],
      )}); discriminated unions must be expressed flat (enum discriminant + optional fields), not a root oneOf`,
    );
  }
}
