# 固定参考核心逐文件清单

固定提交2d67596c961f80436deb2afa643efa2b1725d34c；轮56通过contents API目录枚举所得，排除测试，逐条记录生产源码/模板/规则文档。读取不等于功能闭环。跨目录session/model/llm/gitcmd依赖仍须后续补。第二次API收集遭非数组响应，采用本轮已成功读取的目录结果，不推断遗漏文件。

|文件|读取状态|任务|
|---|---|---|
|[agent/agent.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/agent.go)|已读；闭环须看任务表|A1|
|[agent/estimate.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/estimate.go)|已读；闭环须看任务表|A1|
|[agent/grouping.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/grouping.go)|已读；闭环须看任务表|A1|
|[agent/identity.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/identity.go)|已读；闭环须看任务表|A1|
|[agent/preview.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/preview.go)|已读；闭环须看任务表|A1|
|[agent/selection.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/selection.go)|已读；闭环须看任务表|A1|
|[agent/util.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/util.go)|已读；闭环须看任务表|A1|
|[delegate/format.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/delegate/format.go)|已读；闭环须看任务表|A1|
|[delegate/rulegroup.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/delegate/rulegroup.go)|已读；闭环须看任务表|A1|
|[llmloop/compression.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/compression.go)|已读；闭环须看任务表|A1|
|[llmloop/loop.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/loop.go)|已读；闭环须看任务表|A1|
|[llmloop/pool.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/pool.go)|已读；闭环须看任务表|A1|
|[llmloop/tool_args_json.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/tool_args_json.go)|已读；闭环须看任务表|A1|
|[llmloop/tool_failure_streak.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/tool_failure_streak.go)|已读；闭环须看任务表|A1|
|[tool/code_comment.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/code_comment.go)|已读；闭环须看任务表|A1|
|[tool/code_search.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/code_search.go)|已读；闭环须看任务表|A1|
|[tool/comment_args_repair.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/comment_args_repair.go)|已读；闭环须看任务表|A1|
|[tool/comment_collector.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/comment_collector.go)|已读；闭环须看任务表|A1|
|[tool/definitions.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/definitions.go)|已读；闭环须看任务表|A1|
|[tool/file_find.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/file_find.go)|已读；闭环须看任务表|A1|
|[tool/file_read.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/file_read.go)|已读；闭环须看任务表|A1|
|[tool/file_read_diff.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/file_read_diff.go)|已读；闭环须看任务表|A1|
|[tool/filereader.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/filereader.go)|已读；闭环须看任务表|A1|
|[tool/response_message.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/response_message.go)|已读；闭环须看任务表|A1|
|[tool/stub.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/stub.go)|已读；闭环须看任务表|A1|
|[diff/git.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/git.go)|已读；闭环须看任务表|A1|
|[diff/gitignore.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/gitignore.go)|已读；闭环须看任务表|A1|
|[diff/hunk.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/hunk.go)|已读；闭环须看任务表|A1|
|[diff/parser.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/parser.go)|已读；闭环须看任务表|A1|
|[diff/quotedpath.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/quotedpath.go)|已读；闭环须看任务表|A1|
|[diff/relocation.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/relocation.go)|已读；闭环须看任务表|A1|
|[diff/resolver.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/resolver.go)|已读；闭环须看任务表|A1|
|[diff/workspace_file.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/diff/workspace_file.go)|已读；闭环须看任务表|A1|
|[config/allowlist/allowed_ext.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/allowed_ext.go)|已读；闭环须看任务表|A1|
|[config/allowlist/default_exclude_patterns.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/default_exclude_patterns.json)|已读；闭环须看任务表|A1|
|[config/allowlist/default_secret_patterns.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/default_secret_patterns.json)|已读；闭环须看任务表|A1|
|[config/allowlist/secret_path.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/secret_path.go)|已读；闭环须看任务表|A1|
|[config/allowlist/supported_file_types.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/supported_file_types.json)|已读；闭环须看任务表|A1|
|[config/rules/sniffer.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/sniffer.go)|已读；闭环须看任务表|A1|
|[config/rules/system_rules.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/system_rules.go)|已读；闭环须看任务表|A1|
|[config/rules/system_rules.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/system_rules.json)|已读；闭环须看任务表|A1|
|[config/template/effort.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/effort.go)|已读；闭环须看任务表|A1|
|[config/template/scan_template.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/scan_template.json)|已读；闭环须看任务表|A1|
|[config/template/task_template.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/task_template.json)|已读；闭环须看任务表|A1|
|[config/template/template.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/template.go)|已读；闭环须看任务表|A1|
|[config/testconnection/task.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/testconnection/task.json)|已读；闭环须看任务表|A1|
|[config/testconnection/testconnection.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/testconnection/testconnection.go)|已读；闭环须看任务表|A1|
|[config/toolsconfig/tools.json](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/toolsconfig/tools.json)|已读；闭环须看任务表|A1|
|[config/toolsconfig/toolsconfig.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/toolsconfig/toolsconfig.go)|已读；闭环须看任务表|A1|
|[config/template/prompts/grouping_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/grouping_task_system.md)|已读；闭环须看任务表|A1|
|[config/template/prompts/grouping_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/grouping_task_user.md)|已读；闭环须看任务表|A1|
|[config/template/prompts/main_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/main_task_system.md)|已读；闭环须看任务表|A1|
|[config/template/prompts/main_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/main_task_user.md)|已读；闭环须看任务表|A1|
|[config/template/prompts/memory_compression_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/memory_compression_task_system.md)|已读；闭环须看任务表|A1|
|[config/template/prompts/memory_compression_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/memory_compression_task_user.md)|已读；闭环须看任务表|A1|
|[config/template/prompts/plan_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/plan_task_system.md)|已读；闭环须看任务表|A1|
|[config/template/prompts/plan_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/plan_task_user.md)|已读；闭环须看任务表|A1|
|[config/template/prompts/re_location_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/re_location_task_system.md)|已读；闭环须看任务表|A1|
|[config/template/prompts/re_location_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/re_location_task_user.md)|已读；闭环须看任务表|A1|
|[config/template/prompts/review_filter_task_system.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/review_filter_task_system.md)|已读；闭环须看任务表|A1|
|[config/template/prompts/review_filter_task_user.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/template/prompts/review_filter_task_user.md)|已读；闭环须看任务表|A1|
|[config/rules/rule_docs/arkts.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/arkts.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/astro.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/astro.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/bicep.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/bicep.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/build_gradle.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/build_gradle.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/c.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/c.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/capnp.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/capnp.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/cargo_toml.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/cargo_toml.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/composer_json.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/composer_json.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/cpp.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/cpp.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/default.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/default.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/elm.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/elm.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/freemarker.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/freemarker.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/fsharp.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/fsharp.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/github_config.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/github_config.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/github_workflows.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/github_workflows.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/go.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/go.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/graphql.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/graphql.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/handlebars_mustache.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/handlebars_mustache.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/haskell.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/haskell.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/java.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/java.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/jinja.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/jinja.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/json.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/json.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/jsonnet.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/jsonnet.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/julia.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/julia.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/kotlin.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/kotlin.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/mapper_dao_xml.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/mapper_dao_xml.md)|正文已取；长文补核查及验收待D1|D1|
|[config/rules/rule_docs/matlab.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/matlab.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/nim.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/nim.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/nix.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/nix.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/objc.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/objc.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/ocaml.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/ocaml.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/package_json.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/package_json.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/php.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/php.md)|正文已取；长文补核查及验收待D1|D1|
|[config/rules/rule_docs/po.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/po.md)|正文已取；长文补核查及验收待D1|D1|
|[config/rules/rule_docs/pom_xml.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/pom_xml.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/pot.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/pot.md)|正文已取；长文补核查及验收待D1|D1|
|[config/rules/rule_docs/prisma.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/prisma.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/properties.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/properties.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/protobuf.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/protobuf.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/pug.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/pug.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/python.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/python.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/r.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/r.md)|正文已取；长文补核查及验收待D1|D1|
|[config/rules/rule_docs/rego.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/rego.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/rust.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/rust.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/solidity.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/solidity.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/swift.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/swift.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/terraform.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/terraform.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/thrift.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/thrift.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/ts_js_tsx_jsx.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/ts_js_tsx_jsx.md)|已读完整正文；能力验收待D1|D1|
|[config/rules/rule_docs/verilog.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/verilog.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/vhdl.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/vhdl.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/vyper.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/vyper.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/yaml.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/yaml.md)|已读正文；能力验收待D1|D1|
|[config/rules/rule_docs/zig.md](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/rules/rule_docs/zig.md)|已读正文；能力验收待D1|D1|

## 本轮四文件判定

- estimate.go：固定overhead/平均7轮token估算，删除跳过；现coverage-plan真实bytes/minCalls为明确安全替代，不做独立成本平台。
- identity.go：selection后冻结输入及规则hash、range merge-base；现preview/execute重捕获身份，exact端点为刻意替代，resume持久平台不照搬。
- util.go：confirmed裁剪、空plan块移除、fence剥离/XML/token；现strict JSON及原始证据预算替代，多pass仍待A3。
- format.go：规则source/pattern/适用文件Markdown；现规则显式统一，路径分派D1未完，不重印不可信规则。

## 轮57工具/定位逐文件判定

- tool/file_read.go：500行上限、显式truncated/范围/总行；我们200行快照来源ID+hash、64KiB/result累计256KiB，严格整数/整批预校验为安全替代。
- tool/filereader.go：workspace实时文件/symlink范围，历史ref git show、30s/stream全行计数；我们执行前捕获稳定OID/正文，执行只snapshot，拒绝所有link且字节限额。范围外必要caller仍B1，实时读取不照搬。
- tool/definitions.go：tool注册冻结、动态MCP保留名；我们固定read/search/find能力不注入动态工具，宿主注册preview/execute保持正常策略。
- tool/response_message.go：Completed/Failed/Data终止协议；我们最终JSON严格schema、failed/cancelled/partial显式状态，不伪success。
- tool/stub.go：缺provider返回not-available；我们未知kind及来源在访问前拒绝，不添加stub伪能力。
- tool/code_comment.go：宽松解析会跳过非对象/缺字段，默认路径、类别/severity降级；我们整批严格候选身份severity定位/归因，不能静默丢候选。style/documentation等类别不在具体缺陷范围；serialized repair仍C2明确不复制。
- tool/comment_collector.go：per-agent互斥存储、按path切片替换/删除；我们per-report候选原记录保留及精确duplicate分组，不引入模型模糊删除。
- llmloop/pool.go：默认8并发异步comment后处理、按key等待，panic/error仅日志且零comments；我们同步同signal/预算复核，incomplete显式，拒绝把失败当零缺陷，不复制后台平台。
- diff/resolver.go：新hunk后旧hunk/新全文，trim/去diff前缀/略空行首匹配，跨file唯一命中重投；我们原snippet完整行exact唯一只同file/side纠行、保留原候选，刻意更严格，不迁移语义/来源。
- diff/relocation.go：LLM生成新existing_code再resolve，失败还原；我们不允许模型替换原定位证据，故明确范围外；定位纠正不证明因果。
- diff/quotedpath.go：C风格路径byte解码，拒绝无效octal；我们Git NUL元数据/literal path不解析patch header，危险路径由relativePath拒绝，已有路径回归。

此轮tool/llmloop清单已读项齐，不等于A1全部闭环：diff另外5文件、config及模板/规则正文、跨目录依赖仍待。

## 轮58剩余Diff分类

- diff/hunk.go：unified @@默认count1、去no-newline元数据、按prefix提取；我们两侧正文line-diff/change-map原始行区间，限额limited明确，不解析任意patch。
- diff/parser.go：quoted header/CRLF/new/deleted/rename/binary/churn，finalize读取失败仅warning正文空；我们NUL metadata与受限blob/local捕获，失败blocked不会空正文伪成功。
- diff/workspace_file.go：父路径symlink范围、文件symlink读link目标字符串、untracked64MiB；我们256KiB普通文件、拒绝link、UTF8/BOM UTF16严格decode，安全替代不扩限额。
- diff/gitignore.go：导出provider目录排除及简化gitignore匹配；当前Git status标准untracked ignore、tracked不按工作树gitignore再丢，显式选项与凭据门禁透明，刻意不隐藏tracked修改。规则路径选择D1后续核查。
- diff/git.go：workspace HEAD失败/空回退staged；untracked自动列读、读取失败跳过、8KiB NUL sniff/超64MiB binary；range merge-base，commit first-parent含merge，rename统一patch；我们untracked只显式选、失败blocked、全bodydecode/bytes门禁、unborn真实空baseline、range exact endpoints、merge要求range、历史rename add/delete。已有真实Git历史/root/merge/大树/rename/status回归；provider行为有安全替代而非完全等价。远程identity用于manifest持久resume平台不照搬。

Diff目录8生产文件已读；config模板/规则正文和相关跨目录依赖A1仍未完成，不能停止于此。

## 轮59审查模板15文件

- template.go/task_template.json：默认独立2review rounds，100tool请求，200000prompt tokens/16384completion；plan单file50行或group100、grouping少于4且总churn<200本地bundle，否则perfile；我们bytes/calls/120s固定budget非token等价。小变更skip A2与独立multi-pass A3明确未实现，不以retrieval3轮充当review轮。
- effort.go：low/medium/high映射review1/2/3次，是审查工作量不是模型reasoning effort；插件继承DSH模型effort不等价，独立pass需预算/预览/coverage协议后实现，不引入模型平台。
- plan system/user：待证风险+工具意图不执行、requirement/rules；我们严格risk schema/sourceIds、缺caller限制、原预算fallback，风格和忽略deletion不照搬。
- main system/user：每组每file独立pass、上下文工具只背景、评论仅review_files，plan/requirements/confirmed注入；我们primary独立+interaction、snapshot目录边界/归因/需求已实现，多pass移除plan仍缺。
- filter system/user：只diff明证反驳可移除，memory/concurrency/compatibility等protected veto，unverifiable approve，风格低价值保留；我们不删除候选、证据反证verdict不确定保留，比approve状态更诚实，不复制protected永不反驳或style范围。
- grouping system/user：全部文件整数身份覆盖，最多10，生产fallback补遗漏；我们ID严格所有覆盖、最多4，安全替代，跳过策略A2。
- compression system/user：摘要无具体代码，confirmed/conclusions/completed/pending/focus；我们3轮原文证据有界，拒绝用摘要当证据，长思考C3待评估。
- relocation system/user：模型改existing snippet选择单相关段；我们不可变原anchor精确唯一校正，同file/side，不照搬证据替换。

scan_template.json尚未读需界定full scan范围；其他config规则/allowlist/工具schema及依赖仍待。

## 轮60其余配置九文件

- allowed_ext.go/supported_file_types.json：大小写无关扩展allowlist；default_exclude_patterns.json排除tests/fixture/generated/dependencies/build/lock等。我们严格可解码有界文本+显式changed选择，凭据强门禁；不因扩展隐藏未知文本，也不静默排除测试/锁文件真实缺陷，明确行为不同。必要语言指导映射D1未完成，非扩大无界扫描。
- system_rules.go：有序first-match pattern，custom>project>global>system，用户默认replace可merge_system_rule，最高有include/exclude层负责filter（不是层合并），规则来源pattern可追踪；项目root自动读rule.json/引用文件，global/home自动读，文件512KiB及symlink检查。我们显式rulePaths4个/16KiB每个/32KiB合计、批准snapshot/hash保持，不自动项目/global读取；路径分派与来源透明仍D1，不能称完全等价。
- toolsconfig.go/tools.json：外部/embedded工具schema按plan/main过滤，task_done/comment/find/search/diff/read，read目标侧500行，search支持regex/pathspec100条。我们固定严格JSON read/search/find sourceIds批准范围200行、无regex、整批预校验；plan只source意图，不挂动态工具，范围外callerB1待实现。
- testconnection.go/task.json：工具call roundtrip连接测试120s；独立provider连接配置不在范围，当前DSH route与离线runtime smoke已覆盖宿主接口，真实模型效果后置不声称已连接质量验收。
- scan_template.json：全file scan，无diff、by-language50 batch、60tool/2MiB、模型near-duplicate删除及项目summary；不属于本项目变更回归核心目标，不实现全仓scan平台/模糊去重。全文necessary context不等于全仓扫描。

六目录生产配置源码现已读；54篇rule_docs仍未读，对语言能力不能泛称完成；相关跨目录依赖也待补。

## 轮61首批语言正文与D1验收缺口

直接fetch default/c/cpp/go/java/ts_js_tsx_jsx/python/rust/objc/matlab/fsharp/kotlin共12篇；输出长字符串被格式器省略，读取spill和raw尾段补内容但保守记正文核查中，不称全文闭环。当前defect-guidance版本4按实际正文对比，检查项仅生成导航不是事实证明。

|语言|现有对应|必要具体缺口/验收|不照搬|
|---|---|---|---|
|default|trigger/impact/changed evidence及反证|保持缺caller uncertainty，不把未发现当正确|命名风格/泛测试覆盖|
|C/C++|ownership/allocator/bounds/UB/同步/清理|C分配失败和NUL终止检查需具体场景；宏/overload未解析不猜|auto/STL/rawpointer禁令/未用变量|
|Go|typednil/error/goroutine/channel/alias|版本依赖Go1.22 loop capture、Go1.23 timer回收/reset不泛报leak；Once失败不重试、rows.Err与RLock写场景|编译/格式重复警告与默认test排除|
|Java|null/unboxing/equality/thread/transaction|以caller并发和数据量为前提，现已有大类不宣称覆盖所有场景|拼写/未用变量|
|TS/JS|promises/listener/输入安全|React hooks依赖/cleanup、渲染副作用具体回归场景需要专用提示，类型不能代运行时验证|var/any/==禁止/inline style/强制Promise.all|
|Python|mutable default/contextmanager/async/security|is literal/优化模式assert外部验证、pyi静态声明不得当dead code，需场景验收|None比较风格/短脚本强制with/微优化|
|Rust|unsafe/FFI/SendSync/await/cancellation|macro tt与expr解析边界，现有泛指引未专门覆盖|强制clone/iterator偏好或静态编译重复|
|Objective-C|ownership/callback/queue|NSNull vs nil、NSNumber指针bool、NSNotFound、UTF8String临时缓冲、optional selector/local delegate、KVO/bridge契约未具体覆盖|任何category/swizzle即问题、自动observer teardown泛报|
|MATLAB|shape/NaN/precision/cleanup|列迭代、reduction dimension、隐式broadcast、integer饱和/rounding、复共轭transpose及onCleanup需具体验收|注释行长/全局禁令/未证性能微优化|
|F#|当前generic，没有专用|fs/fsi/fsx：use逃逸/seq重复副作用/Option.get/Result、.NET空与CancellationToken、signature契约|编译exhaustive/Fantomas风格|
|Kotlin|null/coroutine/use/interop|现有具体缺陷方向对应，独立归因和scope监督场景待验收|conciseness/data class/Sequence/inline强制|

D1后续优先补F#专用及Go版本反证，其他规则剩余42篇仍未读；不把首批映射当语言全覆盖。

## 轮62协议与配置15篇正文

本轮直接正文读取完整（最大6422字），对应现有protocol-schema/configuration/dependency-manifest/workflow指引为部分，不等于具体协议语义齐。

|规则|当前对应与需补验收|不照搬或反证要求|
|---|---|---|
|graphql|通用protocol提示不应导入numeric tag；需独立non-null input/default/operation兼容提示|无编号概念；不能因无auth directive就认定resolver无权限，新增enum也要实际consumer边界|
|prisma|当前migration/referential提示泛化；需provider/relationMode/generatedclient/migration上下文|不能按name要求index/tenant；已迁移与caller更新反证|
|protobuf|tag/reserved/oneof/presence/JSON名具体兼容方向|新鲜field additive不泛报；enum数字和消费者而非声明位置|
|thrift|字段id/type header、method name/oneway/required/default差异|没有reserved关键字；include/namespace也需实际绑定而非一律忽略|
|capnp|ordinal固定width/default XOR、显式type id、union兼容|同ordinal rename本身通常不破wire；不按声明次序判编号，需独立提示|
|json/yaml|参考仅key拼写，现基于consumer/schema/units/default明显更广|纯拼写不照搬、值仍需审核不能按参考忽略|
|properties|duplicate覆盖/转义/secret检查已有configuration大类|格式与空白需真实parser契约|
|package_json|当前entry/runtime/hooks兼容大类|wildcard/重复dev依赖不独立即bug；缺scripts tool需workspace/全局runner反证|
|cargo_toml|feature/MSRV/edition/resolver/package泄漏纳入dependency检查|pin偏好不能当bug、库兼容ranges允许|
|composer_json|autoload/allowplugins/platform/repositories/require生产依赖具体未细化|不能仅plugin执行即漏洞；lock/平台可反证|
|pom_xml/build_gradle|参考仅新snapshot依赖禁止，现兼容/消费者更具体|parent-managed及实际生产解算必须读取，snapshot不是单独缺陷|
|github_config|issue输入schema/release分类需captured工具消费者|外部labels不能无证说不存在，默认guidance未专用|
|github_workflows|现trust/PRhead/permissions/artifacts依赖具体方向对应|缺permissions不自动broad、缺timeout非无限、tag/cache/failfast不自动bug；验证上下文实际默认|

首批12篇仍保守核查中；本批15篇已读，余27篇未读。D1协议细分及依据透明仍待实现，caller/旧context不因规则阅读完成。

## 轮63模板/基础设施/策略十篇

完整读取astro/freemarker/handlebars_mustache/jinja/pug/bicep/terraform/nix/rego/jsonnet（最长Pug7702字符）。现模板/infrastructure通用提示只有大类对应，不能声称引擎语义已实现。

|规则|当前与必要专用验收|反证/范围替代|
|---|---|---|
|Astro|server/client秘密与serialization边界、hydration/adapter运行前提待细化|不能仅client:load、is:global等即性能bug；需要规模/真实功能后果|
|FreeMarker|输出格式/ftlh自动escaping、context builtin、locale机器输出待专用|无显式html不等于未escape；engine版本与host设置必须获证；强制controller拆分不照搬|
|Handlebars/Mustache|默认HTMLescape、helper/data collision、context depth、zero条件、partial engine支持待细化|普通双brace文本不泛报XSS，输出格式serializer必须按sink|
|Jinja|autoescape host、tojson属性quote、Undefined/falseydefault、loop scope待专用|不强制StrictUndefined，不把未见host当不安全|
|Pug|untrusted &attributes区别于mixin已escape属性、inline JSON script terminator、compiler options trust待专用|不要以普通#{}/=输出为未escape，必须callee/caller与Pug版本|
|Bicep|现infra大类对应secure参数/真实network/role范围|无optionalhardening不自动bug；api-version不要求最新；外部private endpoint需上下文|
|Terraform|state/plaintext/生命周期破坏与scopeconsumer大类已有|sensitive不证明秘密加密；缺prevent_destroy不单独报，实际provider/state不凭空推断|
|Nix|当前infra仅权限顺序大类；overlay final/prev、build inputs、flake系统输出、lazy rec待专用|不强制flakes/channels迁移，需构建/部署消费者证据|
|Rego|当前generic；undefined vs false/negation/existential、deny调用方、rule union、OPA版本待专用|缺default不独立绕过，http.send默认5s/TLS、with合法，trace不等普通日志|
|Jsonnet|当前generic；self/$/super晚绑定、+:与浅merge、hiddenfields/forcedassert/外部输入待专用|extVar可以通过ext-code传非string，不能复制全是字符串绝对说法；K8s null/omission需实际应用方式|

余17篇规则未读，首批12长文仍核查中；D1专用指引需场景测试，不把读取当交付。

## 轮64剩余语言与翻译11篇

直接读取arkts/elm/haskell/julia/nim/ocaml/php/mapper_dao_xml/po/pot/r；首组长文组合显示省略，保守记录正文已取但需小段补核查，不声明完整闭环。PHP/R及映射翻译组完整显示。

- PHP：当前ownership/error/security大类部分对应，foreach引用变量未unset、array union vs merge、isset/empty区分、PHP版本numeric-string、session锁长期持有需专用场景。短request资源自动关闭与framework ownership是反证，不泛报未close。
- R：generic未覆盖vector recycling/NA/dimension drop、NSE/.data/.env、data.table caller原地修改、lazy闭包捕获、S3/S4 dispatch及随机数并发。不得仅缺set.seed或library或非vector写法就报缺陷，需真实复现数据和调用前提。
- mapper_dao_xml：参数绑定与动态SQL大类对应，namespace/interface id、动态where/set/foreach空集合、${}输入来源需专用。#{ }不当字符串自动净化，而是绑定值；动态identifier需allowlist，缺where未必fullscan问题，需真实索引/规模。
- PO/POT：当前generic，需按msgctxt+msgid确定身份、placeholder names/types/位置、Plural-Forms消费者与multiline拼接；POT空msgstr合法。不能仅duplicate msgid不同msgctxt就冲突，也不凭翻译偏好报bug。
- ArkTS：生命周期timer/listener和server数据大类部分，State/Observed更新机制需项目ArkUI版本反证；参考push必须替换、20项必须lazy、async必须catch等绝对禁令不复制。
- Elm/Haskell/Julia/Nim/OCaml：generic为主，需补实际语言效应、FFI/运行版本和调用契约；长正文小段完整核查后列专用验收，未声称语义齐。

现在6篇规则仍未读（solidity/swift/verilog/vhdl/vyper/zig），首批12+本批首组6需要补核查；相关依赖仍待。

## 轮65最后六篇正文

完整读取solidity/swift/verilog/vhdl/vyper/zig，最长Swift8201字符，本次直接正文无省略。规则清单不再有从未读取条目，但前批长文核查状态仍保留，不等于A1/D1闭环。

- Solidity：当前generic不足；需pragma>=0.8 checked/unchecked、reachable跨函数reentrancy、token hook/nonbool返回、proxy storage/签名domain/实际oracle。不能按.sol就认定合约（Gerber），缺event或普通external即问题不复制；selfdestruct后果受链fork/EIP6780前提约束，需版本而非参考绝对brick。
- Vyper：generic不足；0.3/0.4 external关键字/nonreentrant/module初始化、raw_call返回形态、容量/unsafe arithmetic需专用；无inheritance不等于不能delegate proxy，参考“无proxy standard所以必blueprint/copy”不复制，storage实际部署需证据。Transient storage按transaction而非所有call清零，不能泛化。
- Swift：已有ARC/actor/cancellation大类部分；SwiftUI identity/state生命周期、continuation一次性、Combine owner cycle、entitlement canonical state需场景。单独未本地化/无.task(id:)不证明回归，非Sendable编译错误不重复泛报。
- Verilog：需.sv/.vh与.v语言歧义、procedural blocking/nonblocking实际调度、latch/width/signed/CDC/target flow专用；不称同block顺序随机，不强制FPGA initial不综合，不泛报适当net多driver。
- VHDL：generic不足；delta更新、signal vs variable、signed resize保留sign、range方向、CDC/recovery需专用；完整case不要求others，process(all)有2008前提，不能忽略target支持。
- Zig：generic不足；allocator匹配/errdefer/借用逃逸、errorunion/optional、C布局ownership、buildmode/版本需专用；Debug安全检查仍可能真实panic，但不能泛称ReleaseFast之外无bug。编译与格式重复不报告。

下一阶段先补此前18篇长文的小段读取、限定gitcmd/pathutil/model/session实际审核依赖而非平台全量；后按B1/B2/A2/A3/D1验收实现，不把read状态当completion。

## 轮66五篇长文补核查

小批次完整输出Elm/Haskell与Julia/Nim/OCaml，原省略部分已补；这些现为generic，D1专用能力未实现。

- Elm：Cmd/Sub遗失、decoder/JS ports真实shape、null/omission及stale响应；view读Model正常，不能复制“直接读field绕过update”或普通结构==需Debug比较说法。port lifecycle须JS订阅实际证据，compiler exhaustiveness不冒充runtime发现。
- Haskell：partial函数类型NonEmpty反证、lazy thunk/stream保留与严格求值改变termination、async exception的bracket/MVar清理、STM重试副作用、FFI lifetime。typeclass laws需要具体调用后果，orphan或API ADT偏好本身不是bug。
- Julia：axes/offset arrays、nothing/missing、dispatch歧义、shared捕获、ccall GC生命与显式shell边界。类型不稳定需hotpath规模证据；@assert不未经版本构建证据声称必禁用；method ambiguity不声称随机挑选。
- Nim：ARC vs ORC循环收集、openArray借用寿命、template重复求值副作用、variant discriminant、FFI convention及async blocking。managed ref不自动泄漏，check开关/版本必须实际捕获。
- OCaml：Array.make对象共享、mutable equality/alias、Option/Result partial、functor排序law、C stub GC rooting/blocking/版本Marshal、ReasonML JS null contract。noalloc只适用于不分配C调用，不能把缺noalloc泛称GC不安全；warn-error风格不单独bug。

剩13篇前批核查状态需补正文；A1相关依赖范围也未完成，不能先把功能任务标闭环。

## 轮67七篇完整补核查

完整小批输出default/C/C++/Java及JS/F#/Kotlin，前批省略状态解除；D1实现验收仍待。

- default：既有change因果/trigger/impact/反证更严格，maintainability/test覆盖偏好不是独立具体缺陷。
- C：malloc所有权可转移给caller，不能要求函数退出必free；free后置NULL不防别名UAF；strncpy/strncat需容量及终止实际证明，函数名替换不是安全证据。
- C++：RAII/allocator/dangling已有大类，原规则绝大部分STL/auto/const偏好不照搬；原有line-diff/anchor不因风格规则改变。
- Java：race需实际共享和线程入口，局部引用仍可能指向shared object，read-only publication也须happens-before；不能复制局部变量绝对安全或read-only绝对安全。NPE/performance已有检查仍需callee上下文。
- JS/TS：React hook顺序/依赖cleanup/render效果需专用具体验收，Promise.all可能超并发额度或改变顺序，var/any/==/inline样式禁令不照搬。
- F#：use作用域逃逸/seq多次副作用/OptionResult/取消传播/签名interop具体差距已确认，现generic非等价；这可作为D1首个小功能批。
- Kotlin：默认nullable值零可能掩盖required失败，GlobalScope不自动leak、catch Exception不能吞CancellationException，Sequence不单独性能改善；专用coroutine大类已有，按实际scope所有权反证。

剩6篇状态待补（Go/Python/Rust/ObjC/MATLAB/ArkTS），再限定跨目录依赖并按能力依赖推进。

## 轮68最后六篇补核查完成

Go前9500+尾段、Python前7000+尾段、Rust/ObjC与MATLAB/ArkTS完整直接输出；前批省略状态全部解除。54篇规则阅读完成，D1专用指导与场景验收仍未完成，阅读不等于功能闭环。

- Go：Once失败不重试、ctx transfer、Go版本timer与loop capture、发布与ownership反证，现guide部分对应，版本细化仍待。
- Python：assert外部输入在-O消失、literal identity、free-threaded/GIL实际运行前提；float相等可以合法、局部引用shared不自动safe、True == 1实际为true，不复制参考示例错误。
- Rust：expr片段自身完整解析 vs tt token级优先级，$crate hygienic caller、重复求值；clone/SeqCst/unsafe范围偏好不单独bug，FFI及await具体后果仍需caller。
- ObjC：ARC/MRC、CF Create/Get、NSError主返回、KVO/observer deployment、UTF8String借用转换buffer、NSNull/selectorABI、weak check-call同一strong local具体验收已定，现只大类。
- MATLAB：shape contract可能由arguments保证，integer饱和/nearest、复共轭转置、reduction维度及parfor order、onCleanup需具体验收；保持纯风格与未证版本compat不报。
- ArkTS：State变化必须绑定实际ArkUI版本，资源/lifecycle实体因果与信任边界；不复制push无效绝对论及硬编码/20项lazy禁令。

A1六核心目录与规则正文读取收口；相关审核链依赖需限定gitcmd/pathutil/model及session coverage状态行为，供应商SDK/平台持久resume/telemetry不纳实现目标。随后B1/B2/A2/A3/D1按验收实施，不再无限扩大源码表。

## B2权限待定

旧存在目标不存在的路径必属删除changed，autoContext不得恢复selected排除；被选删除已有old/new来源，不复制成伪独立context-old。需先明确旧侧显式授权及changed冲突协议，不能简单空目标正文。
