# 本项目历史缺陷：规则扩展名误接受

来源：本项目历史，不是外部独立基准，也不是盲测。许可证沿用仓库LICENSE。未证明已发布版本受影响。

- 引入提交：0d4fceead5837ff05573a5767c22c6feb1f6d81c
- 修复前提交：2b317cacbe6509888f0766e2b8457e692835ff7b
- 修复提交：https://github.com/f-e-n-g-0531/dsh-code-review/commit/20798b21ce5b880865dc97308bb4ed14b36b1f78
- 位置：src/project-rules.mjs，captureProjectRules扩展名检查。
- 已核对历史diff：`/.(md|txt)$/i` → `/[.](md|txt)$/i`，通配点改为字面点。

触发：显式选择内容有效但名称为rulesmd的文件。旧谓词接受它；修复后的实际捕获函数拒绝，并返回扩展名错误。合法rules.md和rules.txt仍接受。

本轮测试复现的是历史谓词的精确摘录，并验证当前捕获接口，不是对完整旧提交的端到端运行。影响限于格式白名单不符合契约，不表示任意读取、审批绕过或执行代码。

`node --test test/evaluation-history-rule-extension.test.mjs`可离线运行。后续若用于模型评测，应使用固定历史完整源码、依赖与上下文；修复方向是缺陷消除，不应反向制造一次虚构的引入提交。真值说明不得随模型输入发送。
