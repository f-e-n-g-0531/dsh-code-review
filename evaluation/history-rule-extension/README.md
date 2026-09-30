# 本项目历史缺陷：规则扩展名误接受

来源：本项目历史，不是外部独立基准，也不是盲测。许可证沿用仓库LICENSE。未证明已发布版本受影响。

- 引入提交：0d4fceead5837ff05573a5767c22c6feb1f6d81c
- 引入父提交：8598129d7393943f7bc1e0d6a5fa4b634e20fb47；该父提交无src/project-rules.mjs，引入是新增整个模块（不是改坏原有谓词）。
- 引入模块blob与此处before完全相同：ecf5a697650e03622fe645026bc75ccd996e6cc9。可用“左侧不存在→完整before模块”重放引入方向；属于选定模块重放，不是整个历史提交端到端重放，也不把修复倒放当引入。
- 修复前提交：2b317cacbe6509888f0766e2b8457e692835ff7b
- 修复提交：https://github.com/f-e-n-g-0531/dsh-code-review/commit/20798b21ce5b880865dc97308bb4ed14b36b1f78
- 位置：src/project-rules.mjs，captureProjectRules扩展名检查。
- 已核对历史diff：`/.(md|txt)$/i` → `/[.](md|txt)$/i`，通配点改为字面点。

触发：显式选择内容有效但名称为rulesmd的文件。旧谓词接受它；修复后的实际捕获函数拒绝，并返回扩展名错误。合法rules.md和rules.txt仍接受。

现已保存并运行修复前后完整project-rules模块及各自content直接依赖，与当前接口一起验证同一实际文件；无需联网或Git历史即可运行。四个文件Git blob对象与历史完全一致：旧规则ecf5a697650e03622fe645026bc75ccd996e6cc9，新规则da8839c1985ed017d71db7a25fa2f10f64744802，两个content均95bf27f4588ddf89e715c236384651ba297a431a。这是完整模块级复现，不是整个旧插件审批/模型链路的端到端运行。影响限于格式白名单不符合契约，不表示任意读取、审批绕过或执行代码。

`node --test test/evaluation-history-rule-extension.test.mjs`可离线运行。后续若用于模型评测，应使用固定历史完整源码、依赖与上下文；修复方向是缺陷消除，不应反向制造一次虚构的引入提交。真值说明不得随模型输入发送。
