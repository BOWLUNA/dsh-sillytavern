/**
 * Binding rows — which books are attached to which target, and by whom.
 *
 * This module is the structural answer to the single most expensive bug class
 * in the legacy project. There, one table held "the book ids bound to target X"
 * and had two legitimate writers:
 *
 *   - the group lifecycle, which added its own book on start and removed it on
 *     stop (`addBinding` / `removeBinding`);
 *   - the binding overview, where a human edited the whole row (`setBinding`).
 *
 * The overview loaded a snapshot of the row, let the user edit it, and saved
 * the whole row back — so a save based on a stale snapshot silently deleted
 * every book the lifecycle had added in the meantime. It was found, "fixed" by
 * moving the lifecycle to targeted writes, and then found *again* from the
 * other side, because the overview itself was still doing whole-row writes.
 * Two audits, two packages, one lost-data path.
 *
 * The conclusion written into the architecture doc was a rule for humans:
 * "cross-plugin binding may only be targeted add/remove". Rules for humans are
 * exactly what gets forgotten.
 *
 * So here ownership is **structural**: every row is keyed by `owner + target`,
 * and no operation can reach another owner's row. The whole class of clobbering
 * writes is unrepresentable rather than merely discouraged. Resolution unions
 * the rows, which is what injection actually wants.
 *
 * Everything in this file is pure. `tests/bindings.test.ts` pins it.
 */

import { LIMITS, Owner, compositeKey, isOwner, reject } from '@dsh-tavern/contracts'

export interface BindingRow {
  readonly owner: Owner
  readonly targetId: string
  readonly bookIds: readonly string[]
  /** Millisecond timestamp of the last write to this row. */
  readonly updatedAt: number
}

/** Key of one owner's row about one target. Ownership is part of the key. */
export function bindingKey(owner: Owner, targetId: string): string {
  return compositeKey(owner, targetId)
}

/** One owner's row about one target, if it exists. */
export function rowOf(
  rows: readonly BindingRow[],
  owner: Owner,
  targetId: string,
): BindingRow | undefined {
  return rows.find((row) => row.owner === owner && row.targetId === targetId)
}

/**
 * Every book attached to `targetId`, unioned across owners.
 *
 * Order is deterministic: owners are visited in a fixed order and each owner's
 * own order is preserved, so an unchanged binding set always renders and
 * injects identically. Order matters to the prompt, so it must not depend on
 * map iteration or write history.
 */
export function resolveBooks(rows: readonly BindingRow[], targetId: string): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const owner of [Owner.User, Owner.Tavern, Owner.GroupChat] as const) {
    for (const row of rows) {
      if (row.owner !== owner || row.targetId !== targetId) continue
      for (const bookId of row.bookIds) {
        if (seen.has(bookId)) continue
        seen.add(bookId)
        out.push(bookId)
      }
    }
  }
  return out
}

/**
 * Every book id bound to any of `targetIds`, unioned across owners.
 *
 * This is what decides whether world info applies at all, and it used to live in
 * the service — where it could not be tested, because that module imports the
 * platform. Its failure mode is silence: bind a book, see nothing injected, and
 * have nothing to look at. Pulled out here for the same reason as everything
 * else on this side of the line.
 */
export function bookIdsForTargets(
  rows: readonly BindingRow[],
  targetIds: readonly string[],
): readonly string[] {
  const wanted = new Set<string>()
  for (const row of rows) {
    if (!targetIds.includes(row.targetId)) continue
    for (const bookId of row.bookIds) wanted.add(bookId)
  }
  return [...wanted]
}

/** Every target with at least one binding, in first-seen order. */
export function boundTargets(rows: readonly BindingRow[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const row of rows) {
    if (seen.has(row.targetId)) continue
    seen.add(row.targetId)
    out.push(row.targetId)
  }
  return out
}

function checkOwner(value: unknown): Owner {
  if (!isOwner(value)) reject('owner', `must be one of ${Object.values(Owner).join(' | ')}, got ${String(value)}`)
  return value
}

function checkTarget(targetId: unknown): string {
  if (typeof targetId !== 'string' || targetId.length === 0 || targetId.length > LIMITS.id) {
    reject('targetId', `must be a non-empty string of at most ${LIMITS.id} characters`)
  }
  return targetId
}

function checkBooks(bookIds: readonly unknown[]): readonly string[] {
  if (bookIds.length > LIMITS.bindings) {
    reject('bookIds', `has ${bookIds.length} entries, over the limit of ${LIMITS.bindings}`)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const [index, bookId] of bookIds.entries()) {
    if (typeof bookId !== 'string' || bookId.length === 0 || bookId.length > LIMITS.id) {
      reject(`bookIds[${index}]`, `must be a non-empty string of at most ${LIMITS.id} characters`)
    }
    if (seen.has(bookId)) reject(`bookIds[${index}]`, `duplicates ${JSON.stringify(bookId)}`)
    seen.add(bookId)
    out.push(bookId)
  }
  return out
}

/** Replace one owner's row wholesale. The other owners' rows are untouched. */
export function setBooks(
  rows: readonly BindingRow[],
  owner: Owner,
  targetId: string,
  bookIds: readonly string[],
  now: number,
): readonly BindingRow[] {
  const checkedOwner = checkOwner(owner)
  const checkedTarget = checkTarget(targetId)
  const checkedBooks = checkBooks(bookIds)

  const others = rows.filter((row) => !(row.owner === checkedOwner && row.targetId === checkedTarget))
  if (checkedBooks.length === 0) return others

  return [...others, {
    owner: checkedOwner,
    targetId: checkedTarget,
    bookIds: checkedBooks,
    updatedAt: now,
  }]
}

/** Attach one book to one owner's row. Idempotent. */
export function addBook(
  rows: readonly BindingRow[],
  owner: Owner,
  targetId: string,
  bookId: string,
  now: number,
): readonly BindingRow[] {
  const checkedOwner = checkOwner(owner)
  const checkedTarget = checkTarget(targetId)
  const [checkedBook] = checkBooks([bookId])
  if (checkedBook === undefined) reject('bookId', 'is required')

  const current = rowOf(rows, checkedOwner, checkedTarget)
  if (current?.bookIds.includes(checkedBook)) return rows

  const bookIds = [...(current?.bookIds ?? []), checkedBook]
  if (bookIds.length > LIMITS.bindings) {
    reject('bookIds', `adding would reach ${bookIds.length} entries, over the limit of ${LIMITS.bindings}`)
  }

  return [
    ...rows.filter((row) => !(row.owner === checkedOwner && row.targetId === checkedTarget)),
    { owner: checkedOwner, targetId: checkedTarget, bookIds, updatedAt: now },
  ]
}

/**
 * Detach one book from one owner's row. Idempotent.
 *
 * An emptied row is dropped rather than kept as an empty array, so "no row"
 * and "a row with nothing in it" cannot mean different things.
 */
export function removeBook(
  rows: readonly BindingRow[],
  owner: Owner,
  targetId: string,
  bookId: string,
): readonly BindingRow[] {
  const checkedOwner = checkOwner(owner)
  const checkedTarget = checkTarget(targetId)

  const current = rowOf(rows, checkedOwner, checkedTarget)
  if (current === undefined || !current.bookIds.includes(bookId)) return rows

  const bookIds = current.bookIds.filter((id) => id !== bookId)
  const others = rows.filter((row) => !(row.owner === checkedOwner && row.targetId === checkedTarget))
  if (bookIds.length === 0) return others

  return [...others, { ...current, bookIds }]
}

/**
 * Drop every row belonging to `owner` for a target that no longer exists.
 *
 * Used when a room or member is deleted: only that owner's rows are removed,
 * so a human's manual binding for a re-created target survives.
 */
export function dropOwnerRows(
  rows: readonly BindingRow[],
  owner: Owner,
  targetId: string,
): readonly BindingRow[] {
  return rows.filter((row) => !(row.owner === owner && row.targetId === targetId))
}
