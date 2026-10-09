# B3 定义导航首批：轮99接口核查（未实现）

B2 v0.33.0固定标签CI37904841884仍运行，当前不扩该批。本文仅确定下一项范围。

## 已有而不重造

import-call-sites已识别named import alias的独立调用行，directImportBindings已关联唯一export function声明，明确conservative-syntax-only。C#/C++亦有窄语法线索。retrieval提供批准catalog find/search/read，但没有结构化定义导航。

## 首批拟补的最小能力

在已批准快照来源内，给JS/TS明确声明（function/class/const函数）提供symbol与声明行导航，输入为显式名称及限定sourceIds，结果带snapshotId/sourceId/side/hash/line及navigation-only，不复制函数体。不从工作树搜索，不扩大capture，不跨版本混用。

## 禁止误宣称

- 非符号解析器，不推断别名链、动态属性、实例类型、继承/重载绑定或调用可达性。
- 同名多声明全部保留为歧义；旧侧source必须只用于旧侧。
- 注释/字符串/模板/不支持语法不得误命中，解析限制与结果truncated可见。
- 不能用search/find导航结果直接作缺陷证据，仍须read原行并证据校验。

## 接入顺序与验收

先纯导航parser测试，再snapshot reader预算（共享50 operations/256KiB输出）、协议整批校验与catalog side身份，最后模型提示与端到端。覆盖同名、alias、遮蔽、注释、旧侧、耗尽与取消。实例调用确切绑定另列后续，不以此窄首批称B3全覆盖。

最终策略实施前仍需对固定参考定义工具输入输出核对；当前属于最小设计提案，不是已批准模型可调用操作或交付完成。
