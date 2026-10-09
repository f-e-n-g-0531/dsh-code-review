# v0.32.0 发布核验记录

状态：轮89实际npm字节与原工件双hash已通过；Release恢复运行中，尚非完整发布闭环。

- 固定提交：aa99d1d0127eff3fc03a46f9503aeb63d026445f；标签v0.32.0。
- 标签CI：37897428028，Ubuntu/Windows×Node22/24四矩阵success。
- 一次发布dispatch运行：37897709965；自身四矩阵success；release job113713299793。禁止重复dispatch/npm publish同版本。
- Pack/install与原工件保存成功；npm publish步骤2026-10-09T07:14:29Z–07:14:31Z成功，但不等价registry可用。
- 原Actions artifact11600619879，release-v0.32.0-37897709965，archive下载并解包于D:/TEMP/dsh-release-0320-Jz5OG4/original。
- 原tarball85750字节；SHA256 9b977da62affab4f4994265b7ed939564a1e14562f40f26dca8eb7f4f7610551，与原SHA256SUMS一致。
- SHA512 integrity：sha512-iq6llEjoIFxkm+3koKwawci2+cmnC/QnoxkRT7CSuz1GQM6anS7J6PGDnEmyeXOXTj+rJ/sVza0q/tjodiWBoA==。
- 轮84–86版本URL（encoded/unencoded）、包索引与直接tarball尚无0.32.0；fresh查询与no-cache仍404。包索引latest仍0.31.1。原运行Verify registry artifact仍in_progress，Release pending，正式tag release404。
- 必须待原运行结束再决定恢复。恢复仅允许同原Actions工件，不能重新打包替代，不凭publish success绕过registry字节门禁。只有实际npm/Release bytes与原tarball完全一致及两hash相符才完成本批。
- 本地302tests、隔离入口、离线真实ToolRuntime smoke通过；非真实模型质量验证。B1首批功能冻结，历史/SVN/语义caller与其余能力任务未闭环。

轮87原run completed/failure，日志确认Verify registry artifact重试耗尽：Cannot verify npm version: HTTP 404（07:19:20Z）；Release skipped。新增recover-v0320工作流固定原commit/tag及artifact/hash，只有registry原字节验证成功才创建Release；无pack无npm publish。轮88日志确认npm返回processing通知及成功收据。轮89registry元数据/tarball200；实际85750字节与保存原工件完全相同且SHA512/SHA256通过。已一次dispatch恢复运行37898945312（不重新npm publish）；运行中，待正式Release下载与原工件比对，不把本记录当发布收据完成版。
