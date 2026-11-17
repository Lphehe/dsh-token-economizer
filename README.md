# DSH Token Economizer

A DeepSeek Harness plugin for reviewing tool usage and reducing unnecessary tool definitions. Inspired by [Microsoft TokenEconomizer](https://github.com/microsoft/TokenEconomizer); this is an independent project and is not affiliated with Microsoft.

This project focuses on tool definitions. DeepSeek Harness already includes an advisory repeated-tool-call reminder. Existing project memory tools can provide project knowledge; this plugin does not implement the upstream micro-skills engine or claim the same benchmark savings.

## Requirements

- DeepSeek Harness 0.2.2-rc.3. The package declares compatibility with later 0.2.x versions, which have not yet been verified.
- Node.js 24 or newer.

## Installation

Install `@lphehe/dsh-token-economizer` through **Plugins → Add plugin** in DeepSeek Harness. You can also clone this repository and select the cloned directory:

```sh
git clone https://github.com/Lphehe/dsh-token-economizer.git
```

If you update an already installed copy, restart DSH to load the updated JavaScript.

## 使用 / Usage

安装后，在 DSH 对话输入框运行：

- `/economizer status`：查看当前目录的历史统计、建议，以及当前会话中已选工具是否仍可见。默认不会隐藏工具。
- `/economizer apply list_subagent_models`：明确选择隐藏此工具；也可选择 `list_mcp_resource_templates`。只能应用当前状态中符合条件的候选。
- `/economizer restore`：恢复当前目录的工具。

插件最多检查原始工作目录与当前目录相同的最近 40 个历史会话，忽略当前会话和分叉继承的事件。某个候选至少在三个会话的请求中出现，且所有检查过的会话均未调用过，才会被建议；历史读取失败时不能应用。旧版会话中的 PTC 调用会计入使用次数；仅通过旧版 PTC SDK 暴露的工具不计入提供次数，因此可能少报建议。当前只分析上述两个工具，不会自动隐藏工具。只保存一个目录的策略：先在原目录恢复，才能给其他目录设置策略。切换工作目录或关闭插件会解除不适用的限制。

Commands and status messages currently use Chinese. Tool pruning can affect future tasks that need a hidden tool. Use `restore` to bring the tool back. Programmatic tool calls in older session histories count as usage, but tools exposed only through the former SDK do not count toward the offered threshold. Prompt caching can change the actual savings; no token or cost reduction is guaranteed or measured by this plugin.

## Privacy

The plugin analyzes tool names from existing session history; it does not need to persist tool arguments or tool results in its own data store. Session history itself can contain sensitive information and stays subject to your existing DSH storage settings.

## Development

```sh
npm install --ignore-scripts
npm test
```

The real DSH/Cordis integration test requires the Desktop Electron runtime and skips under ordinary Node.js. In a DSH-launched shell, run it alongside the unit tests with:

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/*.test.js
```

The integration tests exercise real Cordis, tool services, and AgentLoop request assembly with a mock model; they use in-memory stubs for some services. They do not exercise a real model account, the configuration editor, or the GUI.

## License

MIT. The concepts behind the project are described by [TokenEconomizer](https://github.com/microsoft/TokenEconomizer); no claim of Microsoft sponsorship or endorsement is made.
