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

## 轮104既有能力验收

新增definition-navigation离线2测试：find枚举同名路径/版本→限定current sourceIds search→read精确声明CRLF；同名2声明保持歧义，literal search包含注释需read判定，不误称parser。旧侧独有source不混入新侧，import本地alias不会伪造远端export名；truncated/共享calls与output预算拒绝、批量未知source预校验零读取。全量313/313。无运行修改、不发空功能版本。

剩余具体缺口是未捕获的必要依赖与alias/实例绑定上下文，而非缺一个symbol工具。现有路径导航与文本定位这一部分验收可复用；下一步窄语言显式关系场景测试，不宣称B3全闭环。

## 接入顺序与验收

先纯导航parser测试，再snapshot reader预算（共享50 operations/256KiB输出）、协议整批校验与catalog side身份，最后模型提示与端到端。覆盖同名、alias、遮蔽、注释、旧侧、耗尽与取消。实例调用确切绑定另列后续，不以此窄首批称B3全覆盖。

轮101重读固定参考internal/tool/definitions.go，确认是工具注册定义而不是符号解析器；内建TaskDone/CodeComment/FileRead/FileFind/FileReadDiff/CodeSearch，没有独立symbol lookup。因此以上结构化操作提案暂停，不以工具数量对齐。先用已有approved search（sourceIds限定）→read定位必要定义，验收同名/别名/旧侧/输出耗尽与准确证据；只有验证发现必要缺口才考虑纯导航增强。实例/别名链上下文缺口仍保留，不能凭工具注册表称参考有语义解析。

源码依据：https://github.com/alibaba/open-code-review/blob/2d67596c961f80436deb2afa643efa2b1725d34c/internal/tool/definitions.go

轮101发布运行37905053267：Ubuntu两矩阵通过，Windows两矩阵仍运行，原Actions工件尚未保存、正式Release未生成，未重复dispatch。
