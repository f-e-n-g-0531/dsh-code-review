# 核心审查能力对照与执行任务

固定参考：alibaba/open-code-review@2d67596c961f80436deb2afa643efa2b1725d34c。2026-10-09重新梳理；不是全量核查完成声明。基线v0.28.0，七项已有实现但非全部对齐。总轮96为检查点非期限。

## 目标与边界

范围是读取变更、必要上下文、具体缺陷、反证和准确定位。保留宿主正常工具策略无重复审批；所有能力在批准快照/版本/哈希与共享预算内。不要管理平台、自动修复、独立模型费用或无界全仓扫描。模型效果试验后置，离线能力验收先行。

## 已读参考源码与行为对照

|参考源码（固定链接）|实际行为|当前对应/判定|任务|
|---|---|---|---|
|[grouping.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/grouping.go)|元数据分组、小变更本地决策、失败单文件回退、漏项补单文件、大小/输入预算拆分|business-groups/review已有严格身份覆盖与失败回退；4文件上限刻意保守；小变更免调用策略待核查|A2|
|[rulegroup.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/delegate/rulegroup.go)|按规则文本及source/pattern共同分组，避免混淆来源|显式项目规则统一发送，未支持路径规则来源分派；不盲目自动读取项目规则|D1|
|[file_find.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/file_find.go)|basename优先/full path回退；有界输出但列tracked/untracked或历史整树、可walk|新增find仅批准catalog大小写敏感字面路径，按来源侧返回；不复制全树/walk。捕获外定位仍缺|B0/B1|
|[file_read_diff.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/file_read_diff.go)|已解析diff map只读副本，按路径取变更|change-map/windows/catalog读源/interaction精确编辑已有，不需另开路径读取权限|A3复核|
|[tool_failure_streak.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/tool_failure_streak.go)|连续工具失败升级，第三次跳过并返回非错误提示|我们严格失败/partial及3轮限额；不照搬失败伪接受，需要核查是否值得受控修参|C2|
|[compression.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/compression.go)|会话分区压缩，冻结前文/保留最新轮，后台任务按会话隔离|我们有界3轮原文与输入预算，不压缩证据正文；长推理能力非等价，先核查必要性|C3|
|[code_search.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/code_search.go)|仓库/历史来源搜索工具|snapshot literal search+sourceIds筛选已实现；范围外caller发现缺|B1|

以上已读行为并非均要复制。更宽权限、不同组上限、自动压缩和失败伪接受应按安全边界明确替代，不强行照搬。

## 轮49新增核实与安全优先差距

已读[selection.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/selection.go)、[secret_path.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/secret_path.go)、[凭据路径模式](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/config/allowlist/default_secret_patterns.json)：参考secret门禁优先于include，不可恢复。当前此前无门禁，新增S1统一路径策略，覆盖changed两路径/历史/local context/rules/catalog；模板例外。282测试含显式选择、历史/工作context、rename旧凭据路径、模板与正文不泄漏。不是内容敏感信息扫描，不声称普通文件无秘密。

已读[comment_args_repair.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/comment_args_repair.go)：参考修serialized comments JSON转义且检查截断，非anchor relocation；我们strict JSON拒绝，无自动结构修复。纳入C2评估，不将该源码冒充已核对定位算法。

S1本批0.29.1实现冻结；A1其余agent/preview/loop/comment定位生产源码仍待。

## 轮50：预览源码复核与工作树基线元数据

已读[preview.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/preview.go)：preview共享selectFiles，provider目录排除仍计tracked变化总量，无LLM/session创建。当前coverage-plan与prepare共享输入已有；provider目录过滤/预览统计与agent主流程待A1进一步核查。

发现当前captureGit尚ls-tree -r全HEAD（历史已修），改最多200变化内可读基线路径分别literal非递归ls-tree，改名oldPath，排除/凭据不查询正文。大树11000无关文件>1MiB metadata工作区4Shader捕获/原new到working/稳定id/status不改回归通过，282测试。冻结0.29.2；不是解决autoContext全tracked索引，后者B1另行设计。

## 轮51：直接依赖索引探针与工具JSON参考

已读[tool_args_json.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/tool_args_json.go)：参考找首个平衡顶层JSON并由解析器验证，以恢复尾随控制文本；当前strict全响应JSON是明确安全替代，不默默丢弃第二结果。C2后续按必要性评估，核心loop.go仍未读。

Git自动context从捕获源码收集最多512直接候选，仅literal索引路径查询并重核同probe fingerprint；1MiB累计metadata/64KiB每probe，扩张目录记录拒绝，普通tracked有效性保持。11000大树auto import捕获+稳定hash、相关index变更/无关变更/目录/通配/空probe测试，283通过。SVN全索引暂未改；有界caller仍未完成。冻结0.30.0。

## 轮52：主循环与风险读覆盖

已读[loop.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/llmloop/loop.go)的Deps/Runner、RunMainTask/StopReason、grace round、executeToolCall、定位与压缩调度：task_done才完成，轮限/空轮/压缩/token分开；预算退出最后可交comments仍不标完成；comment优先同文件后跨文件再LLM，异步可WithoutCancel。当前strict JSON有界检索最终schema/共享calls超时/partial是安全替代，不跨文件猜anchor、不在预算外grace/后台发送。参考此退出诚实性发现风险sourceIds未读仍可无发现completed，新增sourceReadCoverage按生成阶段audit记录requested/read/unread；search/find不是读，计划/其他批读取不充当本批，未读产生partial限制。读片段不证明条件或因果、无新调用。285测试，冻结0.30.1。agent.go/templates具体多round/filter仍待A1，不能仅凭loop认定风险闭环对齐。

## 轮53：Agent计划失败回退

分段读[agent.go](https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/agent/agent.go)的入口/Run/dispatch、executeSubtask/Group、plan/main/filter/多轮confirmed及manifest：业务需求注入、按threshold计划、plan失败继续main、每轮filter和等待comment池、多轮移除plan避免覆盖天花板。对应我们风险/验证/coverage部分已有；business需求输入、独立review rounds与filter任务结构待核查templates/工具。resume持久平台及并发后台不照搬。确认plan异常会终止当前文件，改原输入回退保留fallback原因/partial；预算和取消仍硬阻断，不重试无效plan。287测试包含invalid主/交互计划、预算取消。冻结0.30.2。A1 agent.go不是全部功能已对齐，模板/定位源码仍待。

## 轮54：业务需求输入

依据已读agent.go buildMainTaskMessages/business_requirement注入，补工具preview可选businessRequirement最多16KiB UTF8，禁止空/控制字符，正文+hash/bytes预览，真实capture绑定snapshot id，execute原options重捕获。primary/windows/synthesis/interaction risk/main与verification均保留不可信constraint notice并计原预算，不授予权限/充当证据。289测试含identity/UTF8/payload/verify，冻结0.31.0。不自动抓取会话意图，不增加模型配置。模板/多轮与caller旧context仍待。

## 轮55：需求真实集成与报告溯源

业务需求真实Git working/HEAD历史捕获稳定id、文本变化id变化、真实service preview零发送/execute原预算初始输入一致。最终报告仅需求hash/bytes/untrusted状态，Markdown不重印正文，preview notice明确会发送需求。290测试通过，冻结0.31.1。此轮为业务需求验收闭环，不等同完整核心对齐。

## 轮56：核心逐文件清单

新增[逐文件清单](CORE-SOURCE-INVENTORY.md)，六核心目录及config子树本轮API枚举记录，每文件明确已读/未读，直接读estimate/identity/util/format并分类。跨目录依赖仍待补，不以读取冒充能力闭环。B2先明确删除changed与旧context显式授权，auto不得恢复selected排除。仅文档核查，不变运行包。

## 轮57：工具与定位11文件核查

[逐文件清单](CORE-SOURCE-INVENTORY.md)更新剩余7工具文件、pool.go、resolver/relocation/quotedpath三文件的真实行为/当前对应/刻意安全替代。工具宽松候选跳过、异步后处理失败零评论和LLM替换snippet不照搬；来源ID严格快照、同预算复核/失败显式、exact原snippet定位保持。仅文档核查，运行版仍0.31.1；A1配置/剩余diff/跨目录未完成。

## 轮58：剩余Diff五文件闭合读取

[逐文件清单](CORE-SOURCE-INVENTORY.md)记录hunk/parser/gitignore/workspace_file/git全部实际行为，对range merge-base/merge first-parent、自动untracked、失败跳过与插件exact端点/显式选择/blocked安全替代明确区分。Diff目录已读不代表总体完成；config模板规则及跨目录依赖仍未核查。仅文档核查不变运行版。

## 轮59：审查模板完整核查

[逐文件清单](CORE-SOURCE-INVENTORY.md)更新template/effort/task配置及12prompt，共15文件。确认默认2独立pass非retrieval轮/模型effort；plan50/group100与grouping4/200跳过策略A2、multi-pass A3明确待办。过滤默认approve和protected veto不等于反证确认，当前候选保留并标verdict是安全替代。配置其余规则/schema/full-scan分类仍待。仅文档，不变运行包。

## 轮60：剩余配置九文件

[逐文件清单](CORE-SOURCE-INVENTORY.md)记录allowlist/excludes/types、system规则分层及firstmatch、tool schema、testconnection、scan配置的实际行为。explicit规则vs自动global是权限替代，路径来源分派D1未完；tests/锁file不盲目隐藏，fullscan平台不在范围。生产配置已读不等于54规则正文已核查，语言指导仍未完成。仅文档核查运行包不变。

## 轮61：语言正文首批实质对照

[逐文件清单](CORE-SOURCE-INVENTORY.md)对12篇核心语言正文与现version4指引逐语言记录已对应/具体缺口/不照搬项。长文工具格式输出省略保守记核查中；剩余42篇未读。确认F#仍generic、Go版本timer反证、ObjC临时bytes/NSNull、MATLAB数值语义等具体差距，D1后续验收明确，不把风格禁令复制成缺陷。仅文档，运行版0.31.1不变。

## 轮62：协议配置15篇正文对照

[逐文件清单](CORE-SOURCE-INVENTORY.md)更新15篇完整正文已读及具体验收：GraphQL无tag、Capnp XOR/ordinal、Thrift methodname与required、Prisma provider/migration、Composer autoload/allowplugins。当前通用schema/manifest提示只部分对应，D1协议细分待办；不复制workflow缺permissions/timeout泛报与snapshot依赖禁令。27篇仍未读+首批12核查中。仅文档运行版不变。

## 轮63：模板与策略10篇正文

[逐文件清单](CORE-SOURCE-INVENTORY.md)细化10篇完整正文核查：自动escape反证、Pug attribute信任区别、Rego undefined与caller deny、Jsonnet lazy/merge/隐字段及Nix overlay/build输入。当前通用提示为部分，专用场景待D1，不照搬未见host即unsafe、缺optional安全项即bug或Jsonnet extVar绝对string。余17未读+首批12核查中，仅文档运行版不变。

## 轮64：剩余语言翻译11篇

[逐文件清单](CORE-SOURCE-INVENTORY.md)记录PHP/R/mapper/PO/POT实际专用验收及ArkTS版本反证，首组六长正文省略不声明闭环。剩6篇未读；须按小段补首批及本批长文，再补跨目录依赖。仅文档运行包不变。

## 轮65：最后六规则正文

[逐文件清单](CORE-SOURCE-INVENTORY.md)补Solidity/Vyper/Swift/Verilog/VHDL/Zig的完整正文与具体版本/链fork/目标综合反证，不照搬绝对proxy/brick/语法禁令。没有从未读取的rule条目，但此前18篇长文仍需补核查；当前多数generic非专用，D1未闭环。下一步补长文及限定相关依赖后进入能力实现；仅文档运行版不变。

## 轮66：五长文补核查

[逐文件清单](CORE-SOURCE-INVENTORY.md)用小批补齐Elm/Haskell/Julia/Nim/OCaml，专用场景与参考不可靠绝对表述单列。剩13篇此前正文状态需补，相关依赖未齐；仅文档，不称generic已具备专用能力。

## 轮67：七篇完整正文补核查

[逐文件清单](CORE-SOURCE-INVENTORY.md)解除default/C/C++/Java/JS/F#/Kotlin省略状态，列所有权转移/局部shared引用/coroutine取消/默认值契约等反证。剩6篇长文补齐后核查限定依赖；F#专用指引可作为D1首小批，generic不能冒充已实现。仅文档不变运行包。

## 轮68：语言长文读取收口

[逐文件清单](CORE-SOURCE-INVENTORY.md)解除Go/Python/Rust/ObjC/MATLAB/ArkTS最后省略状态，54规则阅读完成不等于D1验收。限定剩余审核链gitcmd/pathutil/model/session coverage行为，provider平台/telemetry不无限扩范围。随后功能缺口按任务实施。仅文档不变运行包。

## 轮69：限定审核链依赖

[逐文件清单](CORE-SOURCE-INVENTORY.md)新增gitcmd/pathutil/model六文件已读分类，session manifest前13000核查中；其余存储/resume/fullscan排除而不无限扩范围。匿名API403用既有Git凭据内存认证目录读取解决，不是blocker。下一步manifest后段后A1读取可收口并推进功能。仅文档运行包不变。

## 有依赖顺序的执行任务

- A1 **进行中**：逐文件读取agent.go/preview.go/selection.go、llmloop/loop.go、tool定义/read/comment/repair、config templates/rules与diff核心；记录函数、输入输出、失败/结束/反证行为与当前实现对应。验收：全部核心生产文件已分类，未读项单列，无泛称完成。
- B0 **本批实现**：批准catalog路径find导航；无正文/快照外权限，版本身份/hash/显式truncated，复用calls/output，整批预校验，loop审计。验收：2新增测试+全量280通过。
- B1 **待办（依赖A1）**：预览阶段有界caller定位捕获。限制路径/扫描字节/时间/文件/历史OID，候选与未覆盖可见，execute只原快照。验收：未改调用方接口回归、歧义、excluded、dirty/race、大仓小改、耗尽无假阴性。
- B2 **待办（依赖A1，独立于B1）**：旧侧独有context捕获/身份/证据/关系。验收：基线依赖目标不存在不伪造target正文；删除主文件保持独立changed身份；全部预算与hash稳定。
- B3 **待办（依赖B1策略）**：常见跨目录定义/别名/实例调用必要上下文，先窄语言场景，歧义保守。验收：确定导航与语义绑定分开，不猜未解析行为。
- A2 **待办（依赖A1）**：分组小变更免调用/预算拆分/失败回退与跨组关联遗漏对照，已有能力不重造。验收：原文件覆盖保持、调用下界正确、拆组限制显式。
- A3 **待办（依赖A1）**：风险需求→检索→生成→反证→退出条件逐项对照。验收：保护条件/不可达/旧问题/缺caller/预算终止不能误判无问题。
- C2/C3 **待评估（依赖A3）**：必要时受控修参/长输入策略；不伪接受失败，不丢失精确证据，不增加无限重试。
- D1 **待办（依赖A1）**：语言类型与路径规则指导全映射，来源透明，显式规则优先，风格/管理功能不在范围。
- E1 **待办（依赖上述关闭）**：场景能力矩阵验收；实际模型质量另列后置，不用离线280测试冒充效果证明。

## 每批门禁与完成条件

实现→目标测试/全量→差异复核→pack/隔离entry→提交推送tag→Ubuntu/Windows×22/24固定tag CI→一次dispatch Actions npm→同原tgz正式Release→字节/SHA512/SHA256核验。发布后停扩该批。

只有A1全量核心核查与范围内任务有实现/验收或充分的非目标依据，才关闭总体目标；轮限仅检查点。下一步继续A1而不是认为B0解决caller发现。
