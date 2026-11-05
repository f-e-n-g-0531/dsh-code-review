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

## 真实模型观察

已有六次小规模观察见 [试跑结果](PILOT-RESULTS.md)。其中一次证据复核未完成，其他结果也不能外推成质量指标。新评测仍后置，开始条件见 [运行条件](PILOT-GATE.md)。

运行真实评测时，只提供单组源码和必要契约，不发送答案说明、测试断言或其他组实现。保留原始输出，并由人工分别裁决候选生成和复核。
