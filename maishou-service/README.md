# 找商品后台托管模型服务

Node built-in modules only. The service listens on `127.0.0.1:4600`; Nginx exposes `/maishou/api/` and `/maishou/admin/` on `wsfile.cn`.

`VIAAPI_API_KEY` belongs only in `/home/wsf/productC/model-provider.env` on the server (owner `deploy`, mode `0600`). ERP OAuth credentials and `ERP_MAPPING_KEY` belong only in `/home/wsf/productC/erp-proxy.env` (owner `deploy`, mode `0600`). Never copy any of these values into this project, app assets, command output, or logs. TDL bearer tokens are verified through `/myladmin/api/auth/me` for every model, usage and ERP proxy request.

Usage is aggregated by TDL user and China-local date. It records counts, success/failure, provider-reported input/output tokens, aggregate latency and last-use time. It does not persist prompts, images, auth tokens, API keys, or raw provider error bodies. Ordinary users can query only their own account; accounts with `isAdmin` from TDL `/me` can view the account table and choose an individual account.

The ERP OAuth client and tenant are shared server-side. Each TDL user can save only their own ERP username and password through `/erp-config/me` (`PUT`, `DELETE`); administrators can manage selected users through `/maishou/admin/erp-users/`. No company or buyer name is required. The mapping file is AES-256-GCM encrypted using the existing `ERP_MAPPING_KEY`. The desktop app calls `/erp-config/me` after TDL login and uses only the allow-listed ERP proxy; it receives no ERP password, OAuth client secret or ERP access token. The OAuth grant forwards the configured `tenant-id`, including for token refresh. `/system/` and `/taobao/` paths are proxied only if present in the same allow list.

Configure secrets only on the server: `ERP_MAPPING_KEY`, `ERP_MAPPING_FILE`, `ERP_BASE_URL`, `ERP_TENANT_ID`, `ERP_CLIENT_ID`, `ERP_CLIENT_SECRET`, `ERP_DRAFT_API_CONFIRMED` and `ERP_DRAFT_CONVERT_CONFIRMED`. Admin-saved encrypted settings override the environment values. Preserve the existing encryption key on releases. HTTPS is required by default; explicitly authorized test environments can set `ERP_HTTP_TEST_ORIGIN` to an exact HTTP origin, which is never supplied by a buyer. Other HTTP origins and redirects remain rejected. Secrets and authorized test credentials must never be stored in this README, source files, public artifacts or logs.

`POST /erp-config/test` and the administrator-only `/erp-config/accounts/:id/test` verify OAuth, permission, dictionary and category reads. They return aggregate results only. The release script `deploy/release-cloud-erp.cjs` first verifies a private encrypted clone with the real test ERP, backs up configuration and code, then updates the existing service after checking for active requests. It takes credentials via SSH stdin, not arguments, and never writes product data or invokes the model.

Request concurrency is limited to 8 in-flight requests per account, with no shared global concurrency cap. The request body is limited to 15 MiB and upstream response to 2 MiB. The gateway forces model `gpt-6.1-sol`, reasoning effort `medium`, disables streaming and tool calls, removes sampling controls unsupported by reasoning models, and translates `max_tokens` to a bounded `max_completion_tokens`.

## Install or update

1. Copy this service directory to `/home/wsf/productC/backend` and static files under `site/` to `/home/wsf/productC/site/maishou/admin/`.
2. Create `/home/wsf/productC/model-provider.env` with only the server-side ViaAPI key and set owner `deploy:deploy`, mode `0600`.
3. Install `deploy/maishou.service` as `/etc/systemd/system/maishou.service` and `deploy/maishou-location.conf` as `/etc/nginx/maishou-location.conf`.
4. Include `maishou-location.conf` inside the existing `wsfile.cn` TLS server block, run `nginx -t`, reload Nginx, enable and start `maishou.service`.

Before production, verify the exact upstream model alias and image-input compatibility with the supplied provider account using one small synthetic-image request. Never print the authorization header or provider error body during the check.
