# v0.48.0 发布说明

## 剩余语言与格式的保守缺陷提示

为 F#、R、Elm、Haskell、Julia、Nim、OCaml、Rego、Jsonnet、Nix、Solidity、Vyper、Verilog/SystemVerilog/VHDL、Zig、PO/POT、MyBatis 映射和 JS/TS/React 补充了审查提示。提示只针对具体缺陷和反证，不照搬风格偏好、无条件性能建议或错误绝对规则。

Rego、Jsonnet、Nix 关注未定义值、对象合并和构建依赖；Solidity/Vyper 关注重入、外部调用和存储布局；硬件描述语言关注调度、位宽和跨时钟域；Zig 关注分配器与错误清理；PO/MyBatis 关注文本身份、占位符与绑定值；React 关注 hook 清理和渲染副作用。

## 限制

- 提示不是语义解析、迁移执行结果或缺陷证据，也不授予读取权限。
- MyBatis 只在 XML 头部有限范围的 mapper 签名命中时选择该提示，其余 XML 仍是通用配置提示。
- 有歧义的后缀不猜测：裸 .v、.pot 不分类；.sol 仅在命中 Solidity 签名、.fs/.fsi/.fsx 仅在命中 F# 签名时给出对应提示，否则保持通用。
- Go、Python、Rust 及部分语言的生命周期与并发细化仍保留后续验收。

使用方法见 [README](README.md)。
