# 网商园公开前端核对（2026-10-13）

只读取公开 HTML 和页面引用的 JavaScript；没有读取用户 Cookie、没有上传商品图片、没有调用搜索接口。本文件记录当前实现依据，不能证明真实登录态搜索成功。

1. `https://www.wsy.com/new/search/image` 返回 HTTP 200，标题“图片搜索 - 网商园”。页面的 Astro 组件 `ImageGoodsList` 引用 `/_assets/EFgvLxy-rR.js`。
2. `https://www.wsy.com/_assets/EFgvLxy-rR.js` 引用 `/_chunks/CFCmQdzCef.js` 导出的函数 `p`。该导出对应函数 `gr`：`g.post("/jsondata/search/image.json",{base64:e})`。确认方法、路径和请求字段与交接文档一致。
3. ImageGoodsList 将响应 `list` 映射为商品列表，使用 `imgUrl`、`address` 和 `shopid`；接口原始商品字段仍由交接夹具验证，完整实时响应尚未获取。
4. 页面遇到响应 `status==501` 调用登录浮层；`code==403` 提示服务正忙；`code=="UnsupportedPicPixels"` 提示图片尺寸不支持。扩展按相同信号分别提示登录、繁忙和图片尺寸，不当作“没有商品”。
5. 页面加载图片前要求宽、高各在 100～2048 像素。扩展导入时确认原图短边至少 100，最长边压缩到不超过 1200，压缩后短边仍需至少 100；过小和极端狭长图不发送，不补画虚假细节。
6. 页面内部还按短边 300、JPEG质量 0.9 压缩；本扩展采用1200最长边、质量0.9，属于自己的输入处理方案，平台真实接受情况仍待验收。

脚本文件名是部署产物，平台更新后可能变化；本实现不硬编码这些脚本路径、不注入平台内部组件、不绕过登录/验证码。

## 2026-10-19 当前公开实现复核

当前图搜页面仍加载 `ImageGoodsList` 组件 `/_assets/EFgvLxy-rR.js`，该组件调用 `/_chunks/CFCmQdzCef.js` 导出的图片查询函数；函数对 `POST /jsondata/search/image.json` 发送 `{base64}`。页面识别 `status=501` 为登录、`code=403` 为忙碌、`code=UnsupportedPicPixels` 为图片尺寸错误。商品列表组件读取 `mid`、`uid`、`title`、`price`、`imgUrl`、`address`、`shopid`，并通过 `/item.htm?id=...` 打开详情；这些字段与 `core.parseWsy` 的候选映射一致，`probability` 仍按可选字段处理。

官网图搜流程要求每边 100～2048 像素，并在请求前把短边大于 300 的图片缩到短边 300，再转成 JPEG，质量 0.9。0.3.25 起扩展在网商园请求前执行同一尺寸和编码处理，其他平台仍收到工作台原始压缩图。本轮只读取公开 HTML/JavaScript，没有发送搜索图片或查询接口。
