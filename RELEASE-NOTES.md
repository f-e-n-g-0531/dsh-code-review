# v0.55.0 发布说明

## 模板引擎与基础设施即代码专用指导

本轮把此前对模板与基础设施文件的通用提示细化为按引擎的保守缺陷指导：Freemarker、Handlebars/Mustache、Jinja、Pug、Astro 关注转义边界、模板注入、缺失值与部分/继承；Terraform、Bicep 关注硬编码凭据、过度授权、状态/生命周期与版本可复现。全部提示只针对具体缺陷和反证，不照搬风格偏好或性能建议，也不新增读取或放宽预算。

## 限制

- 只读批准快照，不新增读取、不放宽预算、不改变审查行为或参数。
- 依赖清单与配置类文件（Cargo.toml、composer.json、package.json、pom.xml、build.gradle、GitHub 工作流、yaml、properties、json）仍保持通用提示，按“不按文件名推定行为”处理。

使用方法见 [README](README.md)。