# SVN 支持范围与验收依据

本页区分可以审查的模式、需要额外授权的读取，以及只能诊断的状态。预览成功不等于审查完成；测试存在、版本数量或发布成功均不证明任意SVN状态可审查。日常操作先看 [README](README.md)。

## 不变的约束

- 不对用户工作副本执行 checkout/update/switch/merge/revert/cleanup/commit；集成测试在独立本地仓库和临时工作副本运行。
- 预览不发送源码，执行必须绑定同一预览、模型、工作目录与快照身份。
- 本地工作副本模式默认离线；新增远端历史读取必须显式选择并在预览中披露网络访问和来源。
- 历史来源固定仓库 UUID、规范 URL、peg revision、operative revision、节点路径与内容哈希；禁止把较新工作树当作历史正文。
- 文件/字节/上下文/精确探测/调用/超时预算继续共享。超限、不可解码、不可定位和权限失败明确保留未完成状态。

## 版本与验收状态

冻结提交 `eb4b4ee10c9b4264d561287af7de9e0671945919`；最终四矩阵标签CI `38756170907` 全部成功，唯一发布运行 `38757421980`，原工件 `11984565729`。Actions原包/npm/Release包167,327字节逐字节一致；SHA-256 `12e43c2d562d0c811e4f98ae25829a17f52715e662885a45fef46fd3eec3e3a3`，SHA-512、清单、冻结发布正文核验通过。发布任务实际只运行release，复用前述同提交四矩阵证据；release耗时2分39秒。v0.80.0因Ubuntu原生链接测试夹具commit失败未发布，Windows两组通过，原标签保留未移动；修正原生Unix符号链接夹具后v0.80.1四矩阵通过。

历史v0.80.1的冻结提交已通过四矩阵及工件核验，但随后代码审查发现替换树祖先授权和多行关键字两项缺陷。当前v0.80.2集中修复这两项；相关回归已通过，完整回归与正式发布尚在验收中。下表描述支持模式和边界，不把历史测试数用作安全承诺。

| 能力 | 本地集中验收证据 | 边界与未证明事项 |
|---|---|---|
| CI证据复用 | 拒绝错仓库/提交/标签/attempt、缺组/重复/失败/缺npm test步骤；真实旧运行API校验通过 | 首次新流程已端到端通过；同冻结提交四矩阵证据校验后仅release运行，原包核验保持 |
| 固定宽度/复合关键字 | 真实SVN固定字段及复合格式BASE收缩核验通过，原文/行号保留 | 原生%_表示空格；引号属性未按预期展开，明确拒绝，不模拟shell。未知格式/不完整展开拒绝 |
| 历史链接记录 | 真实special→普通文件转换、仓库原记录、目标内容隔离通过 | 仅link记录，不跟随目标；特殊侧不能当源码上下文 |
| 本地链接记录 | 原生符号链接readlink、普通link记录、目标文件不读取通过 | 当前主机及最终Windows/Ubuntu四矩阵均通过。链接权限失败不能跳过算支持 |
| 有效继承mergeinfo | 最近显式祖先、空属性、不可继承*、历史逐侧及工作BASE/工作侧复现通过 | 边界外未知、混合BASE、不安全祖先返回unknown；无合并归属/提交覆盖推断 |
| 跨URL固定历史 | 同revision不同分支真实复现、上下文来源与侧缓存隔离通过；summary顺序误报已修复，历史组合11/11通过 | 同仓库根相对端点；跨仓库/重叠嵌套根拒绝，分支来源不构成merge归属 |
| 全采集预算 | 命令/元数据/取消边界及导航超限组合通过；统一全项目545/545通过 | 额外采集与末尾复核共享原上限，超限直接失败，不保证任意规模可审查 |
| 稀疏/混合revision | depth身份披露、真实--depth files checkout及混合BASE不同旧正文集成用例通过；原结构目录回归通过 | 不声称稀疏全树覆盖，非完整结构目录明确诊断，缺项不等于删除 |
| 独立历史基线替换树（祖先修复需v0.80.2） | 文件/目录类型、复制替换目标旧正文、old-only/new-only后代及父项独选阻断真实复现通过 | 用户显式基线不证明等于原丢失BASE；需独立远端授权；每个后代独立批准 |
| URL来源身份 | 编码分隔符/凭据/控制字符拒绝与合法转义等价用例、普通复制/中文路径回归通过 | 最终四矩阵通过；不允许任意URL或隐式跨仓库 |
| 不可恢复或未独立授权状态 | missing/冲突/阻塞/incomplete/switched/externals分类、拒绝来源回流已有回归 | 仅诊断不是可审查支持；不自动修复、更新、跟随externals或选择替代来源 |

新增能力的复现测试和实际运行记录属于机制验收，不代表已覆盖所有属性、平台和状态组合。v0.80.2回归特别检查：不安全祖先下的子项不得读取正文；安全但未选择的父项不影响独立子项；祖先属性变化进入快照身份；LF/CRLF关键字和XML数字引用正确处理。


## 使用时的拒绝条件

上表是当前版本结论；下文旧版验收仅为历史记录，不能作为当前缺口重复计数。

| 请求项 | 当前模式 | 结论 |
|---|---|---|
| 工作副本状态/目录属性 | 正常变更、属性、结构后代；冲突/缺失/阻塞/incomplete明确诊断 | 正常模式可审查；不可确认目标绝不视为通过 |
| 复制/移动 | 空目标旧侧+copyfrom来源披露，新增/删除独立覆盖 | 不把来源信息当旧目标正文，不宣称语义重命名 |
| 未提交替换/类型变化 | 显式固定目标URL基线及逐后代树比较 | 需用户批准；无法证明原丢失BASE，默认本地不可恢复状态拒绝 |
| 关键字/换行 | 标准/固定宽度/原生复合格式，BASE核验、原文/hash/行号 | 引号/未知格式明确拒绝；不把收缩当行为等价 |
| 链接 | 本地readlink/普通记录/固定历史记录 | 仅审目标字符串，不跟随，不转为源码导航 |
| 固定revision单提交/区间 | 逐侧UUID/URL/peg/operative revision固定 | 不读取脏工作树替代历史 |
| 分支与合并来源 | 同仓库不同URL固定侧、有效继承mergeinfo | 不推断merge归属或完整提交覆盖；未知边界明确unknown |
| 同版本上下文/依赖/调用方 | 显式/old-only/三层依赖/限定目录字面发现 | 同侧来源，不回退另一版本；非完整语义调用图 |
| 稀疏/混合revision | 正常可用节点分别BASE，明确稀疏及非完整清单 | 真实稀疏checkout/混合BASE复现通过；不推断缺项删除或全树覆盖 |
| switched/externals | 独立仓库根或固定分支端点 | 不自动跟随，不隐式跨仓库；未授权仍阻断 |
| 用户真实r7314→r7315副本 | 未提供隔离路径 | 无法进行该私有样本验收；通用本地复现不冒充该样本成功 |


## 历史证据

旧版本哈希与当时的限制单独保存在 [历史发布证据](SVN-RELEASE-EVIDENCE.md)。已发布事实不改写；发现的新问题以当前补丁说明为准，不把过去测试通过说成不存在缺陷。


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
| 链接记录/稀疏混合/有效继承/跨分支 | `src/svn-special.mjs`、`src/svn-working-scope.mjs`、`src/svn-effective-mergeinfo.mjs`、`src/svn-history.mjs` | `test/svn-special-history.test.mjs`、`test/svn-real-working-scope.test.mjs`、`test/svn-working-effective-mergeinfo.test.mjs`、`test/svn-cross-branches.test.mjs`；边界见上表 |
| 替换祖先安全与多行关键字修复 | `src/svn-replacement-tree.mjs`、`src/svn-keyword-config.mjs`、`src/svn.mjs` | `test/svn-review-fixes.test.mjs` |


## 每批发布门禁

1. 独立测试副本复现，确认 capture→关系推断→预览→执行的覆盖和拒绝路径。
2. 专项、全量串行回归、实际宿主、隔离安装通过。
3. 提交/推送/冻结版本标签；四矩阵 CI 通过后唯一 Actions 发布。
4. 保存原始 Actions 产物，核验 npm/Release 逐字节、SHA-256、SHA-512、清单与冻结发布说明。
5. 写入该批验证结论；更新本矩阵，剩余项继续保留未完成。

## 收尾标准

每行均有明确支持模式、失败处理、源码位置和测试证据。诊断未完成不等于场景已经可审查；任何保守拒绝须单列原因，不能把拒绝范围自动从目标中删除。真实模型质量另行评测，不由采集/发布测试推断。
