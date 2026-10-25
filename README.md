# 未回关筛选

扫描你在 X（Twitter）上的「正在关注」列表，找出**你关注了对方、对方未回关**的账号，方便你逐个手动取关。

> Edge / Chromium 扩展 · 本地运行 · 不上传账号数据

![Edge](https://img.shields.io/badge/Edge-Chromium-0078D7?logo=microsoftedge&logoColor=white)
![Manifest](https://img.shields.io/badge/Manifest-V3-green)
![License](https://img.shields.io/badge/License-MIT-blue)

## 功能

- 打开「正在关注」页后一键扫描未回关账号
- 忽略名单：大 V / 想继续关注的人可加入忽略，不计入待处理
- 定位：缩小页面快速滚动定位到目标用户，再恢复缩放并高亮
- 仅本机存储扫描结果与忽略名单，不经过第三方服务器

## 安装（Edge）

1. 下载本仓库（或 [Releases](../../releases) 里的 zip），解压到任意文件夹  
2. 打开 Edge，地址栏输入 `edge://extensions`  
3. 打开右下角 **开发人员模式**  
4. 点击 **加载解压缩的扩展**，选择解压后的文件夹（需能看到 `manifest.json`）  
5. 打开 [https://x.com](https://x.com) 并登录，点击扩展图标打开侧栏即可使用

更新：覆盖文件夹内文件后，回到 `edge://extensions` 点 **重新加载**，并刷新 x.com。

## 使用

1. 侧栏点击 **打开正在关注**（会跳到当前登录账号的关注列表）  
2. 点 **开始扫描**，等待列表滚动加载完成  
3. 在结果里查看未回关账号；可 **忽略** 或 **定位** 后手动取关  

取关请自行在 X 页面确认，本扩展不会替你点取关。

## 注意

- 仅支持 **电脑版** Microsoft Edge（或其他支持 MV3 侧栏的 Chromium 浏览器）  
- **手机无法安装**此扩展  
- X 页面改版可能导致识别或定位暂时失效，欢迎提 Issue  
- 关注列表很大时扫描会较慢，请保持关注页标签可见  

## 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 保存忽略名单与扫描结果（仅本机） |
| `tabs` / `activeTab` / `scripting` | 打开关注页、注入扫描与定位脚本 |
| `sidePanel` | 侧栏界面 |
| `x.com` / `twitter.com` | 仅在 X 站点运行 |

## 开发

```
no-followback/
├── manifest.json
├── background.js
├── content.js
├── sidepanel.html / .js / .css
├── icons/
└── 安装说明.txt
```

本地修改后在 `edge://extensions` 重新加载即可。

## 隐私

- 不收集、不上传你的 X 账号、关注列表或扫描结果  
- 所有数据仅存在你浏览器的本地 storage  
- 源码开源，可自行审计  

## License

[MIT](./LICENSE)

---

Made for X power users who want a lighter unfollow workflow.
