/**
 * Claiming a client seat without letting the platform's own schedule kill the
 * plugin.
 *
 * The failure this exists to prevent, in the legacy project's own words:
 *
 *   "the platform declares the `conversation.view` slot table on its own
 *    (async) schedule; a register call that loses that race would throw and
 *    take down the WHOLE plugin apply"
 *
 * The symptom was a harness banner reading `slot "conversation.view" is not
 * declared`, with the entire feature gone from the page — roughly one load in
 * twenty-five. Throwing is the *normal* outcome of registering too early, so
 * "try again" and "this plugin is broken" must be different outcomes. Here they
 * are.
 *
 * Giving up is still possible and still bounded: after the retry budget the
 * plugin reports one diagnostic naming the slot and what it tried, and stops.
 * It never retries forever, and it never fails the whole apply.
 */

import type { SlotEntry, SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

export interface SlotClaim {
  readonly slots: SlotsService
  readonly entry: SlotEntry
  readonly component: unknown
  /** Total attempts, including the first. */
  readonly attempts?: number
  /** Delay before attempt *n* is `baseDelayMs * n` (linear backoff). */
  readonly baseDelayMs?: number
  /** Called once with the last error when the budget is exhausted. */
  readonly onGaveUp?: (error: unknown, entry: SlotEntry) => void
}

const DEFAULT_ATTEMPTS = 10
const DEFAULT_BASE_DELAY_MS = 300

/**
 * Register `entry`, retrying while the target slot's table has not been
 * declared yet.
 *
 * @returns a disposer that cancels any pending retry and, when a registration
 *   succeeded, releases it. Safe to call more than once.
 */
export function claimSlot(claim: SlotClaim): () => void {
  const attempts = claim.attempts ?? DEFAULT_ATTEMPTS
  const baseDelayMs = claim.baseDelayMs ?? DEFAULT_BASE_DELAY_MS

  let disposeRegistration: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let tries = 0
  let released = false

  const attempt = (): void => {
    if (released || disposeRegistration !== null) return
    tries += 1
    try {
      disposeRegistration = claim.slots.register(claim.entry, claim.component)
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    } catch (error) {
      if (tries >= attempts) {
        claim.onGaveUp?.(error, claim.entry)
        return
      }
      timer = setTimeout(attempt, baseDelayMs * tries)
    }
  }

  attempt()

  return () => {
    released = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    disposeRegistration?.()
    disposeRegistration = null
  }
}

/**
 * Resolve the client `slots` service, or explain why it is missing.
 *
 * `inject = ['slots']` in the module exports is what makes reading it legal —
 * the client registry guards service reads, and without the declaration `apply`
 * is refused silently: the module is in the graph, the bundle is served, the
 * revision is right, and nothing renders. That cost the legacy project a long
 * debugging session, so the diagnostic names the declaration explicitly.
 */
export function resolveSlots(
  get: (name: string) => unknown,
  pluginName: string,
): SlotsService | null {
  const slots = get('slots')
  if (slots === undefined || slots === null || typeof (slots as SlotsService).register !== 'function') {
    console.warn(
      `[${pluginName}] the client 'slots' service is unavailable. `
      + 'This plugin declares `inject = [\'slots\']`; if that declaration is missing from the '
      + 'module exports, the registry refuses the read without an error. '
      + `Got: ${slots === undefined ? 'service absent' : typeof slots}`,
    )
    return null
  }
  return slots as SlotsService
}
