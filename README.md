# App Launcher 应用启动器

让 AI 助手帮助用户启动 Windows 电脑上的各种应用程序，支持自动扫描桌面快捷方式。

## 快速开始

1. 将 `app_launcher.js` 放入 `live-2d/server-tools/` 目录
2. 在该目录下运行 `npm install iconv-lite`
3. 重启 my-neuro，工具会自动加载

## 功能说明

| 功能 | 说明 |
|------|------|
| 自动扫描桌面 | 首次运行自动扫描用户桌面和公共桌面上的 `.exe`、`.lnk`、`.url` 文件 |
| 启动本地应用 | 支持启动 `.exe` 应用程序 |
| 打开网页链接 | 支持 `http://`、`https://` 网址快捷方式 |
| Steam 游戏 | 支持 `steam://` 协议启动 Steam 游戏 |
| 中文路径 | 正确处理中文路径和中文应用名称 |
| 不区分大小写 | 应用名称匹配不区分大小写 |

## 工具列表

| 工具名 | 说明 |
|--------|------|
| `launch_application` | 根据应用名称启动指定应用程序 |

## 配置文件

- `apps.json`：存储应用名称与路径的映射，首次运行时自动生成，无需手动配置

## 依赖

- [iconv-lite](https://www.npmjs.com/package/iconv-lite) — 处理中文编码
