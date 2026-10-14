# v0.64.1 发布说明

## SVN 已提交历史替换双侧采集修复

修复固定 revision 历史审查中，合法替换的同路径删除/新增记录被当作歧义拒绝的问题。

- 仅合并同类型节点的一对 deleted/added，为 replaced；其他重复和类型变化拒绝，不任意选择。
- 从被替换目标的旧 revision 和新 revision 分别读取真实正文与属性，复制替换不使用复制来源 BASE 冒充旧侧。
- 来源逐侧固定 URL/UUID/peg/operative revision，仍保持选择、预算与目录后代覆盖保护。
- 独立 SVN 测试覆盖已提交普通与复制替换以及旧属性删除、新属性添加。

本版仅针对已提交的固定历史版本；未提交工作副本替换、类型变化及其他全面 SVN 缺口仍按 [支持矩阵](SVN-SUPPORT-MATRIX.md) 推进，不以候选 diff 重建冒充支持。

用法见 [README](README.md)。
