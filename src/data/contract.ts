import { canon } from '../bazaar/keys';

// ---------------------------------------------------------------------------
// The contract a company data agent publishes per question type, and the checks
// PayPali runs on every answer before the buyer sees it. Everything here is
// enforced OUTSIDE the company's model: an answer that breaks the contract is
// refused, refunded, and costs the seller a Score stake.
//
//   inputSchema / outputSchema   JSON-schema subset (same as AgentBazaar core.js, no regex)
//   pricing                      fixed or metered (rows scanned, compute ms), capped by maxGas
//   freshnessSeconds             an answer's as_of may be at most this old
//   accuracyClaim                the confidence the seller stakes on every answer
//   privacy.bannedFields         field names that may not appear ANYWHERE in a result
//   privacy.minAggregation       every group the result reports must cover >= min records
// ---------------------------------------------------------------------------

export type JsonSchema = Record<string, unknown>;

const SCHEMA_KEYS = new Set(['type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'description', 'title']);
const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

/** null when `s` is a supported schema, otherwise why not. */
export function checkSchemaShape(s: unknown, depth = 0): string | null {
  if (depth > 10) return 'too_deep';
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return 'not_an_object';
  const o = s as Record<string, any>;
  for (const k of Object.keys(o)) if (!SCHEMA_KEYS.has(k)) return 'unsupported_keyword:' + k;
  const ts = o.type === undefined ? [] : Array.isArray(o.type) ? o.type : [o.type];
  if (ts.some((t: unknown) => !TYPES.includes(t as string))) return 'bad_type';
  if (o.properties) {
    if (typeof o.properties !== 'object' || Array.isArray(o.properties)) return 'bad_properties';
    for (const v of Object.values(o.properties)) { const e = checkSchemaShape(v, depth + 1); if (e) return e; }
  }
  if (o.items) { const e = checkSchemaShape(o.items, depth + 1); if (e) return e; }
  if (o.additionalProperties && typeof o.additionalProperties === 'object') { const e = checkSchemaShape(o.additionalProperties, depth + 1); if (e) return e; }
  if (o.required && !(Array.isArray(o.required) && o.required.every((x: unknown) => typeof x === 'string'))) return 'bad_required';
  return null;
}

/** Validation errors (empty = valid). Same semantics as core.js `validate`. */
export function validate(s: JsonSchema, v: unknown, path = '$', errs: string[] = []): string[] {
  if (errs.length > 20) return errs;
  const o = s as Record<string, any>;
  const typeOf = (x: unknown) => (x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x);
  if (o.type !== undefined) {
    const ts: string[] = Array.isArray(o.type) ? o.type : [o.type];
    const t = typeOf(v);
    if (!ts.some((x) => x === t || (x === 'number' && t === 'integer'))) { errs.push(`${path}: expected ${ts.join('|')}, got ${t}`); return errs; }
  }
  if (o.const !== undefined && canon(v) !== canon(o.const)) errs.push(`${path}: must equal ${JSON.stringify(o.const)}`);
  if (o.enum && !o.enum.some((e: unknown) => canon(e) === canon(v))) errs.push(`${path}: not one of the allowed values`);
  if (typeof v === 'number') {
    if (o.minimum !== undefined && v < o.minimum) errs.push(`${path}: below minimum ${o.minimum}`);
    if (o.maximum !== undefined && v > o.maximum) errs.push(`${path}: above maximum ${o.maximum}`);
  }
  if (typeof v === 'string') {
    if (o.minLength !== undefined && v.length < o.minLength) errs.push(`${path}: shorter than ${o.minLength}`);
    if (o.maxLength !== undefined && v.length > o.maxLength) errs.push(`${path}: longer than ${o.maxLength}`);
  }
  if (Array.isArray(v)) {
    if (o.minItems !== undefined && v.length < o.minItems) errs.push(`${path}: fewer than ${o.minItems} items`);
    if (o.maxItems !== undefined && v.length > o.maxItems) errs.push(`${path}: more than ${o.maxItems} items`);
    if (o.items) v.forEach((x, i) => validate(o.items, x, `${path}[${i}]`, errs));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of o.required || []) if (!(r in (v as object))) errs.push(`${path}.${r}: required`);
    for (const [k, x] of Object.entries(v)) {
      if (o.properties && o.properties[k]) validate(o.properties[k], x, `${path}.${k}`, errs);
      else if (o.additionalProperties === false) errs.push(`${path}.${k}: not allowed`);
      else if (o.additionalProperties && typeof o.additionalProperties === 'object') validate(o.additionalProperties, x, `${path}.${k}`, errs);
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface Pricing {
  model: 'fixed' | 'metered';
  /** Gas charged for every answer. */
  baseGas: number;
  /** Metered only: Gas per row the company reports scanning (may be fractional, e.g. 0.05). */
  perRowGas: number;
  /** Metered only: Gas per millisecond of compute the company reports. */
  perComputeMsGas: number;
  /** Ceiling: the buyer is held for this (plus the fee) and never charged more. */
  maxGas: number;
}

export const MAX_GAS_PER_QUERY = 1_000_000; // $1,000 at the default Gas price
/** A self-query ("data about me") may cost at most this, and carries no PayPali fee. */
export const SUBJECT_QUERY_MAX_GAS = 100;

const num = (v: unknown, def = 0) => (v === undefined || v === null ? def : typeof v === 'number' && isFinite(v) ? v : NaN);

export function parsePricing(p: any): Pricing {
  if (!p || typeof p !== 'object') throw new Error('INVALID_PRICING');
  const model = p.model;
  if (model !== 'fixed' && model !== 'metered') throw new Error('INVALID_PRICING_MODEL');
  const baseGas = num(p.baseGas);
  const perRowGas = model === 'metered' ? num(p.perRowGas) : 0;
  const perComputeMsGas = model === 'metered' ? num(p.perComputeMsGas) : 0;
  if (!(Number.isInteger(baseGas) && baseGas >= 0 && baseGas <= MAX_GAS_PER_QUERY)) throw new Error('INVALID_PRICING_BASE');
  if (!(perRowGas >= 0 && perRowGas <= 1000)) throw new Error('INVALID_PRICING_PER_ROW');
  if (!(perComputeMsGas >= 0 && perComputeMsGas <= 1000)) throw new Error('INVALID_PRICING_PER_COMPUTE');
  if (model === 'metered' && perRowGas === 0 && perComputeMsGas === 0) throw new Error('METERED_PRICING_NEEDS_A_RATE');
  const maxGas = model === 'fixed' ? baseGas : num(p.maxGas);
  if (!(Number.isInteger(maxGas) && maxGas >= baseGas && maxGas <= MAX_GAS_PER_QUERY)) throw new Error('INVALID_PRICING_MAX');
  return { model, baseGas, perRowGas, perComputeMsGas, maxGas };
}

/** Metered price of one answer, in Gas, never above maxGas. */
export function meter(p: Pricing, usage: { rows: number; computeMs: number }): number {
  if (p.model === 'fixed') return p.baseGas;
  const raw = p.baseGas + usage.rows * p.perRowGas + usage.computeMs * p.perComputeMsGas;
  return Math.min(p.maxGas, Math.ceil(raw - 1e-9));
}

/** Rows a buyer's hold covers at the metered ceiling (null = unbounded by price). */
export function maxRowsFor(p: Pricing): number | null {
  if (p.model !== 'metered' || p.perRowGas === 0) return null;
  return Math.floor((p.maxGas - p.baseGas) / p.perRowGas);
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

export interface MinAggregation {
  /** Numeric field on each group holding the number of records it summarises. */
  field: string;
  /** Smallest group the company may report (k-anonymity floor). */
  min: number;
  /** Dotted path to the array of groups inside the result ("" or absent = the result itself). */
  rowsPath?: string;
}

export interface PrivacyRules {
  bannedFields: string[];
  minAggregation: MinAggregation | null;
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,7}$/;
export const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

export function parsePrivacy(p: any, opts: { subjectQuery?: boolean } = {}): PrivacyRules {
  const src = p ?? {};
  if (typeof src !== 'object' || Array.isArray(src)) throw new Error('INVALID_PRIVACY');
  const banned = src.bannedFields ?? [];
  if (!Array.isArray(banned) || banned.length > 100 || !banned.every((f: unknown) => typeof f === 'string' && FIELD.test(f))) throw new Error('INVALID_BANNED_FIELDS');
  let minAggregation: MinAggregation | null = null;
  if (src.minAggregation != null) {
    const m = src.minAggregation;
    if (typeof m !== 'object' || typeof m.field !== 'string' || !FIELD.test(m.field)) throw new Error('INVALID_MIN_AGGREGATION_FIELD');
    if (!(Number.isInteger(m.min) && m.min >= 2 && m.min <= 1_000_000)) throw new Error('INVALID_MIN_AGGREGATION_SIZE');
    if (m.rowsPath !== undefined && m.rowsPath !== '' && !(typeof m.rowsPath === 'string' && PATH.test(m.rowsPath))) throw new Error('INVALID_MIN_AGGREGATION_PATH');
    if (opts.subjectQuery) throw new Error('SUBJECT_QUERY_CANNOT_AGGREGATE');
    if (banned.some((b: string) => norm(b) === norm(m.field))) throw new Error('MIN_AGGREGATION_FIELD_IS_BANNED');
    minAggregation = { field: m.field, min: m.min, ...(m.rowsPath ? { rowsPath: m.rowsPath } : {}) };
  }
  return { bannedFields: [...new Set(banned as string[])], minAggregation };
}

/** Property names a schema declares, at any depth. */
function declaredFields(s: any, out: string[] = [], depth = 0): string[] {
  if (!s || typeof s !== 'object' || depth > 12) return out;
  if (s.properties && typeof s.properties === 'object') for (const [k, v] of Object.entries(s.properties)) { out.push(k); declaredFields(v, out, depth + 1); }
  if (s.items) declaredFields(s.items, out, depth + 1);
  if (s.additionalProperties && typeof s.additionalProperties === 'object') declaredFields(s.additionalProperties, out, depth + 1);
  return out;
}

/** The published output schema may not even declare a banned field. */
export function schemaDeclaresBanned(outputSchema: JsonSchema, rules: PrivacyRules): string | null {
  const banned = new Set(rules.bannedFields.map(norm));
  return declaredFields(outputSchema).find((f) => banned.has(norm(f))) ?? null;
}

/** Every key in a value, at any depth (arrays included). */
function* keysDeep(v: unknown, path = '$', depth = 0): Generator<[string, string]> {
  if (depth > 32) { yield ['__too_deep__', path]; return; }
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) yield* keysDeep(v[i], `${path}[${i}]`, depth + 1); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { yield [k, `${path}.${k}`]; yield* keysDeep(x, `${path}.${k}`, depth + 1); }
}

const getPath = (v: unknown, path?: string) => (path ? path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>)[k] : undefined), v) : v);

/** Privacy violations in a result (empty = clean). Codes are stable; detail is for the seller. */
export function privacyViolations(result: unknown, rules: PrivacyRules): Array<{ code: string; at: string }> {
  const out: Array<{ code: string; at: string }> = [];
  const banned = new Set(rules.bannedFields.map(norm));
  for (const [k, at] of keysDeep(result)) {
    if (k === '__too_deep__') { out.push({ code: 'RESULT_TOO_DEEP', at }); break; }
    if (banned.has(norm(k))) out.push({ code: 'BANNED_FIELD', at });
    if (out.length > 20) break;
  }
  const m = rules.minAggregation;
  if (m) {
    const target = getPath(result, m.rowsPath);
    const groups = Array.isArray(target) ? target : target && typeof target === 'object' ? [target] : null;
    if (!groups) out.push({ code: 'AGGREGATION_GROUPS_MISSING', at: m.rowsPath ? `$.${m.rowsPath}` : '$' });
    else groups.forEach((g, i) => {
      const at = `${m.rowsPath ? `$.${m.rowsPath}` : '$'}${Array.isArray(target) ? `[${i}]` : ''}.${m.field}`;
      const n = g && typeof g === 'object' ? (g as Record<string, unknown>)[m.field] : undefined;
      if (typeof n !== 'number' || !Number.isFinite(n)) out.push({ code: 'AGGREGATION_SIZE_MISSING', at });
      else if (n < m.min) out.push({ code: 'AGGREGATION_BELOW_MINIMUM', at });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Question type definition (what a company publishes)
// ---------------------------------------------------------------------------

export interface QuestionTypeInput {
  key: string;
  title: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  pricing: unknown;
  freshnessSeconds: number;
  accuracyClaim: number;
  privacy?: unknown;
  allowedPurposes?: string[];
  subjectQuery?: boolean;
  active?: boolean;
}

export const KEY = /^[a-z][a-z0-9_]{1,39}$/;
export const PURPOSE = /^[a-z][a-z0-9_]{1,39}$/;
/** The only purpose a self-query may carry. */
export const SELF_ACCESS = 'self_access';

export function parseQuestionType(q: QuestionTypeInput) {
  if (!q || typeof q !== 'object') throw new Error('INVALID_QUESTION_TYPE');
  if (typeof q.key !== 'string' || !KEY.test(q.key)) throw new Error('INVALID_QUESTION_KEY');
  const title = String(q.title ?? '').trim();
  if (!title || title.length > 120) throw new Error('INVALID_QUESTION_TITLE');
  const description = String(q.description ?? '').trim().slice(0, 2000);
  for (const [name, s] of [['INPUT', q.inputSchema], ['OUTPUT', q.outputSchema]] as const) {
    const e = checkSchemaShape(s);
    if (e) throw new Error(`INVALID_${name}_SCHEMA:${e}`);
  }
  const subjectQuery = q.subjectQuery === true;
  const pricing = parsePricing(q.pricing);
  if (subjectQuery && !(pricing.model === 'fixed' && pricing.baseGas <= SUBJECT_QUERY_MAX_GAS)) throw new Error('SUBJECT_QUERY_MUST_BE_AT_COST');
  if (!(Number.isInteger(q.freshnessSeconds) && q.freshnessSeconds >= 1 && q.freshnessSeconds <= 31_536_000)) throw new Error('INVALID_FRESHNESS');
  if (!(typeof q.accuracyClaim === 'number' && q.accuracyClaim >= 0.5 && q.accuracyClaim <= 0.99)) throw new Error('INVALID_ACCURACY_CLAIM');
  const privacy = parsePrivacy(q.privacy, { subjectQuery });
  const leaked = schemaDeclaresBanned(q.outputSchema, privacy);
  if (leaked) throw new Error(`OUTPUT_SCHEMA_DECLARES_BANNED_FIELD:${leaked}`);
  let allowedPurposes = q.allowedPurposes ?? [];
  if (!Array.isArray(allowedPurposes) || allowedPurposes.length > 20 || !allowedPurposes.every((p) => typeof p === 'string' && PURPOSE.test(p))) throw new Error('INVALID_ALLOWED_PURPOSES');
  if (subjectQuery) allowedPurposes = [SELF_ACCESS];
  else if (allowedPurposes.includes(SELF_ACCESS)) throw new Error('SELF_ACCESS_IS_FOR_SUBJECT_QUERIES');
  return {
    key: q.key, title, description, inputSchema: q.inputSchema, outputSchema: q.outputSchema, pricing,
    freshnessSeconds: q.freshnessSeconds, accuracyClaim: q.accuracyClaim, privacy, allowedPurposes: [...new Set(allowedPurposes)],
    subjectQuery, active: q.active !== false,
  };
}
