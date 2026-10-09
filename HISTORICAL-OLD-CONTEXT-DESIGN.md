# B2旧侧独有上下文：轮88只读接口核查

轮98 B2显式旧侧首批实现冻结，311离线验收通过，v0.33.0候选远端门禁待验证；B1已发布批保持冻结。下文保留轮88接口缺口背景，非当前实现状态。

## 当前具体缺口

Git历史captureContext仅接受target regular blob；autoContext虽合并old/new import探针，但old-only结果仍调用target捕获并被blocked。selected deletion保持changed-old来源；不能把excluded deletion恢复为context绕过selectedPaths。retrieval-scope已有context-old但要求item.revision===history.target且oldRevision===base，隐含每个context都有目标侧正文。关系与C#消费者亦依赖text/oldText形状，不能仅把base正文填入text冒充target。

## 拟定边界与验收（待实现）

- 独立明确oldContextPaths授权，Git历史限定；target contextPaths语义不改，不静默fallback。最多20上下文总槽含双侧路径，4MiB快照及256KiB每blob共享。
- 对selected changed/deletion不重复capture；已有changed-old即身份，excluded/blocked changed严格拒绝。
- old-only entry显式version/exists标记、base commit/blob OID/hash，没有target正文；root baseline null拒绝；历史对象只读无需checkout/fetch/worktree。
- reader/catalog/primary/interaction/verification与关系消费者全面side分派，不给不存在target创建空context-new。旧侧不能证实新侧行为。
- 真实Git测试需覆盖base-only路径、相同路径双版本、deleted changed/excluded拒绝、symlink/submodule、字节/slot、root/merge、OID稳定且工作树不变；模型输入计预算与原证据校验，不冒充效果测试。

实施依赖：先统一context身份，再捕获选项/schema/service预览，最后各消费者侧限定与回归。正式发布完成B1首批前不修改运行源码。
