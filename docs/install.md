# 在当前对话安装并提取 Agent

本说明面向执行用户指令的 Codex 或 Claude Code。用户不需要手工打开 Terminal。只使用网页指令中给出的公开仓库完整提交 SHA；不得把 `main`、可移动标签、私有仓库或另一个本地开发版本当成同一发行包。

## 用户复制的请求

下面是供发布网页生成固定版本指令的模板；发布时必须将两处 `PUBLIC_COMMIT_SHA` 替换为同一个实际可匿名获取的 40 位提交。模板占位符不是可安装发行版本。

```text
请在当前客户端安装 Combo 0.2.0 内测插件，并把我们当前对话中已经形成的可复用方法提取成一个可审阅的 Agent。

公开发行仓库：https://github.com/dangdang-tech/combo-plugin-distribution
固定提交：PUBLIC_COMMIT_SHA
请先阅读这个固定版本的安装说明：https://github.com/dangdang-tech/combo-plugin-distribution/blob/PUBLIC_COMMIT_SHA/docs/install.md

只安装到我正在使用的 Codex 或 Claude Code。你可以自动取得并校验这份公开发行包，再调用该客户端的插件安装命令。不要要求我手工打开 Terminal。先检查已有 Combo 插件、同名 MCP 和 Skill；若已有其他来源或来源无法确认，请停止并解释，由我选择后再处理，不得覆盖、禁用或卸载旧版本。

安装后，使用你在本次当前对话里已经可用的上下文整理方法，不要读取 Project、其他任务、原始会话文件或凭据，也不要上传或公开分享。如果新安装的 MCP 工具尚未进入当前任务，就由你在当前对话整理方法，按固定版本安装说明调用它的本地编译器；不要另外启动模型或读取旧会话来恢复内容。

请展示真实编译出的完整 AGENT.md、完整 Skill 和 Package digest，说明覆盖范围；仅编译完成时不要声称已经运行。若当前上下文没有足够的方法，请告诉我插件是否已就绪，并请我在已有方法的原对话中继续提取。不要查询其他任务来补齐。
```

## 执行顺序

1. 从当前宿主身份确定 `codex` 或 `claude`，只操作这一端。检查当前任务中可见的 Combo 工具和 Skill；安装器的命令行清单不能替代当前任务的工具清单。发现旧 Combo、预览 Combo 或同名工具时先停止。不要通过换 marketplace 名称回避冲突。
2. 检查现成的 Git、Node.js 24 或更新版本，以及当前宿主匹配的客户端 CLI。安装器在 macOS 优先使用宿主提供的 `CODEX_CLI_PATH` 或 ChatGPT/Codex Desktop 自带的 CLI，也支持 `--cli <绝对路径>`。若缺失或配置解析失败，报告具体缺失层；不要自行安装运行时、修复配置或读取认证文件。
3. 在用户当前 Project 之外选一个新的持久化目录，例如用户数据目录中的 `combo-public-test/<完整提交 SHA>`。不存在时才创建；已有目录只能在完整提交、规范公开远端和干净状态均一致时复用，不得覆盖。用 Git 匿名取得 `https://github.com/dangdang-tech/combo-plugin-distribution.git`，检出指令中的完整 SHA。禁用交互认证和 credential helper；获取失败时停止，不要尝试登录私有仓库。此目录将作为本地 marketplace 保留，不是运行后就删除的临时目录。
4. 从该目录执行 `node scripts/verify-release.mjs`，再执行 `node scripts/install.mjs --client <codex或claude> --commit <完整SHA> --apply`。脚本先校验规范远端、完整 SHA、工作区干净状态、允许文件和逐文件 SHA-256，再通过客户端清单检查现有插件、marketplace 来源及 MCP 名称；安装后从本轮 CLI 返回的真实缓存位置逐文件复验，不能只比较版本号。Codex 的安装结果与本插件 MCP 的完整 transport 必须指向同一缓存；无法定位时停止，不从本地收据猜测。冲突、未知清单格式或 CLI 错误均停止；不会自动卸载、覆盖或修复现有配置。安装目标为当前用户，避免修改 Project 文件。
5. 安装返回成功后，检查当前任务实际能否调用本版本的 `compile_agent_context` 和 `prepare_agent_context`。存在并能确认来源时按本版本 `plugins/<客户端目录>/skills/combo-agent-builder/SKILL.md` 执行。仅 CLI 安装成功不能证明新工具已经进入原任务。
6. 若新 MCP 工具尚不可用，继续使用当前模型已拥有的上下文合成方法，并使用下面的本地编译路径。不要跳到新任务后丢失方法，也不要扫描原会话恢复上下文。宿主支持重载时可提示在原对话重载后继续；Claude 的 `/reload-plugins` 行为依客户端版本和宿主模式而异，不保证重载会连接新的 MCP。不要替用户发送 `--force` 或声称未经测试的原会话热加载已通过。

安装器默认不带 `--apply` 时只返回计划和检查结果。用户已经提出上述安装请求时，Agent 可以直接使用 `--apply`，不需要再次索取同一项授权。若运行在无执行工具的宿主中，明确报告该限制。

当前任务的同名 Skill 检查必须由宿主模型完成。安装脚本不扫描 Project 或配置目录来查找 Skill，也不声称覆盖所有 Skill 来源。

## 本地编译兼容路径

只有在本次固定发行包已经校验、安装来源没有冲突且用户要求提取时使用。模型负责整理当前上下文；CLI 只接受显式标准输入，不调用模型、不扫描历史，也不联网上传。

Codex 使用 `plugins/combo/bin/combo-context.mjs`，Claude Code 使用 `plugins/combo-claude/bin/combo-context.mjs`。给 CLI 的标准输入为下列结构，内容必须来自模型本次整理的实际方法，而不是示例文字：

```json
{
  "protocol": "combo.agent-context-request/1",
  "request": "把当前对话已经形成的方法整理成可复用 Agent",
  "content": {
    "name": "实际的方法名称",
    "description": "帮助谁完成什么",
    "instructions": "完整步骤、输入要求、输出要求和限制",
    "starterPrompts": ["一个实际可用的起始请求"],
    "outputDescription": "输出应包含什么",
    "coverageSummary": "仅整理当前已可用上下文，未检查其他历史"
  }
}
```

Claude CLI 输入在最外层额外包含 `"client": "claude"`；Codex 不需要。MCP 调用由安装适配器确定客户端，不添加这个字段。

由 Agent 用安全的结构化执行工具，将上述 JSON 作为 stdin 交给 `node <固定目录>/plugins/<客户端目录>/bin/combo-context.mjs --output-dir <新的输出目录>`。输出目录放在本次用户认可的产物位置，避免写入当前 Project；不得复用已有目录。不要把方法拼进 Shell 命令，也不要放入原始对话、凭据、私人案例细节或本地路径。

读取本次生成的 `AGENT.md`、`skills/` 内容和 `compilation.json` 中的实际 digest，向用户完整展示。HTML 卡片只有实际打开并可见后才可说已展示。编译失败时保留原方法并说明失败，不得用模拟卡片替代。

用户随后要求使用时，将完全相同的 JSON 交给同一 CLI 的 `--prepare <已经审阅的digest>`。使用返回的完整方法作为当前任务指导，再由当前模型实际完成用户工作。准备成功只证明方法已校验，不证明任务执行成功；这也不会创建独立运行会话或移除原对话上下文。

## 验证边界

`release.json` 记录的分发清单锁定载荷；公开提交 SHA 同时锁定安装脚本及文档。隔离配置中的真实 CLI 安装测试、显式输入的编译测试、当前模型的实际提取、原任务新工具加载和模型后续任务执行是不同证据，分别记录。

Claude 本地 marketplace 与插件加载行为参考 [官方分发说明](https://code.claude.com/docs/en/plugin-marketplaces) 和 [官方安装与重载说明](https://code.claude.com/docs/en/discover-plugins)。已核验本机 CLI help：Codex Desktop CLI `0.153.4`、Claude Code `2.1.234`；这不是两端完整宿主 UAT 通过的声明。
