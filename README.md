# dsh-sillytavern

**状态：规划中 · Status: planned.** 本仓库用于开发 DSH 的 SillyTavern 角色卡集成，目前尚无可用版本。

## 计划做什么

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）能直接使用既有的角色卡生态：

- **导入角色卡**：读取常见格式的角色卡文件，转为 dsh 可用的 agent preset / 提示词
- **世界书（World Info）**：按关键词触发的设定注入
- **多角色会话**：在会话中切换或组合角色，配合 [dsh-custom-mode](https://github.com/BOWLUNA/dsh-custom-mode) 的逐行开关
- **导入器而非替代品**：不重新实现聊天前端，只做格式转换与 dsh 侧集成

## 声明

本项目是**非官方**的第三方集成，与 SillyTavern 项目及其维护者无隶属关系。名称中的 "SillyTavern" 仅用于说明兼容的数据格式。相关格式与内容版权归各自作者所有。

## License

MIT
