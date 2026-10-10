# 历史样本：错误接受规则文件后缀

来源是本项目历史，不是外部独立盲测。没有证明该缺陷影响过已发布版本。

## 缺陷与影响

旧正则的点号没有转义，表示任意字符，把 rulesmd 也当成合法规则文件。修复为字面点号检查后，只接受带点号的 .md 或 .txt 后缀。

这是格式检查错误，不是任意读取、权限绕过或代码执行漏洞。

## 来源与运行

- [引入提交](https://github.com/f-e-n-g-0531/dsh-code-review/commit/0d4fceead5837ff05573a5767c22c6feb1f6d81c)：新增整个模块，父版本没有该模块。
- [修复提交](https://github.com/f-e-n-g-0531/dsh-code-review/commit/20798b21ce5b880865dc97308bb4ed14b36b1f78)：通配点改为字面点。

保存的模块与直接依赖和历史内容一致，可离线运行：

	node --test test/evaluation-history-rule-extension.test.mjs

这是模块级复现，不是整个旧插件或整个提交重放。不能倒放修复并声称重放真实引入提交。模型评测不发送本说明和测试答案。
