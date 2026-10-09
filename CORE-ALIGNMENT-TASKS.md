# 核心审查对齐结论

固定参考：alibaba/open-code-review@2d67596c961f80436deb2afa643efa2b1725d34c。总体尚未完成；源码分类清单见[CORE-SOURCE-INVENTORY.md](CORE-SOURCE-INVENTORY.md)。

## 已交付

- Git/SVN只读变更快照、精确位置与编辑归因、证据凭据验证、候选反证与保守报告归组。
- 风险假设规划、业务分组及失败回退、hunk有界输入、明确pending/partial覆盖、显式规则与业务需求快照绑定。
- Git历史commit/range固定对象端点；不checkout/fetch，不混入工作树。
- 批准catalog内find/search/read及sourceIds筛选，定义同名歧义保留；文本导航不证明符号绑定。
- v0.32.0有界working Git引用方捕获：指定目录、普通tracked文件、负匹配hash复核、共享预算；历史/SVN及语义caller未实现。
- v0.33.0显式oldContextPaths：baseline普通blob/OID/hash，唯一context-old身份、消费者按侧使用；不证明target不存在，不恢复excluded变化。

## 未完成

1. B1：历史/SVN调用方发现与必要语义caller场景。
2. B2：自动旧侧独有依赖捕获；显式首批已交付。
3. B3：必要未捕获定义、别名链及实例上下文；现有search/read边界已验收。
4. A2：小变更免规划、预算拆分、分组失败及跨组遗漏场景闭环。
5. A3：guard/不可达/原有缺陷/缺caller/预算退出、typed失败、选择分母与空排除场景；真实模型质量后置。
6. D1：必要语言专用缺陷及路径规则分派；具体差距见源码清单。
7. E1：上述能力场景矩阵及端到端验收。

C2受控畸形输出处理、C3长输入仅具体场景证明确有必要才补；严格失败、原文证据保留为安全替代，不新增无限重试/宽松接受。

## 验收结论

- 当前离线326/326及真实宿主离线smoke通过；不等价真实模型质量。分组失败选择分母/单文件跳过/预算耗尽、跨组遗漏、混合执行失败、取消和报告安全转义已验收。
- 执行可靠性优先：0.33.2唯一完整JSON围栏兼容，固定CI37907541130通过、唯一发布37907836315已成功，原artifact11605097563，npm/Release88609字节与原工件一致，SHA256 13e40a77c97bb57014d2dd165f0f946ccb921a8d34b8b18530adadae37695887，SHA512 sha512-mI+dhtizlM+2HVyo+WRg3t8HyWUd6M6/ifV6nvuxj7bFaJ0jfeUTGPngan4zJRHf4jVzQK7aXnIMki//ZzaDgg==；0.33.3窗口上下文按批准catalog检索已正式交付：标签CI37908368137通过、唯一发布37908776363；原artifact11605287853，npm/Release88999字节一致，SHA256 aad891b8cab6804ce2992a45da9b78cec7bc70163e943a830c0e303610c9fe2b，SHA512 sha512-Xxv79rG4OsNKMrERkk7GOjZ/ElDGJjqdvECvqDCTNnQRk+1pINtUsYnUZidlhLaaRPCaswWNSUl9p8zP/GF/GA==。实际碰撞项目原报告/响应未知，不宣称三处格式失败或超时根因复现。
- v0.33.1同一调用行alias重赋值/逃逸误提示已修复并冻结提交cdb95f0529b0fbbee5c5eaecfaf50cc50213562f；发布门禁已通过：标签CI37906386448、唯一发布37906798597成功，原artifact11604593956；npm/Release88082字节匹配原工件，SHA256 754e067662a25779d99f225a957ed1c4519c13e15dd083d8ca575260263f2cbd，SHA512 sha512-u8mPIdeHKrpL6zg1ljM35FMP0nJ5SeS87HjfCw6GSchoggKnmTbQvB7Mnd/LfrdY6Lg/DK/MKBNYwk/VkCul6w==。
- v0.33.0：提交6fe4261fb7e2bd1b645b8637ba9f82840a760c83，标签四矩阵37904841884成功；唯一发布37905053267成功，原artifact11603897802。npm/正式Release与原工件逐字节一致87754字节；SHA256 fc0d99bebd62e431fdd212d83f51af5ea6e8b00ae6510210ea480b816c72064f；SHA512 sha512-OE81b9ZfHK+Smj/mTKeSiEN3xoZl1ldREKpC5F7dRBSk+grHla/ylt+rbEpwlU/4GEzfaZyNp1prov8OvAiC5g==。
- v0.32.0：冻结aa99d1d0127eff3fc03a46f9503aeb63d026445f；标签四矩阵37897428028成功；npm发布37897709965成功但registry等待耗尽，原artifact11600619879；同工件恢复37898945312成功、无重复npm发布。npm/Release85750字节逐字节匹配；SHA256 9b977da62affab4f4994265b7ed939564a1e14562f40f26dca8eb7f4f7610551；SHA512 sha512-iq6llEjoIFxkm+3koKwawci2+cmnC/QnoxkRT7CSuz1GQM6anS7J6PGDnEmyeXOXTj+rJ/sVza0q/tjodiWBoA==。

## 不变边界

仅代码审核，不自动修复/管理平台/独立模型费用/无界扫描。当前Agent继承与宿主正常策略、确认和快照权限不变。每完整功能批测试复核→提交推送新版本→冻结标签四矩阵→Actions npm→同原工件正式Release→实际字节双hash。文档只保留结论，不再新增逐轮过程记录。
