# ReviewBench 本地评测入口（实验）

无需 Docker，不提交公开排行榜，也不改变 DSH 宿主的模型配置。此入口直接调用审查核心，采用 **single-pass-direct**：一次审查，不启用检索、复核或业务分组。因此它的成绩不能代表 DSH 插件完整配置的质量。

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
$env:RB_OUT = 'G:\benchmark-output\fresh-run\findings.json'
$env:RB_CONFIG_MODEL = '<模型名>'
$env:RB_MODEL_BASE_URL = 'https://<可信端点>/v1'
# 在安全环境中预先设置 RB_CONFIG_API_KEY、OPENAI_API_KEY 或 DEEPSEEK_API_KEY。
node scripts/review-bench-adapter.mjs
```

输出父目录须存在，每次使用新的运行目录；已有结果不会被覆盖。读取 base/head 的唯一 merge-base，审查 merge-base 到 head 的固定对象；不修改被审查仓库，不读取黄金标注。

## 输出与失败规则

- `RB_OUT.report.json` 保存完整原报告、mock 标志、配置档与 merge-base，便于追溯覆盖与限制。
- 正式候选只在报告 completed 且所有选中文件 completed 时生成。partial/failed/cancelled、未完成文件不冒充空发现或成功。
- 旧侧行、文件级/属性级锚点无法无损表达成基准要求的 head 行号；当前明确失败并保留原报告，不静默丢弃或猜测位置。
- 不按行号合并不同问题；只去掉完全相同的导出记录。超过 200 条报错，不裁剪。
- 单次请求沿用 120 秒生命周期；整次运行另有 14 分钟截止，不放宽核心输入/调用预算。
- HTTP 错误不输出响应正文；完整 JSON 或单个完整 JSON fence 使用项目现有严格解析，截断和夹杂文本被拒绝。

## 离线冒烟

设置 `RB_MOCK=1` 后运行。只生成 `.report.json` 与 `.smoke.json`，不生成可评分候选 `RB_OUT`，避免离线结果误入正式评分。mock 不调用真实模型，也不证明检出质量。

## 验证边界

这里提供入口和局部回归，不包含下载全部 PR 的调度器，也不包含真实模型或 LLM judge 的评分结果。使用 ReviewBench 的独立 judge 前，需确认候选 PR 身份与基准语料一致，保持失败样本在总数中，并人工核验模型裁决。正式成绩、数据集完整性与生产配置效果仍需单独验证。

来源：[agent 契约](https://github.com/review-bench/ReviewBench/blob/main/AGENT_CONTRACT.md)、[评分输入](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING_INPUT.md)。
