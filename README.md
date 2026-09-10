# Combo 插件内测入口

将当前 Codex 或 Claude Code 对话中已经形成的方法整理成可审阅的 Agent，并在当前对话继续使用。

本仓库包含 `0.2.0` 内测包。只有 `release.json` 标记为 `test`、文件校验通过且安装指令包含公开仓库的完整提交 SHA 时，才可以安装。

安装和提取可以在同一次自然语言请求中完成。使用网页提供的固定版本指令，或让当前 Agent 阅读相同公开提交下的 [安装说明](docs/install.md)。用户无需手工打开 Terminal。

来源仅限当前模型已经可用的对话上下文。编译器不读取 Project、其他会话或凭据，也不调用模型；方法由当前宿主模型整理。本地编译成功不等于真实提取质量、宿主加载或执行已经验收，保存到云端及公开分享均需另外明确选择。

marketplace：`dangdang-tech-combo-public-test`；插件：`combo`。发现已安装的其他 Combo 来源时安装器会停止，由用户明确选择后再处理，不会自动卸载或覆盖。

维护者可以运行 `npm test` 和 `npm run verify:release` 检查分发脚本及固定载荷。[发布清单](release.json) 记录 28 个审核文件的校验值，第三方许可证随插件保留，详见 [维护说明](docs/maintainers.md)。本次没有为 Combo 新增开源许可证。
