import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, evidenceFromSession, recommendations } from '../index.js'

function session(id, events, cwd = '/work', inheritedEventCount = 0) {
  return { id, header: { id, cwd }, inheritedEventCount, snapshotEvents: () => events }
}
const header = (seq, names) => ({ seq, type: 'request/header', data: { header: { tools: names.map(name => ({ name })) } } })
const call = (seq, name) => ({ seq, type: 'tool/call', data: { name, arguments: 'private' } })
const change = (seq, cwd) => ({ seq, type: 'working-directory/change', data: { cwd } })
const candidate = 'list_subagent_models'

function fixture(records = []) {
  const handlers = {}
  const registered = []
  const config = { enabled: false, workspace: '', hiddenTools: [] }
  const editor = { edit: async (_entry, change) => Object.assign(config, change(config)) }
  const ctx = {
    fiber: { entry: {} },
    get: name => name === 'configEditor' ? editor : undefined,
    tools: { definitions: () => [{ name: candidate }, { name: 'bash' }] },
    agents: { list: () => [], get: id => id === 'current' ? agent : undefined },
    workingDirectory: { get: session => session.cwd || session.header.cwd },
    sessionQuery: {
      listSessions: async () => records.map(item => ({ header: item.header })),
      inspectSession: async (id, read) => read(records.find(item => item.header.id === id)),
    },
    commands: { register: definition => { handlers.command = definition.handler } },
    on: (name, handler) => { handlers[name] = handler },
    effect: fn => { handlers.cleanup = fn() },
  }
  const current = session('current', [])
  const agent = { id: 'current', session: current, ctx: {
    tools: { restrict: value => { registered.push(value); return () => registered.push('disposed') } },
    effect: fn => fn(),
  } }
  apply(ctx, config)
  return { ctx, config, handlers, agent, registered }
}

test('only own calls in the matching effective directory count', () => {
  const s = session('a', [header(0, [candidate]), call(1, candidate), change(2, '/else'), call(3, candidate), change(4, '/work'), header(5, [candidate])], '/work', 2)
  assert.deepEqual(evidenceFromSession(s, '/work', [candidate]), { offered: [candidate], used: [] })
  const fork = session('fork', [change(0, '/else'), header(1, [candidate])], '/work', 1)
  assert.deepEqual(evidenceFromSession(fork, '/work', [candidate]), { offered: [], used: [] })
})

test('recommendations require three distinct sessions with offered but unused tool', async () => {
  const records = [1, 2, 3].map(i => session(String(i), [header(0, [candidate])]))
  const { ctx, agent } = fixture(records)
  assert.deepEqual((await recommendations(ctx, agent)).candidates, [candidate])
  for (const type of ['tool/call', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch']) {
    records[3] = session('4', [{ seq: 0, type, data: { name: candidate } }])
    assert.deepEqual((await recommendations(ctx, agent)).candidates, [])
  }
})

test('explicit application is project scoped and restore releases restriction', async () => {
  const records = [1, 2, 3].map(i => session(String(i), [header(0, [candidate])]))
  const { ctx, config, handlers, agent, registered } = fixture(records)
  const invoke = rawInput => handlers.command({ agent, rawInput, signal: new AbortController().signal })
  assert.equal((await invoke('apply bash')).kind, 'error')
  assert.equal((await invoke(`apply ${candidate}`)).kind, 'success')
  assert.deepEqual(config.hiddenTools, [candidate])
  assert.match((await invoke('status')).text, /仍可见，请检查插件日志或作用域覆盖/)
  handlers['agent/created']({ agent })
  assert.deepEqual(registered, [{ deny: [candidate] }])
  agent.session.cwd = '/else'
  handlers['session/event'](agent.session, change(0, '/else'))
  assert.deepEqual(registered, [{ deny: [candidate] }, 'disposed'])
  await assert.rejects(invoke('restore'), /其他目录/)
  assert.equal(config.enabled, true)
  agent.session.cwd = '/work'
  assert.equal((await invoke('restore')).kind, 'success')
  assert.equal(config.enabled, false)
})

test('failed evidence reads cannot enable pruning', async () => {
  const records = [1, 2, 3].map(i => session(String(i), [header(0, [candidate])]))
  const { ctx, handlers, agent, config } = fixture(records)
  ctx.sessionQuery.inspectSession = async () => { throw new Error('unavailable') }
  const result = await handlers.command({ agent, rawInput: `apply ${candidate}`, signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.equal(config.enabled, false)
})
