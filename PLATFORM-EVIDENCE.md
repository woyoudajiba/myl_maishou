# 三个平台的接入依据（2026-10-14）

只修改 v4-core。没有操作公司平台或改动 legacy/v2/v3。

## 17网

公开图搜页面 https://stu.17zwd.com/SearchSimilar

公开脚本：`/public/js/chunk/yqzwd/tusou/searchsimilar.c625fcb7.js`、`/public/js/chunk/common.d04f4bf8.js`。

页面原生 `initAllGoods()` 依次请求 accurate 与 similar；`by_message` 分支用 `img_base64` 传入图片。`getResult()` 请求 image64Search，响应为 items、total、cacheKey。商品字段为 gid、sid、zdid、item_no、item_title、item_pic_url、item_price_pifa、shop_name。域名前缀由页面配置 areaList 的 id/prefix 匹配，未知站点不给伪造链接。

通过 chrome.scripting MAIN 调用页面原生 apiCaller.post。采用 Original=4 和明确 `/tusou/_api/searchsimilar/image64Search` 路径。CSRF、签名由网站原生模块处理，不读取/持久化/输出登录 token。跳过广告接口、推荐商品接口。两组各取第一页 100 条，去重后显示；平台总量可有交集，不代表已返回数量。

## 青创网

公开模块 https://j.17qcc.com/combo?imgsearchsmilar&uploadimgsearch&t=093001

官方剪贴板流程：宽高 80～1024；FormData 字段 image、enc_auth_token 上传 https://img.17qcc.com/picture/UploadBase64Image；读取 Result.FileFullPath，移除图片域名和查询参数，再调用原生 $.qccAjax `/api/services/app/ImgSearch/GetProductListByImg`，参数 ImgUrl 与 cfgPage.ImgSearchChannel。响应 Success/Result/Error，VIP次数不足是失败；Success 且原生模板无商品卡是官网明确的空结果状态。

用登录页自己的 productlistTmpl 渲染响应到脱离页面的文档，然后读取结果 li 的商品链接、lazyload 图片与 .money 价格。登录后的模板尚未在真实会话验收；缺少模板则报错，不读首页推荐凑结果。token 仅用于官方上传参数，留在页面内存中。

## 衣衫汇

公开女装首页 https://www.e3hui.cn/ 的 `.file-input[data-url]`；公开脚本 `/scripts/main/common.js?v=202610140931` 的 delegated change 流程。

登录后的 data-url 是实际上传地址；未登录为空。上传 FormData file，限制 4MB；响应 path 决定 `/purchaser/img-search?url=...`。当前公开页面显示图片宽高至少 201 像素；上传脚本确认 jpg/jpeg/png/bmp 与 4MB 限制。0.2.1 接受平台控件提供的 HTTPS 跨域上传地址，Cookie 与 CORS 仍由原生 jQuery 行为控制，不自行复制凭据。当前适配在独立临时页上传后按官网流程整页导航至结果页；男装/女装根据已有站点域名复用登录 Cookie。

2026-10-19：未登录的独立浏览器访问实测从衣衫汇首页跳转至 `sso.e3hui.cn`。0.3.15 将该情况识别为登录阻塞；不会尝试自动填写登录信息。

2026-10-19：用户真实搜索截图显示青创网返回 `-10001`“本月的搜索已达上限”，这是平台账户月度搜图配额限制；扩展现将其报告为不可重试的 `platform_quota`。同次截图显示衣衫汇 `Failed to construct 'URL': Invalid base URL`；0.3.16 已以已解析的平台 origin 构造结果页 URL，避免依赖新建标签可能缺失的 `tab.url`。0.3.20 为站点 origin、结果 URL 构造、导航和结果解析保留脱敏阶段信息，失败不会再只剩浏览器原生 URL 异常。

扩展输入区的粘贴/拖放只把图片载入工作台，不要求平台支持剪贴板。衣衫汇适配器以 FormData 的 `file` 字段调用页面提供的 HTTPS 上传地址，取得 `path` 后进入官方结果页。0.3.17 的 75 秒总等待覆盖最多 12 秒页面就绪、25 秒上传、30 秒导航和 5 秒结果列表等待。0.3.20 诊断还标明文件上传模式、字段名以及是否拿到 `path`，不记录图片路径或文件内容。

0.3.18 本地图片判断使用 32×32 归一化输入，结合 8×8 灰度哈希、空间亮度、边缘分布和全图颜色统计；这是排序辅助，不是商品识别模型或同款概率。测试加入同色但轮廓不同的服装样例。分数算法升级后会清除旧算法缓存分数，需由新搜索重算。

2026-10-19：衣衫汇公开页样本 `http://e3h.i.ximgs.net/...jpg` 与 `http://aodo.i.ximgs.net/...` 以及对应 HTTPS 地址均返回 `image/jpeg`。0.3.19 将这两个精确主机升级为 HTTPS，并只授予它们 HTTPS 图片读取权限。独立临时 Edge 加载 v0.3.19 后，通过扩展后台实际读取、解码，并分别以每张图对自身运行完整本地图像评分，尺寸为 121×75 与 740×342，得分均为 1；后台仍拒绝其他 ximgs 子域、带凭据地址和重定向到站外的图片。

2026-10-19 公开前端复核：衣衫汇 `common.js?v=202610140931` 仍从 `.file-input` 读取 File，以 `FormData` 的 `file` 字段上传，成功后导航到 `/purchaser/img-search?url=...`，文件限制 4MB。青创网图搜模块仍用 `image`、`enc_auth_token` 上传并调用 `GetProductListByImg`；`-10001` 显示搜图次数耗尽，官方按结果列表是否有 `<li>` 显示空状态。17网当前图搜 chunk 仍包含 `image64Search`、`by_message` 和 `item_pic_url`。因此本地适配器协议未见公开版本变化；这不替代登录态验收。

0.3.21 之后，青创网/衣衫汇只有模板确实没有商品卡才报告空结果；有 `<li>` 但商品详情链接不能识别时返回结构错误。0.3.22 在 `.com`、`.cn` 同时打开时使用活动站点域并从导航事件补足结果 URL。0.3.23 在已打开的站点只检查官方上传控件是否具有 HTTPS 地址，优先使用可上传站点域；探测只返回布尔值，不保存地址。0.3.24 在探测阶段响应取消，并兼容青创网详情路径大小写。

商品卡样式和链接依据公开首页 .pro-224 / .pro-list / /product/{id}.html。官方脚本上传成功后使用整页导航到 `/purchaser/img-search?url=...`；适配器在独立临时页遵循该流程。图片搜索页结果容器与登录后价格字段仍未得到真实响应证明，当前只接受 `#searchPage` 内匹配商品卡；非空但无法解析的商品卡明确报 `platform_contract`，只有官网明确空结果文本才按 0 条处理，不把推荐商品或加载中页面当空结果。此站真实登录态商品采集仍待验收。

## 验证边界

browser-test/platforms.test.js 使用合成响应，只证明请求参数、青创尺寸变换、两组去重、返回字段与错误分支可回放。真实登录、额度、验证码、平台新 DOM、商品详情有效性尚需在用户已登录浏览器验收。

历史工具记录：Codex 浏览器连接器曾报告 `unsupported Codex auth method: apikey`，这是开发工具读取标签页失败，不代表找商品扩展的平台连接状态。本轮未读取或复制用户 Cookie，也未操作公司平台。仍缺少青创登录后的原生结果模板、衣衫汇图片搜索页 HTML/价格字段，以及新版本下真实图片搜索返回的候选结果。


## 2026-10-19 会话复核

仅通过当前浏览器可见页面做只读核对，没有触发搜图、上传图片或读取凭据。青创网 `https://www.17qcc.com/imagesearch.html` 页面显示已登录，但停留在未提交图片的空结果界面；本轮无法据此判断月度额度是否恢复或结果模板是否可解析。衣衫汇 `https://www.e3hui.com/` 显示已登录且有文件选择控件，但未检查或保存控件中的上传地址，也未上传图片。17网当前打开 `https://gz.17zwd.com/` 货源首页并显示登录入口；`stu.17zwd.com/SearchSimilar` 图搜页未打开，因此当前认证状态未确认。

本轮重新读取 17 网公开 `common.d04f4bf8.js` 与图搜 chunk：`image64Search`、`by_message`、`img_base64` 仍存在；`isGlobal: 4` 对应框架 `Original` 路径模式，使用扩展当前的完整 API action 时不会再附加页面 API 前缀。该公开代码证据支持当前请求地址构造方式，但不证明授权请求在用户会话中成功。

2026-10-19：青创网公开搜图脚本把错误码 `910001` 单独引导到账号认证页；0.3.29 将该错误分类为 `platform_verification`，不自动重试或伪装成无结果。

2026-10-19：在当前已登录青创网搜图页只读检查到官方 `#productlistTmpl`：结果链接为 `//www.17qcc.com/item/{{:ProductId}}.html`；图片由 `Photo` 字段构造 `//pics.17qcc.com/...`；价格在 `.brprice` 中使用 `DefaultPrice`；标题在 `.rowtitle` 中使用 `ProductName`；款号为 `.size` 中的 `ProductNo`。旧适配器仅识别 `/product/detail/{id}`、`.money`、`.number`，因此新模板即使返回结果也会被误判为无法解析。0.3.30 按官方模板解析上述字段，同时兼容旧商品详情路径；browser-test 用复制的官方模板结构验证，不触发真实搜图。

2026-10-20：重新读取衣衫汇官网 `common.js?v=202610140931`：搜图入口在 `.icon-imgseek[data-forbidden]` 为真时明确阻止图片选择；实际页面上传前还要求 `.file-input[data-url]` 非空，随后以 `file` 字段上传并导航到官方结果页。当前匿名公开首页 `.file-input` 的 `data-url` 为空，结果页请求返回“请先登录”，不能验证登录态上传或结果 DOM。0.3.31 检查入口和输入控件的权限标记；明确 forbidden 返回 `platform_permission`，空地址返回 `platform_login_or_permission`，均不绕过平台限制。新回归覆盖禁止与空地址两种状态及衣衫汇平台失败后的手动恢复。

2026-10-20：用户在登录态通过扩展触发衣衫汇图片搜索；当前浏览器实际落地 `https://www.e3hui.cn/purchaser/search?params=...`，页面显示“已为您搜到 50 件相似货源”。只读检查到新结果结构为 `.list-seat li.pro-224`，商品链接 `/product/{id}.html?from=img-search...`，图片 `data-url`、标题 `.info-wrap-hover .name`、价格 `.price`。旧版扩展只接受 `/purchaser/img-search` 与 `#searchPage .pro-list`，将成功结果误判为 `platform_redirect`。0.3.32 接受该新路由并解析模板；新增页面夹具和导航回归测试。用户截图显示运行版本 0.3.30，需刷新扩展后才能验证修复。

0.4.0 image ranking: added Marqo-FashionCLIP through Transformers.js 4.3.1, using the Apache-2.0 quantized ONNX vision weights (~60.1 MB) and local WebGPU inference. Public model benchmarks are not treated as validation for the user's supplier catalog. The UI reports a rank value rather than a probability; handcrafted local features remain an explicitly named fallback. Automated extension tests stub model vectors and exercise fallback; first-use model download and real Edge WebGPU inference remain unverified in this environment.
