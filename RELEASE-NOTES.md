# v0.66.1 发布说明

## SVN 合并记录变化下的工作副本导航修复

修复根目录仅有 svn:mergeinfo 属性变化时，自动依赖与限定调用方发现可能报 Unsafe repository path 或祖先状态拒绝的问题。

- 明确目录身份的根节点 `.` 不作为源码依赖入口或调用目标；普通非法路径仍拒绝。
- 祖先属性 modified 只有在离线读取 BASE/当前属性并确认仅 mergeinfo 不同后，才允许导航。
- 旧/新属性仍入身份指纹；mergeinfo 修改触发指纹变化，不能绕过执行复核。
- 其他属性变化、encoded/duplicate 属性、externals/special、冲突及来源身份变化继续拒绝。
- 独立离线 SVN 测试验证依赖与限定调用方捕获，不新增联网或模型发送。

本版仅修复工作副本合并记录场景，历史自动链/调用方、未提交替换及其他全面 SVN 项仍在 [支持矩阵](SVN-SUPPORT-MATRIX.md) 中，目标尚未完成。

使用见 [README](README.md)。
