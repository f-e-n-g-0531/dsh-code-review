# v0.49.0 发布说明

## Go/Python/Rust 运行时提示细化与 ArkTS 支持

为 Go、Python、Rust 补充版本与运行环境前提提示：Go 关注构建标签、go.mod/runtime 版本和 GC/finalizer 假设；Python 关注版本相关语法与关键字/位置调用契约；Rust 关注 edition/MSRV、cfg 与 proc-macro 展开及 panic 模式。新增 ArkTS（.ets）指导，关注 UI 线程/组件生命周期、状态不可变规则与受限 ArkTS/动态执行边界。

## 限制

- 提示仍只针对具体缺陷和反证，不是语义解析、迁移执行结果或缺陷证据，不授予读取权限。
- .ts/.tsx 仍按 JavaScript/TypeScript 提示，不自动转为 ArkTS；仅 .ets 命中 ArkTS 指导。

使用方法见 [README](README.md)。
