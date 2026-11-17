import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'

// The Desktop Electron executable is needed for ASAR-aware imports.
test('installed Cordis and DSH tools release scoped masks on directory change and unload', { skip: !process.versions.electron || !process.env.DSH_INSTALL_DIR }, async () => {
  const modules = dirname(dirname(process.env.DSH_INSTALL_DIR))
  const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib', 'index.js')).href)
  const [{ Context }, { default: SystemPrompt }, { default: Tools }, { createScope, scopeTarget }, plugin] = await Promise.all([
    load('cordis'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-scope'), import('../index.js'),
  ])
  const ctx = new Context()
  const agents = new Map()
  const commands = []
  ctx.provide('agents', { list: () => [...agents.values()], get: id => agents.get(id) })
  ctx.provide('commands', { register: command => { commands.push(command); return () => {} } })
  ctx.provide('workingDirectory', { get: session => session.cwd })
  ctx.provide('sessionQuery', { listSessions: async () => [] })
  const prompt = ctx.plugin(SystemPrompt, {})
  const tools = ctx.plugin(Tools, {})
  while (prompt.inertia) await prompt.inertia
  while (tools.inertia) await tools.inertia
  assert.ok(ctx.get('tools'), 'real tools service loaded')
  const definition = {
    name: 'list_subagent_models', description: 'test tool', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '' }] },
    execute: async () => '',
  }
  const removeTool = ctx.tools.register(definition)
  let scopeContext
  const owner = ctx.plugin({ name: 'integration-scope-owner', inject: ['tools'], apply(context) { scopeContext = context } })
  while (owner.inertia) await owner.inertia
  assert.ok(scopeContext)
  const agent = { id: 'agent-a', session: { id: 'agent-a', cwd: '/integration/a' } }
  const scope = createScope(scopeContext, agent)
  agent.ctx = scope.ctx
  agents.set(agent.id, agent)
  const fiber = ctx.plugin(plugin, { enabled: true, workspace: '/integration/a', hiddenTools: ['list_subagent_models'] })
  while (fiber.inertia) await fiber.inertia
  assert.equal(commands.length, 1, 'plugin activated')
  assert.equal(ctx.tools.get('list_subagent_models', agent), undefined, 'mask installed for agent')
  const status = await commands[0].handler({ agent, rawInput: 'status', signal: new AbortController().signal })
  assert.match(status.text, /list_subagent_models: 当前不可见/)
  assert.ok(ctx.tools.get('list_subagent_models'), 'global registry unaffected')
  const second = { id: 'agent-b', session: { id: 'agent-b', cwd: '/integration/a' } }
  const secondScope = createScope(scopeContext, second)
  second.ctx = secondScope.ctx
  agents.set(second.id, second)
  await ctx.serial(scopeTarget(second), 'agent/created', { agent: second, source: 'startup' })
  assert.equal(ctx.tools.get('list_subagent_models', second), undefined, 'new agent receives mask')
  agent.session.cwd = '/integration/b'
  ctx.emit('session/event', agent.session, { type: 'working-directory/change', data: { cwd: '/integration/b' } })
  assert.ok(ctx.tools.get('list_subagent_models', agent), 'tool restored outside workspace')
  assert.equal(ctx.tools.get('list_subagent_models', second), undefined, 'other agent remains restricted')
  agent.session.cwd = '/integration/a'
  ctx.emit('session/event', agent.session, { type: 'working-directory/change', data: { cwd: '/integration/a' } })
  assert.equal(ctx.tools.get('list_subagent_models', agent), undefined, 'mask restored after returning')
  removeTool()
  await Promise.resolve()
  ctx.tools.register(definition)
  await Promise.resolve()
  assert.equal(ctx.tools.get('list_subagent_models', agent), undefined, 're-registered tool is masked')
  assert.equal(ctx.tools.get('list_subagent_models', second), undefined, 're-registered tool is masked for both agents')
  await fiber.dispose()
  assert.ok(ctx.tools.get('list_subagent_models', agent), 'unloading plugin restores tool')
  assert.ok(ctx.tools.get('list_subagent_models', second), 'unloading restores second agent')
  await secondScope.dispose()
  await scope.dispose()
  await owner.dispose()
  await tools.dispose()
  await prompt.dispose()
})
