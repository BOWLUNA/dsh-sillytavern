/**
 * Turning user text into something the platform's prompt renderer cannot choke on.
 *
 * ## The failure this prevents
 *
 * `@deepseek-ai/dsh-system-prompt` interpolates every section and context with a
 * strict scanner. Read out of the running 0.1.6-alpha.1 build:
 *
 *     const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
 *     // a complete {{name}} group whose name is malformed  -> throw
 *     // a {{ with a later }} that is not a clean group      -> throw
 *     // a well-formed name that is not registered           -> throw
 *     // a registered name whose value is undefined          -> throw
 *
 * Three of those four are reachable from ordinary user writing. A character
 * persona containing `{{char}}` — the most natural thing in the world to write —
 * is an *unregistered* variable, so **every request for that member fails**.
 * That is not a display bug; the turn cannot complete. It was a P0 in the legacy
 * project, found late, and its fix is the reason this module exists.
 *
 * ## The guarantee
 *
 * Not "unknown macros are replaced". The guarantee is stronger and easier to
 * check: **the returned string contains no `{{` at all.**
 *
 * The renderer's loop only ever starts at a `{{`. Remove every one of them and
 * the scanner finds nothing to validate, so none of the four throws can happen —
 * including combinations nobody thought of, and including any that a future
 * platform version adds. A weaker rule ("no unknown names") would have to track
 * the platform's registered set, which is not enumerable from a plugin and can
 * change under us.
 *
 * `tests/prompt.test.ts` asserts the guarantee against a corpus of hostile
 * inputs, plus the property directly: `!output.includes('{{')`.
 *
 * ## Values count too
 *
 * Macro *values* are neutralised as well. It is tempting to skip that — the
 * platform does not rescan a value it substituted itself — but we are not the
 * platform: we substitute, and the platform then scans **our** output. A value
 * containing `{{model}}` would therefore be a live reference by the time the
 * platform sees it.
 *
 * @module dsh-group-chat/prompt
 */

import { sanitizePromptText } from '@dsh-tavern/contracts'

export { sanitizePromptText }

/**
 * One member's relay: what they see as the thing being said to them.
 *
 * The `name：text` shape is what tells a member who is speaking, and it is the
 * only structural thing in a relay. The body is left alone: a relay is a
 * conversation message, not a prompt section, so the platform never interpolates
 * it. Sanitising it here would silently rewrite the room's transcript.
 */
export function relayLine(speakerName: string, text: string): string {
  return `${speakerName}：${text}`
}

/**
 * The roster paragraph every member receives.
 *
 * Explains the relay convention, because without it members answer the room as
 * if it were one person talking to them. Deliberately short: this text is paid
 * for on every single request.
 */
export function briefing(roomName: string, memberNames: readonly string[]): string {
  const roster = memberNames.join('、')
  return [
    `你正在「${roomName}」这个多人房间里。房间成员：${roster}。`,
    '每条消息以「名字：」开头，那是别人说的话。你只说自己的话，不要替别人发言。',
    '只输出你要说的内容本身，不要加名字前缀，也不要加任何解释。',
  ].join('\n')
}

/**
 * The persona block for one member.
 *
 * Fields are labelled rather than concatenated bare, so the model can tell
 * description from personality from scenario. Empty fields are dropped rather
 * than emitted as empty headings.
 */
export function persona(member: {
  readonly name: string
  readonly description: string
  readonly personality: string
  readonly scenario: string
}): string {
  const blocks: string[] = [`你的名字是${member.name}。`]
  if (member.description.trim() !== '') blocks.push(`人物设定：\n${member.description}`)
  if (member.personality.trim() !== '') blocks.push(`性格：\n${member.personality}`)
  if (member.scenario.trim() !== '') blocks.push(`场景：\n${member.scenario}`)
  return blocks.join('\n\n')
}
