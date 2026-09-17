# dsh-sillytavern

**状态：半成品 · Status: work in progress.** 能构建、能测试、能挂载；**世界书还没有真正进过一次提示词**——原因见下。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**酒馆聚合包**：世界书（World Info），并聚合群聊。

## 现在有什么

- **世界书引擎**（纯函数）：关键词/正则匹配（含 ReDoS 门禁）、次级关键词四种逻辑、常驻条目、包含组、概率、预算、递归、逐条原因的注入 trace
- **绑定**：按 owner + target 分键的绑定表，任何写者都够不到别人的行；定向增删而非整行覆盖
- **书与条目**：完整 CRUD，21 个条目字段全都有编辑控件，书级设置（扫描深度/预算/递归/大小写/整词/正则）
- **注入测试器**：给出逐条的命中/拒绝**原因**，不需要启动房间——作者要问的通常是「这条为什么没命中」
- **会话座位**：把绑定书的扫描结果注册成提示词上下文，每步重新求值
- **整页界面**：占 dsh 的 `main` 自己的键 + 侧栏图标，而不是挤在设置对话框里

## 现在**不能**做什么（重要）

**还没有观察到世界书内容真的进过一次提示词。** 座位已接好，引擎已测好，但那条路径的终点是成员 agent，而它需要模型。群聊的 `startGroup` 因此会响亮拒绝。

详细的阻塞分析与接入点见 `docs/STRUCTURE.md` §6 与 §8。

## 验证到什么程度

| 检查 | 结果 |
| --- | --- |
| 单元测试 | 172 项（世界书引擎 35 / 座位与 schema 20 / 绑定 17 / 群聊 100） |
| 类型检查 | 干净 |
| 挂载 | 行进入组合树、插件树加载、浏览器 bundle 被发现并服务 |
| 浏览器实测 | 建书 → 加条目 → 保存 → 测试注入 → 删除，全在真实页面上通过；含用**递归**做探针验证书级设置真的到达引擎 |

## 关于本仓库里的 `dsh-group-chat` 与 `contracts`

本仓库是**聚合包**，它的 bundle 补丁会插入群聊那一行，所以安装它必须能解析到群聊包。`dsh-group-chat` 目前**尚未发布到 npm**，因此这里**内置了一份副本**（`packages/contracts` 与 `packages/group-chat`），让本仓库可以独立安装、构建与测试。

它的**正式家**是 [`dsh-agent-group`](https://github.com/BOWLUNA/dsh-agent-group)。等群聊包发布后，这里的副本应当删除，改成普通依赖。

**在此之前，两份副本必须逐字节相同，而这件事不靠自觉维持：**

```sh
pnpm run check:sync   # 拉对端仓库逐文件比对；分叉即失败并列出文件名
```

守卫比对 `packages/contracts`、`packages/group-chat`，以及两个仓库共用的主设计记录 `docs/`。

`tools/sync-guard.yml` 是同一脚本的 CI 版本，**目前在仓库里但尚未生效**——本机 `gh` 的 OAuth token 没有 `workflow` 权限，GitHub 拒绝创建 `.github/workflows/*`。要启用：`gh auth refresh -s workflow`，然后把该文件移到 `.github/workflows/sync-guard.yml`。在启用之前，守卫只在手动跑时生效。

要改共享内容：**在 `dsh-agent-group` 里改并先推，再同步过来推这边**——直接改这里的副本会被守卫抓住。

## 构建与测试

```sh
pnpm install
pnpm run verify    # 构建 + 类型检查 + 测试 + 客户端声明门禁
```

需要 Node 24+ 与 pnpm 12+，以及 PATH 上有一个 `dsh`（或设 `DSH_INSTALL_DIR`）。

## 设计记录

`docs/STRUCTURE.md` 是这个项目的推理总纲：为什么这样切分、五条结构规则各自落在哪、实测过的平台行为（含源码引文）、验证状态表、以及已知缺口与唯一阻塞点。**改这个仓库之前先读它。**

## License

MIT
