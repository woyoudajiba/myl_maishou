# 在线选品表服务

这是桌面端买手工作台使用的多人在线表格后端。服务保存在线表中的可选字段、商品链接、人工确认状态和互拓回执；空白行可以先保存，只有链接不为空才计入商品数量和自动处理。不保存商品图片或平台密码。SQLite 使用 WAL，表格行带 `version`，编辑冲突返回 `409`；SSE `/api/tables/:id/events` 可供网页客户端实时刷新。

## 启动

使用 Node.js 22 或更高版本：

```powershell
cd table-server
$env:PORT = "43900"
node server.mjs
```

生产环境固定监听 `127.0.0.1:43900`，由 HTTPS Nginx 反代到 `/maishou/api/online-table/`。桌面端固定访问 `https://wsfile.cn/maishou/api/online-table`，无需用户输入服务器地址或表格访问令牌。在线表接口会向 TDL `/me` 验证当前 Bearer 会话，只有 TDL 管理员可创建唯一的共享选品表；普通 TDL 账号可以访问、编辑和处理表格行。未登录的请求均拒绝。部署文件位于 `deploy/`。

首次由管理员在“买手工作台 → 在线选品表”创建一次；后续登录账号会自动发现并使用共享表。TDL Bearer 会话只由桌面主进程传给同域 HTTPS 服务，客户端没有表格专用 token。

## API 摘要

- `GET /api/tables`：TDL 登录后查看共享表。
- `POST /api/tables`：仅 TDL 管理员可创建；仅允许存在一张共享表。
- `GET /api/tables/:tableId?offset=0&limit=100`：分页读取行；行字段均可为空，返回 `rowCount`（链接商品数）和 `rowTotal`（已保存行数）。
- `GET /api/tables/:tableId/find?search=:text&index=0`：按货号、链接、标题、备注、互拓编码和固定业务字段查找，并返回第几处匹配及行偏移。
- `GET /api/tables/:tableId/locate?position=:row`：按行号定位，返回分页偏移。
- `POST /api/tables/:tableId/rows`：批量导入最多 1000 行。
- `PATCH /api/tables/:tableId/rows/:rowId`：带 `ifVersion` 更新，冲突返回 `409`。
- `POST /api/tables/:tableId/claim/:rowId`：领取已人工确认行，单行幂等竞争。
- `POST /api/tables/:tableId/restart/:rowId`：按 `previousTaskId` 和 `ifVersion` 原子接管供应商搜索/比对阶段的异常任务，并绑定新的本机 `taskId`；其他阶段、已进入互拓或共享行版本变化均返回 `409`。
- `GET /api/tables/:tableId/events`：SSE 事件流。
- `DELETE /api/tables/:tableId/rows/:rowId`：带 `ifVersion` 软删除；保留原行及任务回执。
- `GET /api/tables/:tableId/history?limit=50&before=:id`：分页查看修改记录。每条记录表示一次操作，恢复点为该操作之前。
- `GET /api/tables/:tableId/history/:id`：查看操作人、时间及商品字段的前后值。
- `GET /api/tables/:tableId/rollback/:id`：仅管理员可预览整表恢复影响及当前 `revision`。
- `POST /api/tables/:tableId/rollback/:id`：仅管理员可恢复，必须带预览得到的 `ifRevision`。表格已有新变更时返回 `409`，不得静默覆盖。
- `POST /api/tables/:tableId/clear`：仅管理员可调用，必须带当前 `ifRevision`。客户端不提供一键清空按钮。
- `GET /health`：服务健康检查（不返回业务数据）。

在线表格人工状态只有 `pending`、`approved`、`rejected`。空白链接行不能确认、领取或进入自动任务；只有链接有效且来源受支持的行才可确认。桌面端只对 `approved` 行领取并创建现有买手任务；互拓仍按原有契约进入草稿或待审核，在线表格不会绕过人工确认或把回执未知当成功。互拓账号可以由当前买手在桌面设置中自行填写，所属公司不是必填项。`data/online-tables.sqlite*` 是唯一持久数据，需定期备份。

跨设备重新开始只允许 `attention` 且处于 `supplier_search` 或 `supplier_compare` 的已确认行，并要求尚无互拓编码。旧任务编号和行版本同时校验后才会改绑；开始处理之前的其他设备本地任务文件不会被远程访问或删除。已经进入供货资料、互拓提交/转换或回执未知的行不允许接管。

编辑、导入、确认、领取、删除和任务回写都与修改记录在同一个 SQLite 事务中提交；失败的操作不会留下部分数据或成功记录。事件在提交后才发送。记录采用首次完整基线、每 50 次操作一个检查点，其余保存行级前后差异，避免每次进度回写复制整张表。当前不自动裁剪历史；以后若做保留策略，必须保留可恢复的基线与完整增量链。

回档只恢复表格业务内容，保留当前任务绑定、自动处理进度和互拓编码。已领取行的货号、来源、日期、目录编号和人工确认状态也保留当前值；未领取行重置为待确认，防止恢复触发自动提交。回档会生成新记录，版本号持续增加，旧客户端不能覆盖恢复结果。误删不等于丢失，SQLite 文件本身丢失则仍需独立备份；运行中的 WAL 数据库应使用 SQLite backup API 一致性备份。

日期、表格ID、供应商、运营编码、操作人和原表的销量/成本/仓库字段会随在线行保存、编辑、导出并传给买手任务；原表成本是录入信息，不替代供应商事实核验。商品图片仍由商品链接采集，不把工作簿图片附件上传到在线表。本功能需要桌面端和表服务配套更新，旧服务没有历史接口。详细使用与验收边界见 [在线表编辑与回档](../docs/在线表编辑与回档.md)。

发布脚本为 `deploy/release-service.py`，分 `prepare`、`activate` 和 `site` 三步。仅接受私有暂存目录 `/home/deploy/productC-table-upload-<uuid>`，先校验源文件 SHA-256、保存一致性数据库备份及旧代码/更新清单/教学页，再运行 `probe-release.mjs` 验证备份副本。服务切换失败会恢复旧代码并重启；不会用旧数据库覆盖线上数据。安装包通过 `scripts/publish-update.js` 发布匹配更新清单后，才允许更新教学页。私有备份保存于 `/home/deploy/productC-release-backups/`，生产数据不进入公共下载目录。
