# ReviewBench 本地评测入口（实验）

此实验直接调用审查核心，不经过 DSH 宿主，不启用检索、独立复核或业务分组，不代表生产插件配置的质量。

- 默认 `RB_PROFILE=staged-direct`：显式使用 `staged`，保留之前的单轮逐文件／窗口行为，整次可有多次调用。
- `RB_PROFILE=single-pass-direct`：显式使用 `single-pass`，完整范围最多一次调用（底层 96 KiB 输入上限；超限不发送、不回退）。
- 旧输出的 `single-pass-direct` 标签曾指向 staged 路径，不得按新档位归类；比较时记录冻结版本和实际策略。

## 前置条件

- Node.js ≥22、Git、已安装本仓库依赖。
- 本地已有基准 PR 的仓库及完整 base/head 提交对象。
- 正式运行显式设置 OpenAI-compatible Chat Completions 端点和模型。只支持该协议，不能直接用 Anthropic Messages 的密钥或端点。
- 模型密钥通过环境变量提供，不要粘贴到会话、命令历史或提交到仓库。

## PowerShell 示例

```powershell
$env:RB_REPO_DIR = 'G:\benchmark-repo'
$env:RB_BASE = '<40位base SHA>'
$env:RB_HEAD = '<40位head SHA>'
$env:RB_NWO = 'owner/repo'
$env:RB_PR_NUMBER = '123'
$env:RB_AGENT = 'dsh-code-review-local'
$env:RB_PROFILE = 'staged-direct'
$env:RB_OUT = 'G:\benchmark-output\fresh-run\findings.json'
$env:RB_CONFIG_MODEL = '<模型名>'
$env:RB_MODEL_BASE_URL = 'https://<可信端点>/v1'
# 在安全环境中预先设置 RB_CONFIG_API_KEY、OPENAI_API_KEY 或 DEEPSEEK_API_KEY。
node scripts/review-bench-adapter.mjs
```

输出父目录须存在，建议为每次尝试创建独立的外部目录，使用支持硬链接的本地文件系统（如 NTFS）。适配器在调用模型前原子创建 `RB_OUT.claim`；同一 `RB_OUT` 的并发调用只有一个获准，已有候选、报告、冒烟文件或认领目录均阻止调用。认领目录在中断或失败后保留；重跑请更换输出路径，不要删除活动认领或让其他程序写入该运行的输出目录。`.claim`、`.report.json`、`.smoke.json` 为保留后缀，不能用于 `RB_OUT`。审查范围是 base/head 的唯一 merge-base 到 head 的固定 Git 对象；不修改被审查的 Git 对象，不读取黄金标注。

## 输出与失败规则

- `RB_OUT.claim/run.json` 在第一次模型请求前记录 base、head、merge-base、适配器所属包版本、配置档、实际策略、模型和生效额度，不写入端点或密钥。`RB_OUT.report.json` 保存相同元数据与完整审查报告。仅将 `RB_OUT` 原有 `pr`、`agent`、`findings`、`usage` 结构交给评分器，不将认领目录、报告或冒烟文件纳入评分。
- 正式候选只在报告 completed 且所有选中文件 completed 时生成。partial/failed/cancelled、未完成文件不冒充空发现或成功。
- 旧侧行、文件级/属性级锚点无法无损表达成基准要求的 head 行号；当前明确失败并保留原报告，不静默丢弃或猜测位置。
- 单次路径只导出宿主协议、身份与锚点标记均通过的单模型候选，未做独立复核；不按行号合并不同问题，只去掉完全相同的导出记录。超过 200 条报错，不裁剪。
- 两档均设 96 KiB 核心输入上限和一轮审查；staged 路径最多 100 次模型调用，每个文件审查链限 120 秒；single-pass 整体最多 1 次调用、限 120 秒。适配器整次运行另有 14 分钟截止。真实 HTTP 请求每次传 `max_tokens: 4096` 并限制响应为 1 MiB；mock 的模型和 HTTP 额度为 `null`，不是提供方用量。
- HTTP 错误不输出响应正文；完整 JSON 或单个完整 JSON fence 使用项目现有严格解析，截断和夹杂文本被拒绝。

## 离线冒烟

设置 `RB_MOCK=1` 后运行。仅生成认领元数据、`.report.json` 与 `.smoke.json`，不生成可评分候选 `RB_OUT`，避免离线结果误入正式评分。mock 不调用真实模型，也不证明检出质量。

## 本地回归与 CI

从仓库根目录运行：

	node --test test/review-bench-adapter.test.mjs test/release-ci-workflow.test.mjs test/release-ci-evidence.test.mjs

ReviewBench 回归使用临时 Git 仓库与受控响应，验证先认领后发送、冲突零发送、评分格式和 mock 隔离。冻结标签的 Ubuntu / Node.js 24 单格另从相同冻结提交打包并在临时项目安装，检查主入口、子入口、语言包、评测入口和文档链接；它没有发布权限，也不证明评测质量。正式发布另打包并验证实际提交给 npm 的安装包，再核对 npm 制品与 GitHub Release 附件，不把矩阵检查用的临时包当作已发布制品。

## 验证边界

这里提供入口和局部回归，不包含下载全部 PR 的调度器，也不包含真实模型或 LLM judge 的评分结果。使用 ReviewBench 的独立 judge 前，需确认候选 PR 身份与基准语料一致，保持失败样本在总数中，并人工核验模型裁决。正式成绩、数据集完整性与生产配置效果仍需单独验证。

来源：[agent 契约](https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md)、[评分输入](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING_INPUT.md)。
