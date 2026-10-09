# B1：预览阶段有界引用方捕获契约

状态：轮71设计冻结，尚未接入运行功能。固定参考2d67596c961f80436deb2afa643efa2b1725d34c；不宣称调用者完整覆盖。

## 首批授权界面

拟新增可选callerScopePaths：最多4个互不包含的非根仓库相对目录。无参数时不扫描，不由模型推导扩大范围。名称经过relativePath和凭据路径门禁；不接受空、点、通配符或仓库根。Git working首批；Git历史和SVN显式拒绝该选项，而不是悄悄忽略。后续历史实现必须object-only并绑定target OID。

预览提示必须说明会读取范围内候选正文以定位引用方，即使非匹配正文不会发送模型。读取来自普通tracked文件，未跟踪/链接/submodule/冲突/所选排除变化/rulePaths/凭据路径不读。普通文件仍可能含秘密，路径门禁不是内容保证。目录参数授予有限发现权限，不赋予任意模型检索权限。

## 硬预算与完整性

- Git每scope单次literal ls-files --stage -z -- scope；所有结果验证仍在scope内，最多256路径、64KiB元数据累计。不得读取全仓索引或递归walk，也不得路径通配展开。超过输出或数量直接失败，不能返回静默截断成功。
- 顺序候选读取，最多128个JS/TS/C-family文件、每文件至多256KiB、扫描累计1MiB、总deadline30s，复核读取同样累计预算单列上限2MiB。超时/取消硬阻断，超数量/字节以显式incomplete结果或拒绝预览，不标完整。真正实现可采用更小限额，不放宽既有总快照4MiB/上下文20文件预算。
- 元数据first/last fingerprint相同；扫描过的正文包括非匹配文件都需二次hash核对，避免负匹配改变未被发现。execute重复全部发现流程，snapshot身份绑定scope、扫描所有hash、候选、遗漏原因，而非仅匹配正文。
- dirty tracked文件可以用批准working正文，不强行宣称与index blob相同；读取前后race由readLocal及hash复核拒绝。历史实现另列不能复用working。

## 导航语义

首批反向复用contextCandidates的保守literal-relative-import/include解析，目标仅指向批准reviewable主文件。解析时changed排除集合必须包含全部主文件/oldPath，引用方不作为伪主文件进入分母。JS无扩展解析的所有竞争路径需要literal探针（含目录记录），唯一可匹配才返回；不能只在selected路径中查找，否则dep.ts/dep.js竞争会假唯一。C include仅同源相对literal，条件宏/复杂注释/rawstring一律不确定。

返回confidence:navigation-only、fromPath、targetPath、reason；模块引用不证明函数调用、调用可达、符号绑定或参数流。不把包含词串的注释/字符串当调用。不能宣称无候选代表没有caller。只将成功捕获的全文纳入普通context来源，既有catalog/hash/read证据复用。

## 截断与预算共享

已选主文件、rulePaths、显式context优先；自动依赖与caller共享剩余20 context名额，稳定字典序，候选未捕获必须标blocked及原因。callerDiscovery包含scope、scannedPaths与hash、scannedBytes、candidatePaths、capturedPaths、incomplete/limitations。报告或审查指令必须展示navigation-only及不完整，不能仅在preview可见。不增加模型calls上限，不增独立审批或模型配置。

## 离线验收与下一批

1. 真实Git接口改动，未改相对import引用方被捕获；capture/preview零模型发送，execute只重捕获内容。
2. scope外/untracked/secret/link/submodule/conflict/排除主文件/rule不读，basename歧义与竞争目录不假匹配。
3. 非匹配文件内容变化导致snapshot变化；新增/删除索引项导致发现身份变化；二次读取变化拒绝。
4. 11000范围外文件不影响小scope；scope内部枚举上限显式失败，无full index。
5. 总字节/文件数/20context/4MiB、取消/超时、historical/SVN不支持边界可测试。
6. 生成与复核沿既有context来源获取准确位置，不把引用识别作为缺陷证据，不证明真实模型审查效果。

实现顺序：窄scope索引和纯导航测试→working捕获race/预算→service/schema/preview/report→全量测试与差异复核→新版本发布四矩阵/同工件双hash门禁。当前只完成接口和安全设计，不标B1已实现。
