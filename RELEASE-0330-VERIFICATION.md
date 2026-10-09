# v0.33.0 发布门禁记录

状态：轮100进行中，不是正式发布完成声明。

- 冻结提交6fe4261fb7e2bd1b645b8637ba9f82840a760c83，固定标签v0.33.0。
- 本地311/311、差异检查、pack/隔离entry、离线真实DSH ToolRuntime smoke通过。
- 标签CI37904841884 completed/success；Ubuntu/Windows×Node22/24四矩阵success。
- 已唯一dispatch publish:true，运行37905053267 in_progress，同冻结sha；禁止重复dispatch/npm publish。
- 后续收集该run原Actions artifact并验证npm实际metadata/integrity/tarball bytes与原工件一致，再下载正式Release作85750等历史字节不可套用的实际测量与SHA512/SHA256核验。不得用本地包代替Actions原工件。
- npm处理延迟可能使bounded registry验证404，若发生先收集日志/原artifact，禁止重新发布同版本；仅当实际registry原字节匹配后允许同工件Release恢复。
- B2首批显式baseline捕获不含自动旧侧依赖扩展，不证明target不存在；语义caller/定义/调度反证等总体任务仍未闭环。发布前不得标总体complete。
