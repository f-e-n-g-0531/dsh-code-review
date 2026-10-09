# v0.33.0 发布门禁记录

状态：轮103正式发布门禁闭环。原发布运行37905053267 completed/success，npm/registry校验/正式Release全部成功，无需恢复或重复发布。实际npm与Release均87754字节，与原Actions工件逐字节相同，SHA512/SHA256及Release校验清单匹配。本显式旧侧首批停止扩展，不等价总体完成。

原Actions artifact11603897802，release-v0.33.0-37905053267，下载解包D:/TEMP/dsh-release-0330-D0bcyJ/original。tarball87754字节，SHA256 fc0d99bebd62e431fdd212d83f51af5ea6e8b00ae6510210ea480b816c72064f；SHA512 integrity sha512-OE81b9ZfHK+Smj/mTKeSiEN3xoZl1ldREKpC5F7dRBSk+grHla/ylt+rbEpwlU/4GEzfaZyNp1prov8OvAiC5g==。待实际npm/Release字节核验，不使用本地重打包替代。

- 冻结提交6fe4261fb7e2bd1b645b8637ba9f82840a760c83，固定标签v0.33.0。
- 本地311/311、差异检查、pack/隔离entry、离线真实DSH ToolRuntime smoke通过。
- 标签CI37904841884 completed/success；Ubuntu/Windows×Node22/24四矩阵success。
- 已唯一dispatch publish:true，运行37905053267 in_progress，同冻结sha；禁止重复dispatch/npm publish。
- 后续收集该run原Actions artifact并验证npm实际metadata/integrity/tarball bytes与原工件一致，再下载正式Release作85750等历史字节不可套用的实际测量与SHA512/SHA256核验。不得用本地包代替Actions原工件。
- npm处理延迟可能使bounded registry验证404，若发生先收集日志/原artifact，禁止重新发布同版本；仅当实际registry原字节匹配后允许同工件Release恢复。
- B2首批显式baseline捕获不含自动旧侧依赖扩展，不证明target不存在；语义caller/定义/调度反证等总体任务仍未闭环。发布前不得标总体complete。
