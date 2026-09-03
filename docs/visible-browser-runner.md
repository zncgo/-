# 本机可见浏览器运行器

懂车帝和知乎会在 Docker 无头浏览器中触发环境验证。项目提供一个仅监听本机回环地址的可见浏览器运行器，供这两个平台使用独立、持久的本机浏览器会话。

首次运行：

```powershell
cd E:\RSSHub
node tools/visible-browser-runner.mjs
```

它会打开一个独立的 Chrome/Edge 资料目录 `.local-browser-profile`。在窗口中登录懂车帝、知乎并完成平台验证；不要关闭运行器终端。

然后让 Docker 调用它：

```powershell
$env:VISIBLE_BROWSER_RUNNER_URL = 'http://host.docker.internal:17321'
docker compose up -d --build ui
```

该运行器不会读取或导出系统浏览器 Cookie，只会在本机保存其自身资料目录。未配置 `VISIBLE_BROWSER_RUNNER_URL` 时，程序保持原有 Docker Browserless 路径不变。
## 使用已导入的 Cookie（默认方式）

运行器会自动从 `E:\更新频率表\cookies` 中读取懂车帝和知乎**最新导入**的 Cookie，并注入到它自己启动的可见 Chrome。它不读取 Chrome/Edge 的系统用户资料，也不会在控制台输出 Cookie 内容。

如需使用其他本地 Cookie 根目录，可在启动前设置：

```powershell
$env:VISIBLE_BROWSER_COOKIE_ROOT = 'D:\your-cookie-folder'
node tools/visible-browser-runner.mjs
```
