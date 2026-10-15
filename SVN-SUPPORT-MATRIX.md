# SVN 审查支持矩阵与实施顺序

本矩阵按用户新的「全面支持 SVN」要求扩展目标。此前把 SVN 历史审查列为设计不支持，不再作为此任务的完成理由。支持状态须由实际测试确认，不以规划、发布数量或版本号代替验收。

## 不变的约束

- 不对用户工作副本执行 checkout/update/switch/merge/revert/cleanup/commit；集成测试在独立本地仓库和临时工作副本运行。
- 预览不发送源码，执行必须绑定同一预览、模型、工作目录与快照身份。
- 本地工作副本模式默认离线；新增远端历史读取必须显式选择并在预览中披露网络访问和来源。
- 历史来源固定仓库 UUID、规范 URL、peg revision、operative revision、节点路径与内容哈希；禁止把较新工作树当作历史正文。
- 文件/字节/上下文/精确探测/调用/超时预算继续共享。超限、不可解码、不可定位和权限失败明确保留未完成状态。

## 当前盘点（不是全部支持）

| 场景 | 当前证据/限制 | 实施批次 |
|---|---|---|
| 常规文件修改、普通新增、删除 | 已有 BASE/工作字节与属性捕获测试 | 维持并扩充组合验收 |
| 子目录属性变更 | 已有独立属性审查测试 | 第一批 |
| 根目录属性/mergeinfo | v0.58.1 已发布；独立复现后修复，指定三文件和默认预览均通过、0 模型发送、状态不变；456 项串行回归、宿主、隔离安装和四矩阵 CI 通过，原产物/npm/Release 116,254 字节逐字节一致及双哈希/清单/发布说明通过 | 第一批先发布此修复 |
| 复制/移动、copyfrom 及目录结构变更 | v0.59.0 已发布同仓库复制新增文件及文件移动的新增/删除独立覆盖：新增目标旧侧为空，copyfrom 只作来源信息，预览披露并冻结身份；离线与凭据来源拒绝测试通过。459 项串行回归、宿主、隔离安装、四矩阵 CI 通过；原产物/npm/Release 117,098 字节逐字节一致，双哈希/清单/冻结发布说明通过。v0.61.0 已发布同仓库目录复制后代展开与继承来源身份，目标旧侧为空且预览披露。465 项串行回归、宿主、隔离安装、四矩阵 CI 与原包/npm/Release 120,159 字节、双哈希/清单/冻结发布说明通过。复制替换仍未支持 | 第二批：明确旧侧来源和后代覆盖 |
| 普通新增/删除目录及后代 | v0.60.0 已发布：补齐默认 status 隐藏的删除后代，离线递归枚举与末尾清单复核；普通结构目录只在后代全选且可审查时开放，凭据/阻断子项导致目录覆盖不足。461 项串行回归、宿主、隔离安装与四矩阵 CI 通过；原产物/npm/Release 118,284 字节逐字节一致，双哈希/清单/冻结发布说明通过 | 第二批普通目录子批 |
| 替换、删除再新增、文件/目录类型变化 | 普通与复制替换分别用 SVN_REPLACEMENT/SVN_COPIED_REPLACEMENT 诊断；离线探测确认前者 BASE 无 pristine，后者可能返回复制来源，禁止伪造旧侧。已新增未接入采集的 candidate-only 完整 diff 重建组件及真实离线测试：匹配完整工作侧，拒绝片段、错侧、截断与超限。diff 仍不能独立证明旧节点/编码/旧属性，因此未提交工作副本真实双侧替换仍未支持，不能把辅助组件算作支持完成。v0.64.1 已发布已提交固定历史版本的同路径 deleted/added 合并，真实目标旧/新正文与属性通过测试；481 项串行回归、宿主、隔离安装、四矩阵 CI 与原包/npm/Release 128,279 字节、双哈希/清单/发布说明通过。v0.65.0 已发布已提交固定历史文件/目录类型替换：分侧 kind/正文/属性、预览披露和目录后代覆盖；482 项串行回归、宿主、隔离安装、四矩阵 CI 与原包/npm/Release 128,792 字节、双哈希/清单/发布说明通过。未提交替换仍拒绝 | 第二批：区分 BASE 旧节点与目标节点 |
| 缺失、文本/属性/树冲突、阻塞 | v0.60.1 已发布稳定状态诊断：SVN_MISSING_NODE/OBSTRUCTED_NODE/INCOMPLETE_NODE/TEXT_CONFLICT/PROPERTY_CONFLICT/TREE_CONFLICT 等，预览与报告透传 blockCode。463 项串行回归、宿主、隔离安装、四矩阵 CI 与原包/npm/Release 119,462 字节、双哈希/清单/发布说明通过。诊断不算真实双侧支持，仍需后续实现 | 第三批：明确状态诊断；不能合成不存在的工作侧或声称审核通过 |
| svn:keywords、svn:eol-style | v0.70.0 已发布标准关键字行保持映射，BASE收缩与cat --ignore-keywords核验、原正文及hash保留、预览披露与模型原行号证据通过；不以规范化正文代替证据或证明行为等价。自定义/固定宽度/未闭合展开仍阻断；504项串行全量回归、宿主/隔离安装、四矩阵CI通过；原包/npm/Release 137,678字节、双哈希/清单/发布说明核验通过。本地新增 EOL 元数据映射：保留原文/原hash与LF视图hash、CRLF/LF/CR计数，CRLF/LF行号identity，单CR明确不等同LF证据行号；预览与模型原文集成测试通过，已补充 UTF-16 字节/文本哈希区分、关键字组合、属性移除、非法样式明确失败与状态不变验证；专项3项、根目录预览/关键字/EOL组合7项、实际ASAR宿主及隔离安装通过，v0.71.0 已发布：507项串行全量回归与冻结版本65项SVN专项通过（0失败/跳过），四矩阵标签CI及发布CI通过，原始Actions/npm/Release 139,804字节逐字节一致，双哈希/清单/冻结发布说明核验通过。不以LF视图替换证据或证明行为等价 | 第三批：双侧可验证映射，保留原字节和定位 |
| svn:special/链接 | 当前阻断，不跟随链接取正文 | 第三批：如支持只审链接目标数据；不沿链接读取文件 |
| switched、externals、稀疏/混合 revision | 多数拒绝；调用方/依赖链要求祖先 normal | 第四批：明确仓库边界与独立来源，禁止隐式跨仓读取 |
| 固定 revision 单提交 | v0.62.0 已发布 svnRevision：r-1/r 固定对象、UUID/URL/peg/operative revision 逐侧绑定，正文不读工作树；远端显式 svnAllowNetwork。472 项串行回归、宿主、隔离安装、四矩阵 CI 及原包/npm/Release 125,486 字节、双哈希/清单/发布说明通过。历史上下文/规则/调用方已由下方 v0.63–0.69 行跟踪，不再沿用 v0.62 当时缺口 | 第五批：新增明确 SVN 参数与冻结身份 |
| 固定 revision 区间 | v0.62.0 已发布 svnBaseRevision/svnTargetRevision，固定树端点 summary+逐侧 cat/proplist，目录后代与属性纳入预算，不建临时工作树；同上述完整发布验证。历史上下文见下方 v0.63–0.69；分支间不同 URL 仍未支持 | 第五批：固定树端点与逐路径差异 |
| 分支复制、分支间比较、合并来源 | v0.66.0 已发布批准历史 mergeinfo 属性的来源路径/区间导航，保留非继承标记、有界不展开 revision、不读取分支源码；invalid/limited 明确且不裁剪。485 项串行回归、宿主、隔离安装、四矩阵 CI 与原包/npm/Release 129,866 字节、双哈希/清单/发布说明通过；v0.67.0 已发布工作副本 BASE/工作侧属性的同一有界导航及预览/报告披露；489 项串行回归、宿主、隔离安装、四矩阵 CI 与原包/npm/Release 130,866 字节、双哈希/清单/发布说明通过。有效继承 mergeinfo、跨 URL 比较、源码归属/合并提交覆盖仍未支持 | 第六批：URL/peg/operative revision 与 mergeinfo 导航披露 |
| 当前三层依赖与限定目录调用方 | v0.66.1 已发布根目录仅 mergeinfo 变化下的自动依赖/限定调用方修复：根目录不作源码候选，祖先双侧属性仅 mergeinfo 差异可通过且入指纹；其他属性/unsafe 状态仍拒绝。488 项串行回归、宿主、隔离安装、四矩阵 CI 与原包/npm/Release 130,642 字节、双哈希/清单/发布说明通过。其他祖先/混合状态继续待验证 | 第四批补祖先/混合状态组合 |
| 历史两侧上下文与调用方 | v0.63.0 已发布显式 contextPaths 固定双侧来源及目标 rulePaths，UUID/URL/peg/operative revision/原字节与正文 hash 验证，禁止脏工作树与排除项回流。477 项串行回归、宿主、隔离安装、四矩阵 CI 与原包/npm/Release 127,355 字节、双哈希/清单/发布说明通过。v0.64.0 已发布 oldContextPaths 旧侧独有正文、SVN 来源专用校验、预览披露与选中删除身份复用；479 项串行回归、宿主、隔离安装、四矩阵 CI 与原包/npm/Release 127,879 字节、双哈希/清单/发布说明通过；本地开发了注入固定版本 lookup/read 能力的三层历史依赖导航核心，逐侧共享512探测/20候选/1MiB来源与上下文名额；排除项、旧侧限定和规则隔离测试通过。v0.68.0 已发布三层逐侧历史 autoContext，固定父目录有界清单 lookup，清单成功证明缺失、访问失败直接传播，真实旧/新版本链和脏工作树隔离通过。496 项串行回归、宿主、隔离安装、四矩阵 CI 与原包/npm/Release 134,056 字节、双哈希/清单/发布说明通过；本地新增逐侧固定 revision 调用方核心能力接口：共享256索引/128扫描/1MiB正文/512侧探测，命中侧才捕获正文，规则/变更排除与old-only限制保留，同侧命名调用声明导航测试通过；本地已接入固定 SVN 显式目录递归清单/同侧正文、统一30秒/512命令/元数据/正文预算，caller 与依赖共享精确探测及来源上限，真实集成专项13项通过；v0.69.0 已发布历史限定调用方和autoContext组合；502项串行全量回归、组合模型输入隔离、宿主/隔离安装、四矩阵 CI 通过。原包/npm/Release 136,030 字节、双哈希/清单/发布说明通过；字面发现仍不证明完整调用覆盖 | 第六批：逐侧固定版本，不能回退至工作副本 |
| 真正 r7314→r7315 样本 | 用户未提供隔离副本路径；本地类似复现不是该样本验收 | 获得路径后只读生成预览，不自动发送模型 |

## 本地导航 EOL 与正常属性候选（v0.74.0 已发布）

冻结提交 `09241e046eaeff4f9c917102bc9dad97d91e81d9`；标签CI `38702380795`，唯一发布运行 `38703089522`，原工件 `11957397597`。原始Actions/npm/Release包144,494字节逐字节一致；SHA-256 `35946d5d536482cb8fd7061a9a291c030c49a564e9eeffacac82ecf206e37552`，SHA-512、清单及冻结正文核验通过。

- `svnCallerNode` 返回既有已验证属性中的EOL样式，依赖链/显式导航入口/命中调用方根据原文生成映射，预览只披露元数据；不新增命令或网络范围。
- 真实复现发现带已提交属性的调用方被索引 none-only 条件漏选；改为 none/normal，正文仍经既有关键字/special/externals/URL/祖先安全检查。modified/conflicted 等不放开。
- `test/svn-working-context-eol.test.mjs` 离线真实仓库组合通过：入口→依赖和限定调用方映射、非匹配正文不捕获、预览0发送、模型原文、status不变、快照稳定及属性变化拒绝。既有关键字拒绝7项依赖专项通过；511项串行全量回归与11项本地导航安全专项、实际宿主/隔离安装、四矩阵标签及发布CI通过，发布工件核验完成。
- 独立无autoContext的显式本地上下文未因本批新增属性映射；工作副本关键字上下文与其余矩阵缺口继续保留。

## 历史上下文 EOL（v0.73.0 已发布）

冻结提交 `b60bf8e743de844958781ea62203c6bf77ef6e79`；标签CI `38698580756`，唯一发布运行 `38699278843`，原工件 `11956340295`。原始Actions/npm/Release 143,452字节逐字节一致，SHA-256 `98a6f905ef5e48fc93ee124b8804d012dac2d3ee8119faf85f9ff275b0269afa`，SHA-512、清单及冻结发布正文核验通过。

- 固定历史 readSource 把EOL元数据绑定各侧source，显式/旧侧独有/自动依赖/命中调用方均保留；不新增读取命令或放大预算。
- 预览 contextSources 列出实际捕获来源，不显示正文；context-identity 校验映射与该侧原文一致，拒绝篡改。
- `test/svn-history-context-eol.test.mjs` 真实仓库复现通过：四类上下文组合、旧侧不回流、未匹配正文不捕获、脏工作树隔离、0预览发送、模型原文、status不变与快照稳定。510项串行全量回归、最终66项上下文/检索兼容与9项历史组合、实际宿主与隔离安装、四矩阵标签和发布CI通过，正式发布及工件核验完成。
- 工作副本关键字上下文、未提交替换、跨URL与有效继承mergeinfo等缺口仍未完成。

## 固定历史 EOL 与使用指南（v0.72.0 已发布）

冻结提交 `8dffa16889c43705467e9df9331cf1b221268ed8`；标签CI `38694984442`，唯一发布运行 `38695576665`，原工件 `11953659439`。原始Actions/npm/Release包142,623字节逐字节一致；SHA-256 `79ff57378a74ffc5e2799a70cc3e9e8b27490ea664607a6c52dc00e5f577769d`，SHA-512、校验清单及冻结发布说明核验通过。

- `src/svn-history.mjs` 对已有固定逐侧正文和属性计算 EOL 元数据，不新增 SVN 命令，不改变 UUID/URL/peg/operative revision 与原始字节哈希。
- 缺失侧与目录侧明确 null；真实 SVN 测试覆盖 CRLF→LF、CR、新增/删除、文件→目录替换、单revision/区间一致、脏工作树隔离、预览0发送、模型原文及status不变。
- `test/svn-history-eol.test.mjs` 与 EOL/历史替换组合7项通过；完整串行回归509项通过，历史导航/EOL/替换组合12项通过，实际宿主及隔离安装、四矩阵标签CI与发布CI通过，正式发布及工件核验完成。历史上下文 EOL 元数据仍未新增。
- README 重写为实际使用指南；`test/readme-usage.test.mjs` 验证 JSON 示例参数与真实工具定义一致，文档链接测试通过。

## 实现与复现入口索引

以下入口便于逐项复核，测试存在不等于所有状态已支持；发布验收仍以对应批次实跑结果为准。

| 矩阵项 | 源码入口 | 复现测试入口 |
|---|---|---|
| 常规文件、子目录属性、新增/删除目录 | `src/svn.mjs` | `test/svn.test.mjs` |
| 根目录属性预览 | `src/file-relations.mjs`、`src/service.mjs` | `test/svn-root-preview.test.mjs` |
| 文件/目录复制、移动来源 | `src/svn.mjs` 的 structuralEntries 与 copySource | `test/svn.test.mjs` 离线复制/移动及复制目录案例 |
| 未提交替换辅助重建（未接入） | `src/svn-state.mjs`、`src/svn-replacement-text.mjs` | `test/svn-replacement-text.test.mjs`、`test/svn-state.test.mjs` |
| 已提交同路径与类型替换 | `src/svn-history.mjs` 的 mergeSvnHistoryRecord 与逐侧 kind | `test/svn-history-replacement.test.mjs` |
| 缺失/冲突/阻塞诊断 | `src/svn-state.mjs` | `test/svn-state.test.mjs`；真实缺失在 `test/svn.test.mjs` |
| 标准关键字与换行 | `src/svn-keyword-mapping.mjs`、`src/svn-eol-mapping.mjs` | `test/svn-keyword-mapping.test.mjs`、`test/svn-eol-mapping.test.mjs` |
| switched/外部根的拒绝 | `src/svn-caller-safety.mjs`、`src/svn-caller-node.mjs` | `test/svn-caller-special-roots.test.mjs`、`test/svn-caller-index.test.mjs` |
| 固定单 revision/区间及身份 | `src/svn-history.mjs` | `test/svn-history.test.mjs` |
| 显式 mergeinfo 来源导航 | `src/svn-mergeinfo.mjs` | `test/svn-mergeinfo.test.mjs` |
| 本地依赖/调用方及 mergeinfo 祖先 | `src/svn-dependency-chain.mjs`、`src/svn-caller-capture.mjs` | `test/svn-dependency-chain.test.mjs`、`test/svn-caller-capture.test.mjs`、`test/svn-mergeinfo-ancestor.test.mjs` |
| 历史两侧上下文/依赖/调用方 | `src/svn-history.mjs`、`src/svn-history-dependencies.mjs`、`src/svn-history-callers.mjs` | `test/svn-history.test.mjs`、`test/svn-history-dependencies.test.mjs`、`test/svn-history-callers-integration.test.mjs` |
| special、稀疏/混合状态、有效继承 mergeinfo、跨 URL | 上表限制仍有效 | 尚无完整支持验收，不能由其他案例推断完成 |

## EOL 子批验收索引（v0.71.0 已发布）

冻结提交 `9e9ffc8db9c9467a54366c17b6d6a6449524e795`；标签CI运行 `38690842208`，唯一发布运行 `38691445215`，原始工件 `11952831232`。包139,804字节；SHA-256 `2e99d5c73ef194be0dc542d19b5a69bfc850e548a1347f6d5ef6aec124ec0f96`。原始Actions包、npm、Release逐字节一致，SHA-512、SHA256SUMS及冻结发布正文通过。此验证不代表自动升级当前宿主或完整SVN支持。

| 项目 | 实现/复现证据 | 当前结论 |
|---|---|---|
| CRLF/LF/CR 与混合计数、视图哈希 | `src/svn-eol-mapping.mjs`；`test/svn-eol-mapping.test.mjs` 前两项 | 专项通过；原文/原字节哈希不替换；单 CR 不保证 LF 行映射 |
| 编码身份 | 同上 UTF-16 BOM 案例 | 文本 hash 与 source bytes hash 明确区分，不能互换 |
| 预览/模型输入及只读 | `src/svn.mjs`、`src/service.mjs`；真实 SVN EOL 集成案例 | 预览不发送；受控模型读取原文；文件与解析后 status 不变 |
| 组合与失败 | 同一集成案例中标准关键字+CRLF、移除属性、强制非法样式 | 组合通过；非法样式被 SVN 在 status 阶段拒绝，采集明确失败 |
| 根目录优先修复持续回归 | `test/svn-root-preview.test.mjs` 默认/指定三文件预览 | 本批重新实跑通过，0模型发送，状态不变；原 v0.58.1 交付不重发 |
| 历史、上下文、特殊状态 | 不在本子批新增范围 | 仍按上表未完成项推进，不由元数据功能推断支持 |

## 每批发布门禁

1. 独立测试副本复现，确认 capture→关系推断→预览→执行的覆盖和拒绝路径。
2. 专项、全量串行回归、实际宿主、隔离安装通过。
3. 提交/推送/冻结版本标签；四矩阵 CI 通过后唯一 Actions 发布。
4. 保存原始 Actions 产物，核验 npm/Release 逐字节、SHA-256、SHA-512、清单与冻结发布说明。
5. 写入该批验证结论；更新本矩阵，剩余项继续保留未完成。

## 收尾标准

每行均有明确支持模式、失败处理、源码位置和测试证据。诊断未完成不等于场景已经可审查；任何保守拒绝须单列原因，不能把拒绝范围自动从目标中删除。真实模型质量另行评测，不由采集/发布测试推断。
