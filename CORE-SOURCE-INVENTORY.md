# 参考源码对照

供维护者核查实现依据。使用方法见 [README](README.md)，开发优先级见 [能力清单](CORE-ALIGNMENT-TASKS.md)。

参考版本固定为 alibaba/open-code-review 提交 2d67596c961f80436deb2afa643efa2b1725d34c，不随上游最新分支变化。

## 对照结论

已阅读核心审查模块、54 篇语言规则，以及相关的 Git 命令、路径、模型和覆盖状态依赖。**阅读完成不等于实现完成。**

| 参考模块 | 当前对应能力 | 仍需补齐 |
|---|---|---|
| agent、delegate | 风险规划、分组、窗口、综合、多次审查、失败回退 | 剩余预算组合与完整场景验收 |
| llmloop | 模型循环、有限检索、候选反证、明确结束状态 | 真实模型质量验证 |
| tool | 批准快照内的文件查找、搜索、读取和证据校验 | 必要语义调用方、定义、别名与实例上下文 |
| config/rules | 语言和文件用途检查提示、显式项目规则 | 剩余专用指导及路径选择验收 |
| diff、gitcmd、pathutil | 只读变更、固定历史对象、路径保护、命令限额 | 不照搬实时无界读取 |
| model、session/manifest | 覆盖状态、未完成原因、失败与取消区别 | 组合场景的整体一致性验收 |

## 有意不同的实现

- 本插件沿用当前 DSH Agent 的模型和权限，不建立单独模型、费用或管理平台。
- 审查前固定源码，执行前重新核验；不让模型读取任意实时工作区。
- 检索最多读取 200 行，且只限批准来源；不照搬参考的任意路径或正则搜索。
- 默认一次审查，可选三次，不照搬参考默认次数和对话继承方式。
- 历史重命名按删除和新增表达；区间比较使用明确端点，不自动计算合并基点。
- 参考中的风格偏好、无条件性能建议和错误绝对规则不作为缺陷标准。

## 语言指导的剩余工作

| 类型 | 剩余重点 |
|---|---|
| F#、R、Elm、Haskell、Julia、Nim、OCaml | 仍以通用指导为主；需处理各语言的资源、求值、数据与运行契约 |
| Rego、Jsonnet、Nix | 策略未定义值、对象合并、构建依赖和具体运行版本 |
| Solidity、Vyper | 部署版本、存储布局、重入、外部调用与实际消费者 |
| Verilog/SystemVerilog、VHDL | 调度、位宽、有符号值、时钟跨域和目标工具支持 |
| Zig | 分配器、异常清理、借用寿命和构建模式 |
| PO/POT、MyBatis 映射文件 | 文本身份、占位符、复数规则、绑定值与动态 SQL |
| JS/TS/React | hook、异步清理、渲染副作用的实际缺陷与反证 |
| Go、Python、Rust | 版本前提、并发、宏求值和调用契约细化 |
| Objective-C、Swift、MATLAB、ArkTS、PHP、Kotlin、Java、C/C++ | 大类指导已有；部分生命周期、并发、版本和调用场景需具体测试 |
| 模板、依赖清单、基础设施 | 转义方式、引擎版本、消费者与部署约束，不按文件名推定行为 |

Protobuf、Thrift、Cap’n Proto、GraphQL、Prisma 的专用指导已交付。不把协议检查提示当作解析器、迁移执行结果或缺陷证据。

## 固定参考文件索引

下表仅记录查证来源。分类代码的含义：A1=源码对照，A2=调度与预算，A3=审查次数；B1=调用方，B2=旧版本上下文，B3=定义；C2=输出格式，C3=大输入；D1=语言指导，E1=整体验收。

| 参考文件 | 阅读状态 | 分类 |
|---|---|---|
|[agent/agent.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/agent.go)|已阅读|A1|
|[agent/estimate.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/estimate.go)|已阅读|A1|
|[agent/grouping.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/grouping.go)|已阅读|A1|
|[agent/identity.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/identity.go)|已阅读|A1|
|[agent/preview.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/preview.go)|已阅读|A1|
|[agent/selection.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/selection.go)|已阅读|A1|
|[agent/util.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/util.go)|已阅读|A1|
|[delegate/format.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/delegate/format.go)|已阅读|A1|
|[delegate/rulegroup.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/delegate/rulegroup.go)|已阅读|A1|
|[llmloop/compression.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/compression.go)|已阅读|A1|
|[llmloop/loop.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/loop.go)|已阅读|A1|
|[llmloop/pool.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/pool.go)|已阅读|A1|
|[llmloop/tool_args_json.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/tool_args_json.go)|已阅读|A1|
|[llmloop/tool_failure_streak.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/tool_failure_streak.go)|已阅读|A1|
|[tool/code_comment.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/code_comment.go)|已阅读|A1|
|[tool/code_search.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/code_search.go)|已阅读|A1|
|[tool/comment_args_repair.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/comment_args_repair.go)|已阅读|A1|
|[tool/comment_collector.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/comment_collector.go)|已阅读|A1|
|[tool/definitions.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/definitions.go)|已阅读|A1|
|[tool/file_find.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/file_find.go)|已阅读|A1|
|[tool/file_read.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/file_read.go)|已阅读|A1|
|[tool/file_read_diff.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/file_read_diff.go)|已阅读|A1|
|[tool/filereader.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/filereader.go)|已阅读|A1|
|[tool/response_message.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/response_message.go)|已阅读|A1|
|[tool/stub.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/stub.go)|已阅读|A1|
|[diff/git.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/git.go)|已阅读|A1|
|[diff/gitignore.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/gitignore.go)|已阅读|A1|
|[diff/hunk.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/hunk.go)|已阅读|A1|
|[diff/parser.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/parser.go)|已阅读|A1|
|[diff/quotedpath.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/quotedpath.go)|已阅读|A1|
|[diff/relocation.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/relocation.go)|已阅读|A1|
|[diff/resolver.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/resolver.go)|已阅读|A1|
|[diff/workspace_file.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/workspace_file.go)|已阅读|A1|
|[config/allowlist/allowed_ext.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/allowed_ext.go)|已阅读|A1|
|[config/allowlist/default_exclude_patterns.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/default_exclude_patterns.json)|已阅读|A1|
|[config/allowlist/default_secret_patterns.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/default_secret_patterns.json)|已阅读|A1|
|[config/allowlist/secret_path.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/secret_path.go)|已阅读|A1|
|[config/allowlist/supported_file_types.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/supported_file_types.json)|已阅读|A1|
|[config/rules/sniffer.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/sniffer.go)|已阅读|A1|
|[config/rules/system_rules.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/system_rules.go)|已阅读|A1|
|[config/rules/system_rules.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/system_rules.json)|已阅读|A1|
|[config/template/effort.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/effort.go)|已阅读|A1|
|[config/template/scan_template.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/scan_template.json)|已阅读|A1|
|[config/template/task_template.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/task_template.json)|已阅读|A1|
|[config/template/template.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/template.go)|已阅读|A1|
|[config/testconnection/task.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/testconnection/task.json)|已阅读|A1|
|[config/testconnection/testconnection.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/testconnection/testconnection.go)|已阅读|A1|
|[config/toolsconfig/tools.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/toolsconfig/tools.json)|已阅读|A1|
|[config/toolsconfig/toolsconfig.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/toolsconfig/toolsconfig.go)|已阅读|A1|
|[config/template/prompts/grouping_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/grouping_task_system.md)|已阅读|A1|
|[config/template/prompts/grouping_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/grouping_task_user.md)|已阅读|A1|
|[config/template/prompts/main_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/main_task_system.md)|已阅读|A1|
|[config/template/prompts/main_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/main_task_user.md)|已阅读|A1|
|[config/template/prompts/memory_compression_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/memory_compression_task_system.md)|已阅读|A1|
|[config/template/prompts/memory_compression_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/memory_compression_task_user.md)|已阅读|A1|
|[config/template/prompts/plan_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/plan_task_system.md)|已阅读|A1|
|[config/template/prompts/plan_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/plan_task_user.md)|已阅读|A1|
|[config/template/prompts/re_location_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/re_location_task_system.md)|已阅读|A1|
|[config/template/prompts/re_location_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/re_location_task_user.md)|已阅读|A1|
|[config/template/prompts/review_filter_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/review_filter_task_system.md)|已阅读|A1|
|[config/template/prompts/review_filter_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/review_filter_task_user.md)|已阅读|A1|
|[config/rules/rule_docs/arkts.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/arkts.md)|已阅读|D1|
|[config/rules/rule_docs/astro.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/astro.md)|已阅读|D1|
|[config/rules/rule_docs/bicep.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/bicep.md)|已阅读|D1|
|[config/rules/rule_docs/build_gradle.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/build_gradle.md)|已阅读|D1|
|[config/rules/rule_docs/c.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/c.md)|已阅读|D1|
|[config/rules/rule_docs/capnp.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/capnp.md)|已阅读|D1|
|[config/rules/rule_docs/cargo_toml.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/cargo_toml.md)|已阅读|D1|
|[config/rules/rule_docs/composer_json.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/composer_json.md)|已阅读|D1|
|[config/rules/rule_docs/cpp.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/cpp.md)|已阅读|D1|
|[config/rules/rule_docs/default.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/default.md)|已阅读|D1|
|[config/rules/rule_docs/elm.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/elm.md)|已阅读|D1|
|[config/rules/rule_docs/freemarker.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/freemarker.md)|已阅读|D1|
|[config/rules/rule_docs/fsharp.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/fsharp.md)|已阅读|D1|
|[config/rules/rule_docs/github_config.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/github_config.md)|已阅读|D1|
|[config/rules/rule_docs/github_workflows.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/github_workflows.md)|已阅读|D1|
|[config/rules/rule_docs/go.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/go.md)|已阅读|D1|
|[config/rules/rule_docs/graphql.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/graphql.md)|已阅读|D1|
|[config/rules/rule_docs/handlebars_mustache.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/handlebars_mustache.md)|已阅读|D1|
|[config/rules/rule_docs/haskell.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/haskell.md)|已阅读|D1|
|[config/rules/rule_docs/java.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/java.md)|已阅读|D1|
|[config/rules/rule_docs/jinja.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/jinja.md)|已阅读|D1|
|[config/rules/rule_docs/json.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/json.md)|已阅读|D1|
|[config/rules/rule_docs/jsonnet.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/jsonnet.md)|已阅读|D1|
|[config/rules/rule_docs/julia.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/julia.md)|已阅读|D1|
|[config/rules/rule_docs/kotlin.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/kotlin.md)|已阅读|D1|
|[config/rules/rule_docs/mapper_dao_xml.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/mapper_dao_xml.md)|已阅读|D1|
|[config/rules/rule_docs/matlab.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/matlab.md)|已阅读|D1|
|[config/rules/rule_docs/nim.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/nim.md)|已阅读|D1|
|[config/rules/rule_docs/nix.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/nix.md)|已阅读|D1|
|[config/rules/rule_docs/objc.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/objc.md)|已阅读|D1|
|[config/rules/rule_docs/ocaml.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/ocaml.md)|已阅读|D1|
|[config/rules/rule_docs/package_json.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/package_json.md)|已阅读|D1|
|[config/rules/rule_docs/php.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/php.md)|已阅读|D1|
|[config/rules/rule_docs/po.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/po.md)|已阅读|D1|
|[config/rules/rule_docs/pom_xml.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/pom_xml.md)|已阅读|D1|
|[config/rules/rule_docs/pot.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/pot.md)|已阅读|D1|
|[config/rules/rule_docs/prisma.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/prisma.md)|已阅读|D1|
|[config/rules/rule_docs/properties.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/properties.md)|已阅读|D1|
|[config/rules/rule_docs/protobuf.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/protobuf.md)|已阅读|D1|
|[config/rules/rule_docs/pug.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/pug.md)|已阅读|D1|
|[config/rules/rule_docs/python.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/python.md)|已阅读|D1|
|[config/rules/rule_docs/r.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/r.md)|已阅读|D1|
|[config/rules/rule_docs/rego.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/rego.md)|已阅读|D1|
|[config/rules/rule_docs/rust.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/rust.md)|已阅读|D1|
|[config/rules/rule_docs/solidity.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/solidity.md)|已阅读|D1|
|[config/rules/rule_docs/swift.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/swift.md)|已阅读|D1|
|[config/rules/rule_docs/terraform.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/terraform.md)|已阅读|D1|
|[config/rules/rule_docs/thrift.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/thrift.md)|已阅读|D1|
|[config/rules/rule_docs/ts_js_tsx_jsx.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/ts_js_tsx_jsx.md)|已阅读|D1|
|[config/rules/rule_docs/verilog.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/verilog.md)|已阅读|D1|
|[config/rules/rule_docs/vhdl.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/vhdl.md)|已阅读|D1|
|[config/rules/rule_docs/vyper.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/vyper.md)|已阅读|D1|
|[config/rules/rule_docs/yaml.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/yaml.md)|已阅读|D1|
|[config/rules/rule_docs/zig.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/zig.md)|已阅读|D1|

相关依赖还包括 internal/gitcmd、internal/pathutil、internal/model 和 internal/session/manifest.go。会话存储、历史管理、自动修复及独立扫描平台不在本项目范围内。
