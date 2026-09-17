/**
 * Turning user text into something the platform's prompt renderer cannot choke on.
 *
 * ## The failure this prevents
 *
 * `@deepseek-ai/dsh-system-prompt` interpolates every section and context with a
 * strict scanner. Read out of the running 0.1.6-alpha.1 build:
 *
 *     const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
 *     for (let open = text.indexOf("{{"); open >= 0; ...) {
 *       // a {{ with a later }} that is not a clean group   -> throw
 *       // a well-formed name that is not registered        -> throw
 *       // a registered name whose value is undefined       -> throw
 *     }
 *
 * Three of those four are reachable from ordinary writing. A character persona
 * containing `{{char}}` — the most natural thing in the world to write — is an
 * *unregistered* variable, so **every request for that member fails**. It is not
 * a display problem; the turn cannot complete. That was a late P0 in the legacy
 * project.
 *
 * ## The guarantee
 *
 * Not "unknown macros are replaced". The guarantee is stronger and easier to
 * check: **the returned string contains no `{{` at all.**
 *
 * The renderer's loop only ever starts at a `{{`. Remove every one of them and
 * the scanner finds nothing to validate, so none of the throws can happen —
 * including combinations nobody thought of, and including any that a future
 * platform version adds. A weaker rule ("no unknown names") would have to track
 * the platform's registered set, which is not enumerable from a plugin and can
 * change under us.
 *
 * ## Why this lives in the shared contract
 *
 * Both packages need it: group-chat for personas and briefings, the tavern for
 * world-info content on its way into a prompt context. The legacy project
 * maintained two byte-identical copies of exactly this kind of file, and had to
 * keep them in step by hand. One copy, imported by both.
 *
 * ## Values count too
 *
 * Macro *values* are neutralised as well. It is tempting to skip that — the
 * platform does not rescan a value it substituted itself — but we are not the
 * platform: we substitute, and the platform then scans **our** output. A value
 * containing `{{model}}` would therefore be a live reference by the time the
 * platform sees it.
 *
 * @module @dsh-tavern/contracts/prompt-text
 */

/** A complete `{{name}}` group, matching the platform's own scanner. */
const GROUP = /\{\{([^{}]*)\}\}/

/** The name rule the platform enforces. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/**
 * Replace macro syntax with full-width brackets.
 *
 * Full-width rather than deletion: the user's intent stays readable in the prompt
 * and in the UI, and `〔char〕` cannot be mistaken for a variable by any version
 * of the scanner.
 */
function neutralise(text: string): string {
  return text.replaceAll('{{', '〔').replaceAll('}}', '〕')
}

/**
 * Resolve every macro, and remove every `{{`.
 *
 * @param text - user-authored text, on its way into a prompt section.
 * @param macros - the values this assembly can supply. Names are matched
 *   case-sensitively and only when they satisfy the platform's name rule; a
 *   macro the caller did not supply becomes a visible literal rather than a
 *   throw.
 * @returns text with no `{{` in it. Substituted values are neutralised too.
 */
export function sanitizePromptText(text: string, macros: Readonly<Record<string, string>> = {}): string {
  if (text.length === 0) return ''

  let out = ''
  let cursor = 0

  for (;;) {
    const open = text.indexOf('{{', cursor)
    if (open < 0) {
      out += text.slice(cursor)
      return out
    }

    out += text.slice(cursor, open)

    const match = GROUP.exec(text.slice(open))
    if (match === null || match.index !== 0) {
      // A `{{` with no closing `}}` after it. The platform treats this as prose,
      // and it remains prose here — but its braces still go, because the
      // guarantee is about `{{` and not about what happens to follow it.
      out += '〔'
      cursor = open + 2
      continue
    }

    const name = match[1] ?? ''
    const known = VARIABLE_NAME.test(name) && Object.hasOwn(macros, name)
    if (known) {
      out += neutralise(macros[name] ?? '')
    } else {
      // Unknown, or malformed like `{{ model }}`. Kept as visible text so the
      // author can see that it did not resolve — the legacy project's original
      // bug was that an unresolved macro was *invisible* until every request
      // failed.
      out += `〔${neutralise(name)}〕`
    }
    cursor = open + match[0].length
  }
}
