/**
 * The prompt-safety guarantee.
 *
 * ## Why the central assertion is a property, not a case list
 *
 * The platform's renderer is a loop that starts at `text.indexOf('{{')`. Read
 * from the running 0.1.6-alpha.1 build: if that index is `-1`, the loop body
 * never executes and the function returns the text unchanged. All three throw
 * sites — malformed reference, malformed name, unregistered name — are *inside*
 * that loop.
 *
 * So "the output contains no `{{`" is not a heuristic that happens to cover the
 * cases below; it is a sufficient condition for the renderer never throwing,
 * whatever it does with the text afterwards and whatever a future version adds.
 * The corpus exists to make the property hard to break by accident, not to
 * establish it.
 *
 * Run: node --test tests/prompt.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { briefing, persona, relayLine, sanitizePromptText } from '../src/prompt.ts'

/** The invariant, in one place so every test can state it the same way. */
function assertSafe(text: string, label: string): void {
  assert.ok(
    !text.includes('{{'),
    `${label}: the output still contains "{{", which is the only place the platform's renderer can throw:\n${text}`,
  )
}

// ────────────────────────────────────────────────────────────────────────────
// The property.
// ────────────────────────────────────────────────────────────────────────────

test('no input produces output containing "{{"', () => {
  const macros = { char: '甲', user: '我', model: 'deepseek-v4-flash' }
  const corpus = [
    '',
    'plain text',
    '{{char}}',
    '{{ char }}',
    '{{Char}}',
    '{{}}',
    '{{',
    '{{}}',
    'a {{ b',
    'a {{ b }} c',
    '{{a}}{{b}}',
    '{{{char}}}',
    '{{char}{{user}}',
    '}}',
    '}}{{',
    '{{unknown}}',
    '{{unknown}} and {{char}}',
    'nested {{ {{char}} }}',
    '｛｛char｝｝',
    '{{char',
    '{{char}',
    '{{char}} {{',
    '{{' .repeat(50),
    'x'.repeat(10) + '{{char}}' + '}}'.repeat(10),
    // A name that is well-formed but unknown, adjacent to a known one.
    '{{model}}{{nope}}',
  ]

  for (const input of corpus) {
    assertSafe(sanitizePromptText(input, macros), JSON.stringify(input))
  }
})

test('a macro value cannot smuggle a live reference in', () => {
  // We substitute, then the platform scans *our* output. A value carrying
  // `{{model}}` would therefore be live by the time the platform sees it —
  // even though the platform never rescans a value it substituted itself.
  const out = sanitizePromptText('{{persona}}', { persona: 'likes {{model}} a lot' })
  assertSafe(out, 'macro value')
  assert.match(out, /likes 〔model〕 a lot/)
})

test('a lone "{{" is neutralised too, even though the platform would tolerate it', () => {
  // The platform treats an unclosed `{{` as prose. We remove it anyway: the
  // guarantee is simpler to state, and simpler to keep true under edits.
  assertSafe(sanitizePromptText('cost is {{ 5', {}), 'lone braces')
})

// ────────────────────────────────────────────────────────────────────────────
// Behaviour the users see.
// ────────────────────────────────────────────────────────────────────────────

test('a known macro expands to its value', () => {
  assert.equal(sanitizePromptText('I am {{char}}.', { char: '甲' }), 'I am 甲.')
})

test('an unknown macro becomes visible text rather than an error', () => {
  // The legacy P0 in one line: `{{char}}` in a persona made every request fail,
  // and nothing said why. Now it is visibly unresolved.
  const out = sanitizePromptText('call me {{char}}', {})
  assert.equal(out, 'call me 〔char〕')
})

test('a malformed group keeps its inner text', () => {
  // `{{ model }}` is malformed to the platform — the name rule forbids spaces —
  // and would throw.
  assert.equal(sanitizePromptText('{{ model }}', { model: 'x' }), '〔 model 〕')
  assert.equal(sanitizePromptText('{{Model}}', { Model: 'x' }), '〔Model〕')
})

test('an empty group collapses to an empty literal, not to nothing', () => {
  // Collapsing to nothing would delete a marker the author wrote on purpose.
  assert.equal(sanitizePromptText('a{{}}b', {}), 'a〔〕b')
})

test('adjacent and nested groups are all resolved in one pass', () => {
  assert.equal(
    sanitizePromptText('{{char}}{{user}}', { char: '甲', user: '我' }),
    '甲我',
  )

  // `{{a{{char}}` is genuinely ambiguous, and the resolution follows the
  // platform's own grouping rule rather than a guess: `[^{}]*` cannot span the
  // inner `{`, so the first `{{` is NOT a complete group — the platform and this
  // module agree on that, which is what makes the guarantee meaningful. It is
  // neutralised as an unterminated open, and the inner group is still a group,
  // so it expands.
  const nested = sanitizePromptText('{{a{{char}}', { char: '甲' })
  assert.equal(nested, '〔a甲')
  assertSafe(nested, 'nested')
})

test('text without macros is returned unchanged', () => {
  const text = 'ordinary 中文 prose, with } and { singles.'
  assert.equal(sanitizePromptText(text, { char: '甲' }), text)
})

// ────────────────────────────────────────────────────────────────────────────
// The other prompt pieces.
// ────────────────────────────────────────────────────────────────────────────

test('a relay names the speaker and leaves the body alone', () => {
  // The body is the room's transcript. Rewriting it here would make what the
  // members see differ from what the room records.
  assert.equal(relayLine('甲', '{{char}} said hi'), '甲：{{char}} said hi')
})

test('the briefing lists every member and explains the relay convention', () => {
  const text = briefing('测试群', ['甲', '乙', '丙'])
  assert.match(text, /测试群/)
  for (const name of ['甲', '乙', '丙']) assert.match(text, new RegExp(name))
  assert.match(text, /名字：/)
})

test('a persona drops empty fields instead of emitting empty headings', () => {
  const text = persona({ name: '甲', description: '沉默', personality: '', scenario: '雨夜' })
  assert.match(text, /你的名字是甲/)
  assert.match(text, /人物设定：\n沉默/)
  assert.match(text, /场景：\n雨夜/)
  assert.ok(!text.includes('性格'), 'an empty personality must not produce a heading')
})

test('a persona that is only a name still reads as one paragraph', () => {
  assert.equal(persona({ name: '甲', description: '', personality: '', scenario: '' }), '你的名字是甲。')
})
