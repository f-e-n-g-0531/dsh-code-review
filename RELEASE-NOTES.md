# v0.80.1 发布说明

## SVN 集中能力更新

- 同仓库跨分支固定URL比较：svnBasePath/svnTargetPath指定仓库根相对路径，支持相同revision不同分支，各侧正文、上下文、依赖和调用方独立来源。
- svnEffectiveMergeinfo显式读取BASE/工作或固定历史的祖先合并属性，保留来源证据；不完整边界和混合BASE返回unknown，不推断合并提交已审查。
- svnReplacementBaseRevision显式指定目标URL历史基线，支持文件/目录替换树及类型变化，每个后代单独批准；不使用copy-source BASE，不声称恢复被删除节点。远端需svnReplacementAllowNetwork。
- SVN链接只审link目标记录，不跟随目标，不把链接数据用于源码导航。稀疏/混合revision明确披露已观察范围，不伪造全树覆盖。
- 关键字支持固定宽度、截断标记及复合自定义格式，原正文/hash/行号保留。空格用SVN原生%_；引号格式明确拒绝，不模拟shell语义。
- 工作副本统一命令/元数据/截止账本，含导航、mergeinfo及末尾验证，超限明确失败。

## 发布验证等待优化

发布核验同一冻结标签/提交/当前attempt的成功四矩阵CI证据，不再重复运行四组测试。错仓库、错提交、缺组、失败或重跑中的记录拒绝；原包一次构建、npm/Release字节及双哈希核验保持。

## 必须了解的限制

冲突、缺失、阻塞、incomplete没有可确认目标时只诊断，不标记审查成功，也不自动解决。外部/切换来源必须独立选择仓库根或明确固定分支端点，不隐式跟随。不完整权限、不可解码、稀疏缺项和预算耗尽均不得视为通过。跨仓库/嵌套重叠分支根不支持。

使用步骤与JSON示例见[README](README.md)，逐项证据与限制见[支持矩阵](SVN-SUPPORT-MATRIX.md)。
