import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const name = 'list_subagent_models'
const header = (id, cwd) => ({ header: { id, cwd }, inheritedEventCount: 0, snapshotEvents: () => [{ seq: 0, type: 'request/header', data: { header: { tools: [{ name }] } } }] })

function harness() {
  const config = { enabled: true, workspace: '/a', hiddenTools: [name] }
  const listeners = {}, byId = new Map(), held = new Map()
  const records = [1, 2, 3].map(i => header(String(i), '/b'))
  const ctx = {
    fiber: { entry: {} },
    tools: { definitions: () => [{ name }] },
    agents: { list: () => [...byId.values()], get: id => byId.get(id) },
    workingDirectory: { get: s => s.cwd },
    sessionQuery: { listSessions: async () => records, inspectSession: async (id, read) => read(records.find(r => r.header.id === id)) },
    get: () => ({ edit: async (_entry, change) => Object.assign(config, change(config, {})) }),
    commands: { register: command => { listeners.command = command.handler } },
    on: (event, callback) => { listeners[event] = callback },
    effect: callback => { listeners.unload = callback() },
  }
  function agent(id, cwd) {
    const a = { id, session: { id, cwd } }
    a.ctx = { tools: { restrict: ({ deny }) => { held.set(id, deny); return () => held.delete(id) } }, effect: fn => fn() }
    byId.set(id, a)
    return a
  }
  apply(ctx, config)
  return { config, listeners, held, agent }
}

test('agent scopes remain isolated and unload releases restrictions', () => {
  const h = harness(), a = h.agent('a', '/a'), b = h.agent('b', '/b')
  h.listeners['agent/created']({ agent: a })
  h.listeners['agent/created']({ agent: b })
  assert.deepEqual([...h.held.keys()], ['a'])
  b.session.cwd = '/a'
  h.listeners['session/event'](b.session, { type: 'working-directory/change', data: { cwd: '/a' } })
  assert.deepEqual([...h.held.keys()], ['a', 'b'])
  a.session.cwd = '/b'
  h.listeners['session/event'](a.session, { type: 'working-directory/change', data: { cwd: '/b' } })
  assert.deepEqual([...h.held.keys()], ['b'])
  h.listeners.unload()
  assert.equal(h.held.size, 0)
})

test('another directory cannot replace or restore an existing policy', async () => {
  const h = harness(), b = h.agent('b', '/b')
  const invoke = rawInput => h.listeners.command({ agent: b, rawInput, signal: new AbortController().signal })
  await assert.rejects(invoke(`apply ${name}`), /其他目录已有策略/)
  await assert.rejects(invoke('restore'), /其他目录/)
  assert.deepEqual(h.config, { enabled: true, workspace: '/a', hiddenTools: [name] })
})

test('insufficient evidence refuses application', async () => {
  const h = harness(), a = h.agent('a', '/a')
  const result = await h.listeners.command({ agent: a, rawInput: `apply ${name}`, signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
})
