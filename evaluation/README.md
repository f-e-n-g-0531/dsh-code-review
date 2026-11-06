# 评测说明

这个目录用于复现已知行为、检查模型输入和整理少量历史试跑观察。样本和结果目录不进入npm安装包；实验入口说明 REVIEWBENCH-LOCAL.md 随包提供。它们不是当前版本的质量承诺。

## 样本

- [资源生命周期](lifecycle/README.md)：异常后是否释放资源，有缺陷输入和保留保护的对照。
- [请求乱序](stale-result/README.md)：旧请求晚完成是否覆盖最新选择。
- [历史规则检查](history-rule-extension/README.md)：本项目曾经错误接受不合法文件后缀的真实模块级复现。

样本测试通过表示“预期行为已被复现”，包括缺陷行为；不表示模型已经找到缺陷或样本已经修复。

## 离线运行

	node --test test/evaluation-*.test.mjs
	node evaluation/preview.mjs

第二条命令只读取固定合成输入，校验内容指纹并计算初始输入大小，不调用模型。输出不含源码或答案标签；它也不是宿主执行授权。

## 真实事件评测合同

[incident-eval.mjs](incident-eval.mjs)校验并评估外部注入的完整实际report与专家裁决，[schema](incidents.schema.json)定义固定快照／版本／模型身份、预注册全部runIds和confirmed/unadjudicated。confirmed中的reviewer与judgementRef是外部裁决声明，不是加密签名；评测器不自动确认专家身份或从模型判定推导金标。候选裁决必须绑定report精确JSON SHA256与索引。缺失、失败和partial保留所有预注册分母；未裁决或无金标时precision/recall为null，不以0冒充无缺陷。误报、有害建议、已处置与未完成分别统计。

运行`node --test test/incident-eval.test.mjs`仅验证记账合同，不是业务成绩。真实业务素材、答案和原始会话保持仓库外，不进入安装包；模型输入不包含金标。当前r7364归档只验证旧调用和状态观察，缺完整report JSON与专家裁决，因此不宣称实际召回率或新版改进。任何prompt／工具／模型变化应重新运行同一组全部案例，不选最佳一次。可由现有registered-tool live runner保存新鲜预览和终态回执，再人工独立裁决；不直连provider、不自动读取私有模型工件。

## 自主官方SDK回归（开发中，尚未业务验收通过）

仓库提供[唯一发送驱动](../scripts/autonomous-review-sdk.mjs)与[工程结果收集器](../scripts/collect-review-acceptance.mjs)。驱动只通过官方SDK stdio JSON-RPC初始化真实Agent并提交一次任务，不构造exec、不直接请求provider。独立profile须事先通过官方管理器安装冻结候选及同包child入口、配置批准模型的凭据引用与完整预设服务；不得复制明文凭据、改运行中的desktop配置或把缺少registry的SDK环境当产品故障。profile/session canonical永久锁阻止换输出目录重复发送，发送意图持久化后不自动重试；进程中断必须保留，不删除锁假装未运行。

驱动配置放仓库外，包含executable、sdkEntry、独立profile/profileDir、overlay、cwd、固定route、唯一sessionId、promptFile、outputDir、candidatePath、candidateSha256和timeoutMs。运行 `node scripts/autonomous-review-sdk.mjs <绝对配置路径>` 会产生真实模型费用；只能在当前用户明确授权的范围和次数内执行。不要用该命令单独通过进程退出码判断审核通过。SDK外层协调Agent调用与插件内部review调用分列记账。

维护方可用[单命令回归入口](../scripts/run-review-regression.mjs)：`node scripts/run-review-regression.mjs --config <仓库外配置>`，配置为driverConfig绝对路径、全新acceptanceOutputDir和expected。它先校验固定身份、候选哈希及输出位置，只运行一次官方driver，之后自动查找精确归属的公开执行报告并判分；多报告拒绝择优，预览失败和driver中断不丢弃、不自动重试。该入口已用于保存真实插件运行的完整报告及失败判分；自动执行或收集完成不等于业务验收通过。

也可分步用 `node scripts/collect-review-acceptance.mjs --config <仓库外配置>` 读取官方公开job JSON（非私有artifacts），配置jobFile、全新outputDir及expected固定身份与门槛。它保存完整报告、简报、技术报告与机器工程判分，拒绝覆盖旧证据。工程收集退出0表示该run的已声明工程门槛通过；退出1表示failed/incomplete；退出2是收集被拒或异常。缺失全管线检索错误遥测保持unknown，不能用parser局部零计数冒充全链路无错误。

当前c719真实回归已由维护方自主运行并保留全部尝试：早期候选13/73主审完成；补审修复后达到73/73主审完成、0文件待审或失败、1预声明阻断，未再次观测收据fatal，但独立复核仍曾触发轮数限制，整体未通过交付验收。后续真实盲审已能独立检出“被拒绝请求提前修改在途状态”的精确候选；再经证据数量协议修复后，候选及独立复核阶段均完成，没有再次记录该协议失败，但最终判定仍为uncertain，尚未达到用户要求的结论质量对齐。该轮围绕空名触发且缺宏定义／下游语义。后续逐行复核纠正了维护方曾作出的“非空无映射分支可绕过未知宏”的判断：配置查询返回false后，协调器仍经过未捕获定义的宏；不能把该分支当作已证明的正常拒绝路径。之后新增默认关闭的显式模型跨文件比较通道：宿主校验批准引用、完整文本角色范围和候选编辑，关系仍由模型判断并单列披露，不冒充宿主因果证明。该通道首次真实验证被角色引用校验拒绝；离线复现修复了辅助反证必须全部分配为角色的额外限制，补丁真实验证取得有效uncertain、没有再次记录该协议错误。新增分支导航后的真实验证已同时核对空名和非空无映射分支，并明确指出两者均有未知宏控制流；维护方因此撤回先前完整P2静态路径已确认的断言，保留有证据的顺序差异与条件性风险，不以旧模型结论作为验收金标。全部历史失败保留，不把新标记、专项或完整回归通过当作质量验收通过。用户原归档的无插件基线为一次人类请求、一个根对话，约7分12秒完成并报告两项P2主张，内部可自行派生子Agent；会话数、请求数、生成次数必须分开。后建的受限工具／单Agent加续审控制实验不能代表该原始使用方式，其提速比较已撤回。对原主张逐项核查，不直接把任何模型报告当专家金标。本次归档、原始业务源码、provider配置、凭据与运行结果均不进入仓库或npm包。

## 真实模型观察

已有六次小规模观察见 [试跑结果](PILOT-RESULTS.md)。其中一次证据复核未完成，其他结果也不能外推成质量指标。新评测仍后置，开始条件见 [运行条件](PILOT-GATE.md)。

运行真实评测时，只提供单组源码和必要契约，不发送答案说明、测试断言或其他组实现。保留原始输出，并由人工分别裁决候选生成和复核。
