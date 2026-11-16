# 找商品后台托管模型服务

Node built-in modules only. The service listens on `127.0.0.1:4600`; Nginx exposes `/maishou/api/` and `/maishou/admin/` on `wsfile.cn`.

`VIAAPI_API_KEY` belongs only in `/home/wsf/productC/model-provider.env` on the server (owner `deploy`, mode `0600`). ERP OAuth credentials and `ERP_MAPPING_KEY` belong only in `/home/wsf/productC/erp-proxy.env` (owner `deploy`, mode `0600`). Never copy any of these values into this project, app assets, command output, or logs. TDL bearer tokens are verified through `/myladmin/api/auth/me` for every model, usage and ERP proxy request.

Usage is aggregated by TDL user and China-local date. It records counts, success/failure, provider-reported input/output tokens, aggregate latency and last-use time. It does not persist prompts, images, auth tokens, API keys, or raw provider error bodies. Ordinary users can query only their own account; accounts with `isAdmin` from TDL `/me` can view the account table and choose an individual account.

The ERP OAuth client and tenant are shared server-side. Each TDL user can save only their own ERP username and password through `/erp-config/me` (`PUT`, `DELETE`); administrators can manage selected users through `/maishou/admin/erp-users/`. No company or buyer name is required. The mapping file is AES-256-GCM encrypted using the existing `ERP_MAPPING_KEY`. The desktop app calls `/erp-config/me` after TDL login and uses only the allow-listed ERP proxy; it receives no ERP password, OAuth client secret or ERP access token. The OAuth grant forwards the configured `tenant-id`, including for token refresh. `/system/` and `/taobao/` paths are proxied only if present in the same allow list.

Configure secrets only on the server: `ERP_MAPPING_KEY`, `ERP_MAPPING_FILE`, `ERP_BASE_URL`, `ERP_TENANT_ID`, `ERP_CLIENT_ID`, `ERP_CLIENT_SECRET`, `ERP_DRAFT_API_CONFIRMED` and `ERP_DRAFT_CONVERT_CONFIRMED`. 所有请求固定连接正式互拓 `http://8.148.144.131/prod-api/admin-api`。环境变量、遗留加密设置以及 `ERP_TEST_MODE` 均不能切换到其他环境；管理员提交非正式地址会被拒绝。其他连接参数仍从加密设置或环境配置读取。发布时保留原有加密密钥与全部账号映射，禁止在代码、公开成品或日志中保存认证信息。

`POST /erp-config/test` and the administrator-only `/erp-config/accounts/:id/test` verify OAuth, permission, dictionary and category reads. They return aggregate results only. 部署脚本 `deploy/release-cloud-erp.cjs` 复用服务器现有加密账号映射，先通过隔离代理只读检查正式 ERP；确认无活动请求后备份并切换网关、清除遗留测试环境配置。它不接受或覆盖账号密码，不创建 ERP 商品，也不调用付费模型。已有误入测试环境的任务须另外核对正式环境记录后受控登记；不能因超时自动重复提交。

ERP 授权失效同时识别 HTTP 401 和 HTTP 200 中的业务码 `401`。GET 及两个只读分页接口自动刷新授权并最多重查一次；并发请求共用同一账号的授权过程，迟到的旧令牌错误不能清除已更新令牌。刷新失败可按保存的正常账号授权一次；采集、新增、上传、转换和删除均不自动重发。ERP 授权错误与 TDL 登录失效分开返回，不因 ERP 业务 401 要求用户重新登录桌面软件。

新买手任务使用 `POST /erp/product-addition/add` 直接保存到正式互拓待审核，跳过草稿。网关须通过加密设置 `directSaveConfirmed=true` 或服务器 `ERP_DIRECT_SAVE_CONFIRMED=true` 明确启用，配置响应公开的能力字段是 `canSavePending`。部署脚本可用 `--enable-direct-pending` 在同一次受控发布中启用；该参数不发送商品请求。保存接口的 `data=0` 只是受理回执，不当作商品 ID；客户端先持久化提交检查点，再发一次请求，随后以完整商品编码和货号进行限定查询，核对详情中商品身份及 `productState=0` 后回填编码。超时、中断或回执未知的旧提交只回查，不自动重发，不调用最终审核、通知或上架。

客户端可通过允许的 `GET /erp/supplier-infos/getSupplier` 读取当前账号可见的供应商名称、缩写和仓库目录，本地缓存五分钟；模型只接收与商品资料相关的候选。选择后仍以 `/erp/supplier-infos/sample-list?name=...` 核验已审核启用状态。网页档口位置和真实店名分开保存，匹配不再仅依赖位置名称完全相等。字段统一填写后直接进入待审核，软件中的供应商依据只用于查看，不构成新的人工确认步骤。

Request concurrency is limited to 8 in-flight requests per account, with no shared global concurrency cap. The request body is limited to 15 MiB and upstream response to 2 MiB. The gateway forces model `gpt-6.1-sol`, reasoning effort `medium`, disables streaming and tool calls, removes sampling controls unsupported by reasoning models, and translates `max_tokens` to a bounded `max_completion_tokens`.

## Install or update

1. Copy this service directory to `/home/wsf/productC/backend` and copy `site/` into `/home/wsf/productC/site/`, preserving its `maishou/admin/` and `maishou/table/` subdirectories.
2. Create `/home/wsf/productC/model-provider.env` with only the server-side ViaAPI key and set owner `deploy:deploy`, mode `0600`.
3. Install `deploy/maishou.service` as `/etc/systemd/system/maishou.service` and `deploy/maishou-location.conf` as `/etc/nginx/maishou-location.conf`.
4. Include `maishou-location.conf` inside the existing `wsfile.cn` TLS server block, run `nginx -t`, reload Nginx, enable and start `maishou.service`.

Before production, verify the exact upstream model alias and image-input compatibility with the supplied provider account using one small synthetic-image request. Never print the authorization header or provider error body during the check.

## 网页版在线选品表

静态页面位于 `site/maishou/table/`，公开路径为 `/maishou/table/`；Nginx 使用本项目的 `maishou-location.conf` 中新增的精确路由与静态资源路由。页面通过现有 `/myladmin/api/auth/login` 与 `/me` 登录，使用同一标签页的 `maishou-tdl-token` 会话键，与账号页面保持一致。

业务数据只调用同源 `/maishou/api/online-table/api/tables`，复用现有在线表服务及 TDL 鉴权。支持新增、粘贴导入、编辑、搜索分页、确认任务、修改记录、管理员预览后回档及 CSV 导出。网页不领取桌面任务、不连接平台插件、不在网页中创建互拓商品；确认后由桌面端按原流程领取处理，网页每30秒回读共享进度。账号密码只在登录时发送，网页不会读取桌面平台账号或模型密钥。

上线需同时发布静态文件、更新在线表服务（任务确认人字段）及 Nginx 路由，经 `nginx -t` 通过后再 reload。本说明与本地测试不表示已经完成生产部署。
