# 码上 QR Studio

一个完全在浏览器本地运行的二维码生成与解析工具。

## 使用方法

- 在线使用[QR Studio](https://qrcode.mosby.top)。
- 下载代码，双击`index.html`使用。

## 功能解析

- 生成端支持二维码尺寸、容错等级、点阵和定位角样式、颜色/渐变、Logo、PNG 与 SVG 下载。
- 解析端支持点击上传、拖放和粘贴图片，并识别网址、Wi-Fi、电话、邮件、短信、地理位置与 vCard。
- 所有内容和图片都只在当前浏览器内存中处理，不会上传或保存。

## 浏览器支持

推荐使用近期版本的 Chrome、Edge、Firefox 或 Safari。剪贴板写入在部分浏览器的本地文件模式下可能受限，此时工具会自动尝试兼容复制方式。

## 开源依赖

- `qr-code-styling` 1.9.2（MIT License）
- `jsQR` 1.4.0（Apache License 2.0）

浏览器版本的脚本和完整许可证保存在 `vendor/` 目录中，因此工具可离线使用。
