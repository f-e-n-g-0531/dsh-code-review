# v0.80.2 文档核对记录

本记录供维护者查证，不代替用户指南或测试报告。检查范围是本项目跟踪的Markdown，不改第三方reference镜像和node_modules副本。

## 已纠正

| 问题 | 修订位置 | 核对依据 |
|---|---|---|
| v0.80.0写成已发布版，指南仍含待验收字样 | README、CHANGELOG | 正式包是v0.80.1；v0.80.0标签失败且未移动 |
| 一律拒绝链接/固定宽度的旧说法 | README、SVN-SUPPORT-MATRIX | svn:special审记录而不跟随；受支持关键字保留原文并核验 |
| 要求所有SVN区间revision严格递增 | README | 同revision可比较不同分支端点 |
| 当前能力概览混入数十版流水账与过强对齐结论 | CORE-ALIGNMENT-TASKS、CORE-SOURCE-INVENTORY | 只描述实现机制与限制；参考阅读不证明质量等价 |
| 历史未完成状态被误当作当前缺口 | SVN-SUPPORT-MATRIX、SVN-RELEASE-EVIDENCE | 当前指南与历史发布工件分离，历史事实不改写 |
| 评测目录绝不随包的绝对说法 | evaluation/README | REVIEWBENCH-LOCAL.md是实验入口说明，随包提供，其余样本/结果不打包 |
| 集中验收勾选似乎保证所有输入安全 | SVN-CONSOLIDATED-ACCEPTANCE | 标为历史机制检查；显式注明后续发现和补丁 |

## 已阅读但不改写的历史材料

CHANGELOG各旧版本段落、SVN历史包哈希、PILOT-RESULTS、PILOT-GATE及三个样本说明均按当时事实保留；不把六次历史观察升级为当前模型成绩。ReviewBench入口是独立实验协议，不冒充DSH完整配置质量。参考索引的已阅读状态是历史记录，不代表本轮逐篇重读参考代码。

## 验证方式

自动检查本项目维护文档的相对链接、安装包清单、发布标题与版本一致，以及README JSON参数与实际注册工具schema。当前版本验收和工件核验记录另见 [发布说明](RELEASE-NOTES.md) 和 [SVN支持范围](SVN-SUPPORT-MATRIX.md)。
