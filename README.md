# Agent Nexus

Windows 本地多 Agent 工作台，当前版本 **1.0.0-beta.1**。这是面向个人使用和反馈的测试版，在 GitHub 标记为 Pre-release。

[下载 Windows x64 安装包](https://github.com/HonmaMisuzu0306/Agent-Nexus/releases/tag/v1.0.0-beta.1) · [安装与恢复](docs/INSTALLATION.md) · [测试范围与已知限制](docs/RELEASE_1_0_BETA.md)

## 功能

- 本地项目、Codex / DSH 原生任务、取消与会话恢复。Codex 自动查找 PATH 和 Windows 原生安装目录。
- Leader 计划审批、双 Worker 团队、独立审查、有限返工、会议和暂停/恢复。
- 写任务使用独立 Git Worktree；预览并批准补丁后才应用到原项目，不自动 commit / push。
- 可视化 DAG 工作流、可修订草案、模板、全文历史搜索、日志分页与回放、脱敏诊断。
- Model Hub 支持用户配置的 Ollama / OpenAI-compatible 服务；Windows 系统加密保存 API Key。
- SQLite 本地持久化、升级前备份、深浅主题与键盘导航。

默认只读，计划执行前必须批准当前版本；重启不会自动重跑未知任务。Codex / DSH 需要各自已安装的原生程序与登录，本软件不捆绑 CLI、模型或账号。

**真实任务会由所选 Provider 向其模型服务发送目标和必要上下文。** 外部模型需要用户明确配置和确认；原生登录由各自程序管理，Nexus 不复制其登录凭证。

WorkBuddy 提供需要用户首次信任和手动启动对话的本地 MCP 桥接，不能自动启动或强制停止原生对话。Antigravity 当前保留人工交接；详见已知限制，不将人工交接或模拟结果视为原生自动化验证。

## 开始使用

1. 从 Releases 下载 `Agent-Nexus-Setup-1.0.0-beta.1.exe` 和 `SHA256SUMS.txt`，核对 SHA-256 后安装。安装包未签名，仅安装到当前 Windows 用户，不要求管理员权限。
2. 从开始菜单打开 Agent Nexus，创建或导入一个本地项目。
3. 在设置中检测本机 Provider，确认登录和能力；从简短只读任务开始。
4. 使用 Leader 或工作流时，核对角色、目标、权限和当前计划版本，再批准执行。项目写入须显式允许且项目是已有提交的 Git 根目录。

记录保存在当前用户 AppData 的应用数据目录。升级前会保存 SQLite 副本；旧版程序不能直接读取升级后的数据库，回退步骤见安装文档。

## 开发与验证

Node.js ≥22.12，npm 为包管理器。源码位于 `apps/desktop` 和 `packages`，测试位于 `tests`。

```powershell
npm ci
npm run dev
npm run check                  # TypeScript、Lint、离线测试、构建
npm run test:core:electron     # IPC、sandbox、SQLite、重启
npm run test:e2e               # 实际 Electron 模拟产品回归
npm run test:m5                # 工作流、历史与诊断夹具
npm run package:installer      # Windows x64 NSIS，不自动上传
npm run test:packaged          # 打包程序模拟回归
npm run audit:artifact         # 包内哈希与私人资料排除检查
```

原生测试默认跳过，须显式设置对应 `NEXUS_TEST_*` 开关且已有原生登录，会消耗 Provider 额度。合成测试使用 `.runtime/` 隔离目录，不发送本项目源码；涉及现有安装/用户配置的脚本有单独的显式授权开关。`test-results/`、`.runtime/`、凭证、数据库、本机报告和截图不提交到 GitHub。

安装包未提供自动更新；后续测试版通过 Releases 手动下载。反馈问题时请提供版本、操作步骤和脱敏诊断，先检查附件，避免提交私人项目、完整日志或账号信息。
