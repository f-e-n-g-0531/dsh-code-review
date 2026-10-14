# v0.62.0 发布说明

## SVN 原生固定 revision 历史审查初始模式

新增 `svnRevision`（r-1 与 r）和 `svnBaseRevision` / `svnTargetRevision`（明确旧/新树端点），可直接审查工作副本根对应仓库 URL 的固定历史版本，无须在业务工作副本回退或合并。

- 来源逐侧绑定仓库 UUID、URL、peg revision、operative revision 和正文哈希，不使用脏工作树。
- 非本地仓库访问必须显式 `svnAllowNetwork:true`（含 file://server 网络共享）。预览会读取指定历史元数据与源码，但零模型发送；确认执行仍重验快照。
- 捕获正文、属性及目录增删后代；历史关键词用 svn cat --ignore-keywords 的未展开仓库正文，不伪造工作侧行号。
- 共享原文件数、源码/快照上限及有界命令、元数据和总采集时间；超限不冒充成功。

## 初始模式限制

只接受数字 revision，不接受 HEAD/日期别名，不支持任意 URL、跨 URL 分支比较和历史 contextPaths/oldContextPaths/rulePaths/autoContext/callerScopePaths。历史依赖及调用方仍待后续实现。

离线替换 diff 重建组件仅返回 candidate-only，不能独立证明旧节点完整来源/编码/属性，未接入工作副本替换采集。全面 SVN 目标尚未完成，见 [SVN 支持矩阵](SVN-SUPPORT-MATRIX.md)。

参数与用法见 [README](README.md)。
