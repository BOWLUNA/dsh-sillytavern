/**
 * Internal consistency of the Remote descriptor table.
 *
 * What this does NOT check, and why: whether each descriptor names a method that
 * actually exists on the service with that arity. Importing the service class
 * would require `@deepseek-ai/*` at runtime, and this workspace deliberately does
 * not have it installed (see `autoInstallPeers` in `pnpm-workspace.yaml`) — a
 * second copy of `cordis` would fork Service identity.
 *
 * That correspondence is checked instead where it actually matters: from a real
 * browser, against a real host, by `tools/browser-verify.mjs`. A descriptor that
 * names a missing method fails the moment the page calls it, which is a stronger
 * signal than an arity comparison — and it is the path users take.
 *
 * Run: node --test tests/remote.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GROUP_CHAT_REMOTES, NAMESPACE } from '../src/remote.ts'

test('every descriptor is a unary, direct invocation in one namespace', () => {
  assert.ok(GROUP_CHAT_REMOTES.length > 0, 'the table must not be empty')
  for (const descriptor of GROUP_CHAT_REMOTES) {
    assert.equal(descriptor.service, NAMESPACE, `${descriptor.method}: wrong service key`)
    assert.equal(descriptor.namespace, NAMESPACE, `${descriptor.method}: wrong namespace`)
    assert.deepEqual(descriptor.invocation, { kind: 'direct' }, `${descriptor.method}: not a direct call`)
    assert.equal(descriptor.mode, undefined, `${descriptor.method}: unexpected stream mode`)
  }
})

test('descriptor ids and method names are unique', () => {
  const ids = GROUP_CHAT_REMOTES.map((descriptor) => descriptor.id)
  const methods = GROUP_CHAT_REMOTES.map((descriptor) => descriptor.method)
  assert.equal(new Set(ids).size, ids.length, `duplicate descriptor id in ${ids.join(', ')}`)
  assert.equal(new Set(methods).size, methods.length, `duplicate method name in ${methods.join(', ')}`)
})

test('every parameter is described as an ordered JSON wire field', () => {
  for (const descriptor of GROUP_CHAT_REMOTES) {
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.source, 'json', `${descriptor.method}.${parameter.name}: not a JSON parameter`)
      // A wire field that differs from the source name is legal, but then both
      // sides must agree and the gateway reads the wire one. Keeping them equal
      // is the whole reason these are generated from a list of names.
      assert.equal(parameter.wire, parameter.name, `${descriptor.method}.${parameter.name}: wire name drift`)
      assert.deepEqual(parameter.codec, { mode: 'src-json' }, `${descriptor.method}.${parameter.name}: codec`)
      assert.equal(parameter.acceptsUndefined, undefined, `${descriptor.method}.${parameter.name}: optional parameter`)
    }
  }
})

test('the table describes exactly the room and member surface', () => {
  // Pinning the set makes a removed or renamed endpoint a test failure rather
  // than a 404 discovered in the browser.
  assert.deepEqual(
    GROUP_CHAT_REMOTES.map((descriptor) => `${descriptor.method}/${descriptor.parameters.length}`),
    [
      'ping/0',
      'roomCount/0',
      'listRooms/0',
      'getRoom/1',
      'createRoom/1',
      'deleteRoom/1',
      'listMembers/1',
      'addMember/2',
      'removeMember/2',
      'startGroup/1',
      'stopGroup/1',
      'pauseGroup/1',
      'resumeGroup/1',
      'pickSpeaker/2',
      'rerollTake/3',
      'getRoomState/1',
    ],
  )
})
