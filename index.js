import z from '@deepseek-ai/schemastery'

export const name = 'token-economizer'
export const inject = ['agents', 'commands', 'tools', 'sessionQuery', 'workingDirectory']
export const Config = z.object({
  enabled: z.boolean().default(false),
  workspace: z.string().default(''),
  hiddenTools: z.array(z.string()).default([]),
})

// Only these optional discovery tools are eligible; executable and safety tools stay visible.
const CANDIDATES = ['list_mcp_resource_templates', 'list_subagent_models']
const SAMPLE_SIZE = 40
const MIN_SESSIONS = 3

export function evidenceFromSession(session, workspace, candidates) {
  let cwd = session.header.cwd
  const offered = new Set()
  const used = new Set()
  for (const event of session.snapshotEvents()) {
    if (event.type === 'working-directory/change') cwd = event.data.cwd
    if (event.seq < session.inheritedEventCount || cwd !== workspace) continue
    if (event.type === 'request/header') {
      for (const tool of event.data.header.tools ?? []) {
        if (candidates.includes(tool.name)) offered.add(tool.name)
      }
    }
    if (['tool/call', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(event.type) && candidates.includes(event.data.name)) used.add(event.data.name)
  }
  return { offered: [...offered], used: [...used] }
}

export async function recommendations(ctx, agent, signal) {
  const workspace = ctx.workingDirectory.get(agent.session)
  const visible = new Set(ctx.tools.definitions().map(tool => tool.name))
  const candidates = CANDIDATES.filter(name => visible.has(name))
  const totals = Object.fromEntries(candidates.map(name => [name, { offered: 0, used: 0 }]))
  const records = await ctx.sessionQuery.listSessions(signal)
  let failures = 0
  for (const record of records.filter(item => item.header.cwd === workspace && item.header.id !== agent.id).slice(0, SAMPLE_SIZE)) {
    signal?.throwIfAborted()
    try {
      const evidence = await ctx.sessionQuery.inspectSession(record.header.id, session => evidenceFromSession(session, workspace, candidates), signal)
      for (const name of evidence.offered) totals[name].offered++
      for (const name of evidence.used) totals[name].used++
    } catch (error) {
      signal?.throwIfAborted()
      failures++
    }
  }
  return { workspace, totals, failures, candidates: candidates.filter(name => totals[name].offered >= MIN_SESSIONS && totals[name].used === 0) }
}

export function apply(ctx, config) {
  const restrictions = new Map()
  const stop = agent => {
    const current = restrictions.get(agent)
    if (current) { restrictions.delete(agent); current.dispose() }
  }
  function sync(agent, workspace = ctx.workingDirectory.get(agent.session)) {
    const allowed = config.enabled && config.workspace === workspace
      ? config.hiddenTools.filter(name => CANDIDATES.includes(name) && ctx.tools.definitions().some(tool => tool.name === name)) : []
    const key = JSON.stringify(allowed)
    if (restrictions.get(agent)?.key === key) return
    stop(agent)
    if (allowed.length) {
      const dispose = agent.ctx.effect(() => agent.ctx.tools.restrict({ deny: allowed }))
      restrictions.set(agent, { key, dispose })
    }
  }
  function trySync(agent, workspace) {
    try { sync(agent, workspace) } catch (error) {
      stop(agent)
      console.warn('token-economizer: restriction unavailable; tools left unchanged', error)
    }
  }
  // Tool admission happens before agent/pre-step; install at creation and directory commits.
  ctx.on('agent/created', ({ agent }) => { trySync(agent) })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'working-directory/change') return
    const agent = ctx.agents.get(session.id)
    if (agent) trySync(agent, event.data.cwd)
  })
  ctx.on('agent/disposed', ({ agent }) => { stop(agent) })
  let pending = false, active = true
  ctx.on('tools/change', () => {
    if (pending || !active) return
    pending = true
    queueMicrotask(() => {
      pending = false
      if (active) for (const agent of ctx.agents.list()) trySync(agent)
    })
  })
  ctx.effect(() => () => { active = false; for (const agent of restrictions.keys()) stop(agent) })
  for (const agent of ctx.agents.list()) trySync(agent)
  ctx.commands.register({
    name: 'economizer',
    description: 'Inspect or explicitly apply optional tool savings',
    input: { hint: 'status | apply <tool> | restore' },
    async handler({ agent, rawInput, signal }) {
      const [action = 'status', tool, ...extra] = rawInput.trim().split(/\s+/).filter(Boolean)
      if (extra.length || !['status', 'apply', 'restore'].includes(action) || (action === 'apply' ? !tool : !!tool)) {
        return { kind: 'error', text: '用法：/economizer status | apply <工具名> | restore' }
      }
      if (action === 'status') {
        const report = await recommendations(ctx, agent, signal)
        const lines = Object.entries(report.totals).map(([name, count]) => `${name}: 提供 ${count.offered} 个会话，调用 ${count.used} 个会话`)
        const policy = !config.enabled ? '未启用' : config.workspace === report.workspace ? config.hiddenTools.join(', ') || '无' : `其他目录已有策略：${config.workspace}`
        const suggestions = report.failures ? '读取失败，暂不可应用' : report.candidates.join(', ') || '证据不足或无候选'
        const actual = new Set(ctx.tools.definitions(agent).map(item => item.name))
        const expected = config.enabled && config.workspace === report.workspace ? config.hiddenTools : []
        const check = expected.length ? expected.map(name => `${name}: ${actual.has(name) ? '仍可见，请检查插件日志或作用域覆盖' : '当前不可见'}`).join(', ') : '本目录没有需要隐藏的工具'
        return { kind: 'success', text: `工作目录：${report.workspace}\n当前策略：${policy}\n当前会话工具检查：${check}\n${lines.join('\n') || '没有可评估的候选工具'}\n建议：${suggestions}\n读取失败：${report.failures} 个会话。最多检查本目录最近 ${SAMPLE_SIZE} 个历史会话；候选须在至少 ${MIN_SESSIONS} 个会话中提供且均未调用。仅评估 list_mcp_resource_templates 和 list_subagent_models。使用 /economizer apply <工具名> 申请保存策略，/economizer restore 恢复本目录策略。` }
      }
      const editor = ctx.get('configEditor')
      const entry = ctx.fiber.entry
      if (!editor || !entry) return { kind: 'error', text: '此环境无法保存配置；未做更改。' }
      if (action === 'restore') {
        const workspace = ctx.workingDirectory.get(agent.session)
        await editor.edit(entry, (current, inherited) => {
          const active = { ...inherited, ...current }
          if (ctx.workingDirectory.get(agent.session) !== workspace || (active.enabled && active.workspace !== workspace)) throw new Error('当前目录没有可恢复的策略；其他目录的策略未改变。')
          return { ...current, enabled: false, hiddenTools: [], workspace: '' }
        })
        return { kind: 'success', text: '已保存恢复配置；后续步骤的实际工具集请检查运行时。' }
      }
      const report = await recommendations(ctx, agent, signal)
      if (report.failures || !report.candidates.includes(tool)) return { kind: 'error', text: '证据不足、读取失败或该工具不在安全候选中；未做更改。' }
      signal.throwIfAborted()
      await editor.edit(entry, (current, inherited) => {
        if (ctx.workingDirectory.get(agent.session) !== report.workspace) throw new Error('工作目录已变化；请重新检查。')
        const active = { ...inherited, ...current }
        if (active.enabled && active.workspace !== report.workspace) throw new Error(`其他目录已有策略（${active.workspace}）；请先在该目录恢复。`)
        const previous = active.enabled && Array.isArray(active.hiddenTools) ? active.hiddenTools : []
        return { ...current, enabled: true, workspace: report.workspace, hiddenTools: [...new Set([...previous, tool])] }
      })
      return { kind: 'success', text: `已为 ${report.workspace} 保存 ${tool} 的裁剪配置；实际工具集请检查运行时。使用 /economizer restore 恢复。` }
    },
  })
}
