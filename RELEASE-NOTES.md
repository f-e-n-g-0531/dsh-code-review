# v0.63.0 发布说明

## SVN 历史显式上下文与目标规则

固定 revision 历史审查支持显式 `contextPaths` 与 `rulePaths`，无需回退或修改工作副本。

- 上下文目标正文与可验证旧侧正文分别读取固定对象，保留 UUID、URL、peg/operative revision、原字节及正文哈希，不能跨侧替换。
- 项目规则只读取目标版，沿用 UTF-8、单规则 16KiB 和总规则 32KiB 限额。
- 已排除、阻断或已删除的变更不能通过上下文/规则重新进入批准范围。
- 共享原 20 上下文名额与历史源码、元数据、命令和总采集时间预算；故意污染的本地文件不会进入历史模型输入。

## 模型协议失败诊断

针对“不是完整 JSON”和“Invalid read request”增加不含源码的诊断：JSON 空输出、非 JSON 开头、非精确 fence 与无效 JSON-like 形状分别标明；读请求报告无效字段名和请求序号，保留 MODEL_INVALID_READ_REQUEST 分类。明确 start/count 整数及 200 行上限，不修复或补全模型 JSON、不默认值转换、不扩大预算、不自动重试。

这些改动尚未用用户三个 loader 文件的实际响应核验，不宣称该样本失败已消失或审核已通过。

## 当前限制

`oldContextPaths`、自动历史依赖链、历史调用方和跨 URL 分支比较仍待后续实现；远端仍须显式 `svnAllowNetwork:true`。工作副本替换、关键字映射等也未全部支持，见 [SVN 支持矩阵](SVN-SUPPORT-MATRIX.md)。

使用见 [README](README.md)。
