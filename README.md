# DSH Code Review

DSH 的只读代码审查插件。它比较 Git 或 SVN 中的代码变更，使用当前 Agent 的模型分析问题，并返回带文件位置、证据和复核结果的中文报告。

**不会修改代码、自动修复、提交、回滚或发布业务项目。模型报告仍需人工判断。**

## 安装

环境要求：Node.js 22 或更新版本，以及目标仓库使用的 Git 或 SVN 命令行工具。插件依赖 DSH 的工具和模型服务，不能脱离 DSH 单独运行。

在 DSH 中通过插件管理器安装并启用，或使用：

	dsh plugin add https://github.com/f-e-n-g-0531/dsh-code-review.git

升级后确认当前 DSH 进程已经加载新版本。仓库发布新版本不会自动更新正在运行的 DSH；本项目也不会自动修改已有 profile 或重启宿主。

> 许可限制：本项目采用非商业源码公开许可证。公司内部商业项目、收费服务及商业交付需要另行取得书面授权。详见 [LICENSE](LICENSE)。

## 第一次使用

在目标仓库的 DSH Agent 会话中，可以这样提出请求：

> 审查 src/api.ts 和 src/client.ts 的改动。先展示审查范围和模型目的地，确认后再执行。不要修改代码。

插件提供两个工具：

1. **code_review_preview**：读取本地变更，列出审查文件、额外上下文、排除原因和模型目的地。此步骤不调用模型。
2. **code_review_execute**：接收预览返回的 previewId 和 confirmed: true。执行前重新检查文件；只有预览仍有效且宿主允许执行时，才把批准内容发送给当前 Agent 模型。

调用示例：

	{"selectedPaths":["src/api.ts","src/client.ts"],"autoContext":true}

执行参数为：

	{"previewId":"预览返回的ID","confirmed":true}

执行返回中文 Markdown 报告，以及 JSON 格式的结构化报告。代码、会话目录或模型路由变化后，需要重新预览。

## 可以审查什么

| 场景 | 支持情况 |
|---|---|
| Git 工作区 | HEAD 与工作区的净变化，包含暂存和未暂存改动；没有单独的 staged/unstaged 模式 |
| Git 单个提交 | 使用 commit 参数；与唯一父提交比较，根提交与空旧版本比较。合并提交请使用区间模式 |
| Git 两个版本 | 使用 baseRevision 和 targetRevision；比较两个版本的文件树，不自动计算合并基点 |
| SVN 工作副本 | 本地 BASE 与工作副本比较，不连接远端；不支持 SVN 历史区间审查 |
| 多个子仓库 | 用 repositoryPath 指定会话工作区中的一个仓库根目录；每个仓库分别预览和执行 |

未跟踪文件必须通过 selectedPaths 显式选入。省略 selectedPaths 时，审查范围是仓库根目录的变更，不只是当前子目录。

## 常用参数

所有文件路径都相对于本次选定的仓库，使用正斜杠；不要使用绝对路径、上级路径或链接目录。

| 参数 | 用途 | 示例 |
|---|---|---|
| selectedPaths | 只审查选中的变更文件 | ["src/api.ts"] |
| repositoryPath | 指定工作区内的子仓库 | "project-a" |
| contextPaths | 手动加入理解代码所需的文件 | ["src/types.ts"] |
| autoContext | 从变更及手动上下文寻找依赖；Git 和 SVN 最多沿三层依赖链读取 | true |
| callerScopePaths | 在指定目录中寻找引用变更文件的代码；已捕获调用方会标出调用行与唯一声明行 | ["src/clients"] |
| oldContextPaths | Git 历史审查中，只加入旧版本的上下文 | ["src/removed-helper.ts"] |
| rulePaths | 加入项目审查规则，最多四个 UTF-8 Markdown 或文本文件 | ["review-rules.md"] |
| businessRequirement | 提供业务要求；不是缺陷证据，也不会增加读取权限 | "请求失败时必须释放连接" |
| reviewRounds | 独立审查次数，1～3，默认 1；会增加模型调用量 | 2 |

commit 与 baseRevision/targetRevision 不能同时使用。oldContextPaths 只能用于 Git 历史审查。

自动上下文和引用方发现是保守的文本导航，不是编译器分析。动态导入、宏、重载、继承和实例方法可能无法解析；找到引用不等于证明函数实际被调用。Git 历史可沿修改前后两侧分别捕获最多三层依赖；SVN 可沿安全的当前工作副本节点取得最多三层依赖，不读取 SVN 历史。已批准正文中的唯一命名声明和唯一 default 导出会标出位置；同名、重导出或跨侧内容不猜测。

## 如何读报告

先看**覆盖情况和限制**，再看问题列表：

- completed：相应阶段完成，不表示代码绝对正确。
- partial：只完成部分工作；检查未完成文件、证据不足或预算限制。
- failed：审查执行失败，不是“审核通过”。
- cancelled：审查被取消。

每个候选问题会保留位置、触发条件、影响和复核结果。复核可能支持、反驳、无法确定或未完成；被反驳的候选不会悄悄删除。程序会核对引用的位置和原文，但这不能代替人工判断缺陷是否成立。

额外上下文被读取，不等于它已作为主文件完成审查。没有发现问题，也不证明代码没有缺陷。

## 数据与安全

- 预览会在本地读取选定变更和上下文；确认执行后，这些内容可能发送给当前模型提供方。发送前请检查范围。
- 插件沿用 DSH 正常工具权限，不额外发起一套审批；confirmed 只确认预览，不能绕过宿主权限。
- 不执行项目代码、构建脚本或模型生成的 shell 命令。模型只能在批准的快照中查找、搜索和读取。
- 常见凭据路径会被排除，但普通源码也可能含秘密。路径过滤不能代替人工检查。
- 二进制、不能解码的文件、链接和超限内容会被阻断，不会自动截断后假装完成。
- SVN 的复制、替换、切换目录、外部工作副本、冲突及部分属性状态不受支持。含 svn:keywords 的文件也会被阻断，以免把关键字展开当作代码变化。

## 默认规模限制

| 项目 | 默认上限 |
|---|---|
| 变更文件 | 200 个 |
| 单文件 | 256 KiB |
| 全部快照 | 4 MiB |
| 额外上下文 | 共 20 个文件，手动与自动来源共享 |
| 单次模型输入 | 约 96 KiB |
| 一次审查的模型调用 | 100 次，多个审查阶段共享 |

大变更可以按保留原始行号的差异窗口分批分析；不能容纳的部分会明确标为未完成。详细读取、时间和发现预算见 [开发与发布指南](DEVELOPMENT.md)。

## 文档导航

- [版本变化](CHANGELOG.md)：各版对使用者有何影响。
- [本次发布说明](RELEASE-NOTES.md)：新版本内容、升级注意事项及限制。
- [开发与发布指南](DEVELOPMENT.md)：测试、打包、发布和失败恢复。
- [核心能力对照](CORE-ALIGNMENT-TASKS.md)：已具备能力与尚未完成的差距。
- [参考源码对照](CORE-SOURCE-INVENTORY.md)：维护者使用的固定参考来源。
- [评测说明](https://github.com/f-e-n-g-0531/dsh-code-review/blob/main/evaluation/README.md)：样本、试跑观察及其证据限制。

最新安装包与正式版本以 [npm](https://www.npmjs.com/package/@feng0531/dsh-code-review) 和 [GitHub Releases](https://github.com/f-e-n-g-0531/dsh-code-review/releases) 为准。发布与安装成功不代表真实模型的误报率或漏报率已经得到证明。
