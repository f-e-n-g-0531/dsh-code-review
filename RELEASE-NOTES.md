# v0.50.0 发布说明

## Objective-C/Swift/Java/Kotlin/C# 生命周期与并发提示细化

为这些语言补充证据门控的运行时前提提示：Objective-C 关注数据/网络/通知清理与队列/主线程约束；Swift 关注 @MainActor/@preconcurrency 隔离与严格并发诊断；Java 关注虚拟线程绑定、并行流线程池假设与版本门控 API；Kotlin 关注 expect/actual、多平台与 @Volatile/@Synchronized 互操作；C# 关注 ValueTask 重复等待、ConfigureAwait 调度与 .NET 版本可空性。

## 限制

- 提示仍只针对具体缺陷和反证，不照搬风格偏好或错误绝对规则，不授予读取权限。
- 全部以实际运行环境为证据前提，不推断线程亲和、调度或内存保证。

使用方法见 [README](README.md)。
