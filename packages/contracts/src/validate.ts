/**
 * The generic half of a boundary validator: primitives, and nothing else.
 *
 * These live in the shared contract because both plugins need them. The legacy
 * project kept two byte-identical copies of this kind of file and had to hold
 * them in step by hand — the same trap the prompt sanitiser was moved here to
 * avoid.
 *
 * Every function is pure and synchronous, so a boundary is testable without a
 * runtime. None of them trims, defaults, or coerces: a value that is not
 * acceptable is refused, and the caller learns which field and why. A fallback
 * where a rejection belonged is how the legacy project produced ghost groups and
 * a book that injected itself into every session in the process.
 *
 * Feature-specific shapes (rooms, members, books, entries) stay in their own
 * package, built from these.
 *
 * @module @dsh-tavern/contracts/validate
 */

import { isId, reject } from './index.ts'
import { LIMITS } from './index.ts'

/** Render an offending value for an error message without risking a throw. */
export function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value.length > 60 ? `${JSON.stringify(value.slice(0, 57))}...` : JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `array(${value.length})`
  return typeof value
}

export function requireId(field: string, value: unknown): string {
  if (!isId(value)) reject(field, `must match the id charset ${String(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)}, got ${describe(value)}`)
  return value
}

/** An optional id: absent stays absent, present must be valid. */
export function optionalId(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireId(field, value)
}

/**
 * A required display name.
 *
 * Note what is *not* here: trimming, collapsing, or defaulting. A name that is
 * empty after trimming is rejected, not quietly replaced — that is the poison
 * pill that once made an entire storage domain unopenable on the next boot.
 */
export function requireName(field: string, value: unknown, max: number = LIMITS.name): string {
  if (typeof value !== 'string') reject(field, `must be a string, got ${describe(value)}`)
  if (value.trim().length === 0) reject(field, 'must not be empty or whitespace-only')
  if (value.length > max) reject(field, `is ${value.length} characters, over the ${max} limit`)
  return value
}

/**
 * A value from a closed set.
 *
 * This is the function whose absence caused the ghost-group and
 * inject-everywhere bugs. There is no default and no coercion: an unknown
 * member of the set is an error, and the message names what was allowed.
 */
export function requireEnum<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    reject(field, `must be one of ${allowed.map((a) => JSON.stringify(a)).join(' | ')}, got ${describe(value)}`)
  }
  return value as T
}

/** An optional bounded integer. */
export function optionalInt(field: string, value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) reject(field, `must be an integer, got ${describe(value)}`)
  if (value < min || value > max) reject(field, `must be between ${min} and ${max}, got ${value}`)
  return value
}

/** A required bounded integer. */
export function requireInt(field: string, value: unknown, min: number, max: number): number {
  const parsed = optionalInt(field, value, min, max)
  if (parsed === undefined) reject(field, 'is required')
  return parsed
}

/** An optional string of bounded length. */
export function optionalText(field: string, value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') reject(field, `must be a string, got ${describe(value)}`)
  if (value.length > max) reject(field, `is ${value.length} characters, over the ${max} limit`)
  return value
}

/** An optional array of unique, well-formed ids. */
export function optionalIdArray(field: string, value: unknown, max: number): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) reject(field, `must be an array, got ${describe(value)}`)
  if (value.length > max) reject(field, `has ${value.length} entries, over the ${max} limit`)
  const seen = new Set<string>()
  const out: string[] = []
  for (const [index, entry] of value.entries()) {
    const id = requireId(`${field}[${index}]`, entry)
    if (seen.has(id)) reject(`${field}[${index}]`, `duplicates ${JSON.stringify(id)}`)
    seen.add(id)
    out.push(id)
  }
  return out
}
