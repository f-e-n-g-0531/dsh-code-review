# 真实模型小规模试跑

## 生命周期负例（第132轮）
- 同一当前DSH模型，经新预览和宿主审批，仅发送before→guarded差异与同一契约。
- 初始输入3797字节，1次模型调用，1/1完成，findings为空、limitations为空、outdated=false。无候选故未发起复核调用。
- 本次未对保持finally保护的变更误报；不说明其他场景无误报。结构化报告：pilot-lifecycle-control-result.json。
- 原样本恢复，真值与哈希3/3通过，git diff确认该样本无残留修改。

## 生命周期正例（首次）
- 通过实际code_review_preview/execute和宿主审批运行，模型com-gpt/gpt-6-astra。
- 将固定before临时替换为after，仅选该路径与contract.txt；运行结束已恢复，基准真值及哈希3/3通过。
- 初始输入3770字节，报告modelCalls=3，覆盖1/1完成，无报告限制或过期标记。
- 检出1条high：work抛错或拒绝时跳过close；新侧3–4行，模型复核supported，引用校验通过。与可执行真值测试一致。
- 结构化报告：pilot-lifecycle-result.json。它是服务处理后的报告，不是逐次原始模型流；不含费用/耗时测量。
- 只证明本次合成正例命中；非盲测，路径含lifecycle、契约明确释放要求。对应负例见下文；两个样本不能推算整体召回或误报率，也不是人工独立裁决。

恢复测试首次因Windows沙箱子进程管道spawn EPERM未能启动，改同进程--test-isolation=none后3/3通过；非产品测试断言失败。
