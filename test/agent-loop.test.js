import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'

const candidate = 'list_subagent_models'
test('real AgentLoop requests follow workspace restrictions and restore', { skip: !process.versions.electron || !process.env.DSH_INSTALL_DIR }, async () => {
  const modules = dirname(dirname(process.env.DSH_INSTALL_DIR))
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib', 'index.js')).href)
  const [cordis, session, projections, agents, prompt, tools, executor, loop, llm, commands, loader, plugin] = await Promise.all([
    'cordis', 'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-agent-loop', 'dsh-llm', 'dsh-commands', 'cordis-plugin-loader',
  ].map(load).concat(import('../index.js')))
  const ctx = new cordis.Context()
  const requests = []
  ctx.provide('llm', { prepareCall: async config => ({ config, stream: async function* (request) { requests.push(request) } }) })
  ctx.provide('workingDirectory', { get: session => session.testCwd ?? session.header.cwd })
  const history = [1, 2, 3].map(id => ({ header: { id: String(id), cwd: '/a' }, inheritedEventCount: 0, snapshotEvents: () => [{ seq: 0, type: 'request/header', data: { header: { tools: [{ name: candidate }] } } }] }))
  ctx.provide('sessionQuery', { listSessions: async () => history, inspectSession: async (id, read) => read(history.find(item => item.header.id === id)) })
  ctx.provide('configEditor', { edit: async (entry, change) => ctx.loader.update(entry.id, { ...entry.options, config: change(entry.options.config ?? {}, {}) }) })
  const fibers = []
  async function mount(module, config = {}) {
    const fiber = ctx.plugin(module, config)
    fibers.push(fiber)
    while (fiber.inertia) await fiber.inertia
    return fiber
  }
  try {
    for (const module of [loader.default, session.default, projections.default, agents.default, prompt.default, tools.default, executor, commands.default, loop.default]) await mount(module)
    assert.ok(ctx.agentLoop, 'AgentLoop started')
    ctx.tools.register({ name: candidate, description: 'test tool', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '' }] }, execute: async () => '' })
    ctx.tools.register({ name: 'keep_tool', description: 'control tool', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '' }] }, execute: async () => '' })
    const agent = await ctx.agentLoop.create('test-agent', { provider: 'mock', model: 'mock' }, { cwd: '/a' })
    const turn = async () => {
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'test' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const last = agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)
      assert.equal(last.data.reason.kind, 'completed', JSON.stringify(last.data.reason))
      return agent.session.requestHeader().tools?.map(tool => tool.name).sort() ?? []
    }
    assert.deepEqual(await turn(), ['keep_tool', candidate])
    ctx.loader.builtins.economizer = plugin
    await ctx.loader.create({ id: 'economizer', name: 'cordis:economizer', config: { enabled: false, workspace: '', hiddenTools: [] } })
    await ctx.loader.await()
    const command = async input => (await ctx.commands.execute(agent, `/economizer ${input}`, [], new AbortController().signal)).result
    assert.match((await command('status')).text, /list_subagent_models: 提供 3 个会话，调用 0 个会话/)
    assert.equal((await command(`apply ${candidate}`)).kind, 'success')
    assert.deepEqual(ctx.loader.resolve('economizer').options.config, { enabled: true, workspace: '/a', hiddenTools: [candidate] })
    assert.deepEqual(await turn(), ['keep_tool'])
    agent.session.testCwd = '/b'
    agent.session.append('working-directory/change', { cwd: '/b' })
    assert.deepEqual(await turn(), ['keep_tool', candidate])
    await assert.rejects(command('restore'), /其他目录/)
    agent.session.testCwd = '/a'
    agent.session.append('working-directory/change', { cwd: '/a' })
    assert.deepEqual(await turn(), ['keep_tool'])
    assert.equal((await command('restore')).kind, 'success')
    assert.deepEqual(ctx.loader.resolve('economizer').options.config, { enabled: false, workspace: '', hiddenTools: [] })
    assert.deepEqual(await turn(), ['keep_tool', candidate])
    assert.deepEqual(requests.map(request => request.tools?.map(tool => tool.name) ?? []), [['keep_tool', candidate], ['keep_tool'], ['keep_tool', candidate], ['keep_tool'], ['keep_tool', candidate]])
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'request/header').length, 5)
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
})
