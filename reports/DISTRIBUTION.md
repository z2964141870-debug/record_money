# 安装

下载入口：[GitHub Releases](https://github.com/z2964141870-debug/record_money/releases/latest)。机器人创建与权限：[飞书](FEISHU.md) / [钉钉](DINGTALK.md)。

## Windows

1. Windows 10 22H2或Windows 11，64位Intel/AMD电脑，下载 `windows-x64.zip`。
2. 先解压整个文件夹，再双击 `RecordMoney.exe`。无需Node、Docker或管理员权限；目前尚未代码签名，首次打开可能有系统安全提示。
3. 浏览器填写机器人和模型配置。创建机器人、开权限及绑定步骤见 [飞书](FEISHU.md) / [钉钉](DINGTALK.md)。存储位置可选择文件夹。

首次打开会创建桌面快捷方式并设置登录自启。关闭网页后继续运行；右下角托盘菜单可打开账本、停止服务或关闭登录自启。睡眠、关机、退出登录或断网会中断。

默认数据位置：`%LOCALAPPDATA%\RecordMoney`。升级时解压新包并打开新版EXE，自动备份并保留配置、账本和聊天；安装成功后，下载的解压文件夹可删除。ARM版Windows暂未单独验收。

## Mac

1. M系列下载 `macos-arm64.zip`，Intel下载 `macos-x64.zip`。要求macOS 14+。
2. 解压，把“私人记账助手.app”拖进应用程序，双击打开。首次打开若被系统拦住，到“系统设置 → 隐私与安全性”确认打开；目前尚未Apple公证。
3. 浏览器配置页选择飞书或钉钉，填写应用ID、Secret、模型URL、API Key和模型名，点击“连接并保存”。存储目录可在高级设置中选择。
4. 按对应机器人教程开权限并发布，私聊发送“绑定账本”，在网页绑定自己。

无需安装Node或使用终端。关闭网页后继续运行，登录后自动启动；合盖、关机、退出登录或断网会中断。

默认数据位置：`~/Library/Application Support/RecordMoney`。新版本打开前会备份，保留账本、配置和聊天。

## Linux / NAS

需要Docker Compose v2，支持Intel/AMD和ARM64。下载 `compose.yaml`，在所在目录运行：

```sh
docker compose up -d
```

打开 <http://127.0.0.1:4317>，填写配置，再按 [飞书](FEISHU.md) 或 [钉钉](DINGTALK.md) 教程创建和绑定机器人。公开镜像自动下载，无需GitHub登录或自行构建。

数据默认在 `compose.yaml` 旁的 `data/docker-storage`。自选目录或端口时，在启动前设置：

```sh
export LEDGER_STORAGE=/absolute/path/record-money
export LEDGER_WEB_PORT=4318
docker compose up -d
```

远程主机默认端口4317时，在自己的电脑运行以下命令，再打开本机4317网页：

```sh
ssh -N -L 4317:127.0.0.1:4317 your-host
```

主机改成4318时，将命令最后的端口改为4318。网页没有登录认证，请保留仅本机访问的端口映射。已有数据目录需允许容器用户UID1000读写。

查看日志：`docker compose logs --tail=100`。停止：`docker compose down`。升级：先备份，换新版compose文件，再执行 `docker compose pull` 和 `docker compose up -d`，沿用原数据目录。

## 备份

网页“设置”可立即备份，程序也会每日备份。文件在存储位置的 `data/backups`，独立副本建议另存硬盘或其他主机。恢复前停止服务，保留SQLite备份及对应附件目录。

源码用户在 `script` 运行 `npm run restore -- /absolute/backup.sqlite`。Docker恢复：`docker compose run --rm ledger npm --prefix /app/script run restore -- /app/storage/data/backups/文件名.sqlite`。

## 源码开发

需要Node.js 24+，在 `script` 执行 `npm ci`、`npm run build`、`npm start`。首次网页配置同上；终端配置可用 `npm run setup`。

测试：`npm test`。源码打包：`npm run release`。Mac打包：`npm run package:mac`，需要Xcode命令行工具。推送 `v*` 标签会自动构建安装包、镜像和GitHub Release。

Mac源码后台安装：`npm run service:install`；停止：`npm run service:stop`；卸载启动项但保留数据：`npm run service:uninstall`。

Windows打包：`npm run package:windows`，在Windows x64运行；安装包验收：`npm run smoke:windows`。模型接口要求见 [模型配置](MODELS.md)。
