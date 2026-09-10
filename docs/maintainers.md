# 维护公开分发仓库

此仓库只保存用于分发的插件载荷和最小安装支持。私有研发仓库的源码、Git 历史、内部验收记录、私有提交链接、凭据、会话及用户产物不进入此仓库。

发布顺序：

1. 在研发仓库完成候选构建与门禁，锁定提交并独立复核实际导出内容。研发提交和详细内部证据保存在内部任务记录中。
2. 从已批准提交逐文件导出允许列表，不从 dirty 工作区复制。公开载荷只包括两份 marketplace，以及两个插件目录内已审核的 manifest、MCP 配置、bundle、Skill、UI、icons 和第三方版权文件。`scripts/release-lib.mjs` 的 `allowedPayloadPath` 是精确路径门禁；增加路径须同时审核并调整门禁。
3. 每个插件的 `THIRD_PARTY_NOTICES.md` 保存所有实际 bundle 依赖的完整许可原文，`third-party-licenses.json` 记录依赖及 notice 摘要。公开并不自动赋予 Combo 新的开源许可证；不擅自添加 LICENSE。
4. 执行 `node scripts/build-release.mjs --reviewed-payload`，生成逐文件 bytes、SHA-256 和整个载荷集合摘要。执行 `npm test`、`npm run verify:release`、`git diff --check`，提交后用精确提交再验证。
5. 先形成包含完整可安装载荷的公开候选提交，再让网页或后续说明提交引用它的完整 SHA。不要试图将一个提交自己的 SHA 写入该提交，也不要用分支或标签冒充不可变版本。完成匿名获取及重新校验后才能将该 SHA 放入面向用户的安装请求。
6. 创建当前提交上的 PR 并按适用仓库政策复核。公开推送、PR、合并及网页部署各自遵守任务授权，不能用本地脚本检查推导远端完成。

## 在隔离配置中测试真实 CLI

只测试已提交的干净候选；安装器会检查公开规范远端和精确 HEAD。使用 `mktemp -d /private/tmp/combo-public-test-XXXXXXXX`（Linux 可用 `/tmp`），选择该命令实际返回、经 `realpath` 核对的目录，传给 `--profile-dir`。每端使用不同目录。

`node scripts/install.mjs --client codex --commit <完整SHA> --profile-dir <新隔离目录> --apply`

`node scripts/install.mjs --client claude --commit <完整SHA> --profile-dir <另一个新隔离目录> --apply`

安装器仅在测试子进程的环境中设置客户端官方配置根，保留运行所需的普通环境，去掉继承的认证变量；不读取或复制真实凭据，不修改父进程环境或 shell 配置。不得把现有用户配置目录作为隔离目标。脚本不自动清理配置目录，失败时保留便于检查。

再次运行同一安装命令应校验实际缓存并返回已安装，不重复安装。换来源、旧同名插件和 disabled 状态应保留原状，返回具体 `reviewPlan` 与退出码 `2`；校验或 CLI 异常返回失败阶段、已尝试与已完成命令、恢复限制及退出码 `1`。测试还须覆盖 marketplace 注册与插件安装之间出现的新冲突，以及部分失败后的重新核验和只完成缺失步骤。不要以清空配置或卸载插件来掩盖冲突；没有可信历史制品与经验证恢复流程时，不增加自动迁移分支。

这些测试只证明真实 CLI 对固定载荷的安装结果。模型从当前对话提取方法、宿主加载工具、渲染真实卡片和继续执行任务都要另行提供对应证据。
