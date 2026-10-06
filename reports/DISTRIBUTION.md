# v0.4 安装与分发

每次部署只绑定一个聊天渠道和一位用户，各自使用自己的飞书或钉钉应用、模型服务和账本。优先支持macOS和Linux，Windows原生安装暂缓。源码按MIT许可证开放。

## 普通Mac用户

在GitHub Releases下载对应CPU的Mac安装包：Apple Silicon/M系列选择macos-arm64.zip，Intel选择macos-x64.zip。支持macOS 14及以上。

1. 解压，将“私人记账助手.app”拖到应用程序，双击打开。
2. 浏览器自动打开首次配置页，选择飞书或钉钉，填写应用ID/Secret、模型Base URL/API Key/多模态模型名称，点击“连接并保存”。默认存储位置和推理强度已填好；需要自选存储目录时展开高级设置，点击文件夹图标。
3. 按网页提示完成聊天平台的机器人能力、权限、事件和发布，首次私聊后核对待绑定用户并点击绑定。

应用内置Node与生产依赖，无需安装Node、npm或编译器。自动安装本人登录启动的后台服务，关闭网页仍继续运行。默认存储目录~/Library/Application Support/RecordMoney。后台运行代码位于该目录desktop/版本，不修改应用程序包；新版本第一次打开会备份已有账本，更新启动项并保留配置、数据及历史。服务启动失败时恢复原启动项。

当前包只有本地签名，未经Apple公证。下载后首次打开可能需要在系统设置“隐私与安全性”允许打开。正式Developer ID签名与公证需要维护者的Apple开发者账号，尚未配置；不会禁用Gatekeeper。支持Mac双击安装不代表已取得Apple公证。

## 本机首次安装

安装Node.js 24+，下载并解压发布包，在解压目录的script中执行：

```sh
npm ci
npm run build
npm start
```

启动后浏览器打开首次配置页，同Mac安装步骤。源码用户也可用npm run setup在终端配置存储位置、聊天渠道和凭证。密钥不回显，回车可保留已有值。推理默认none，兼容不接受reasoning参数的模型。URL填写API基础地址，例如https://example.com/v1，不含密钥或/responses。

数据保存为“指定位置/data/config.env、ledger.sqlite、备份与附件等”，日志在“指定位置/logs”。源目录data/runtime-location.txt仅记录存储位置，不能代替账本备份。配置文件权限为600；现有账本不会自动搬到新目录，更换位置会打开另一套账本。

连接测试验证飞书凭证，再调用模型测试一次文字、一次不含私人信息的收据图，费用由用户模型服务收取，不写入账本。暂时离线可跳过，之后运行npm run connections补测。完整飞书配置与绑定见[FEISHU.md](FEISHU.md)。

打开http://127.0.0.1:4317，默认仅本机可访问；如向导修改端口，请使用新端口。程序在终端前台运行，退出或关机即停止。网页“设置 → 模型服务”可更换Base URL、API Key、模型和推理强度，可先测试再保存，下次调用生效且无需重启。API Key留空保留已有值；服务域名或端口变化须填写新密钥。更换服务保留本地对话及账本。飞书凭证修改后仍需重启。模型名称留空时不会自动选择其他供应商。

## Mac后台服务

构建后运行npm run service:install。launchd登录后启动，代码部署到~/Library/Application Support/RecordMoney/script，账本继续使用向导指定的存储位置。再次安装更新代码和启动配置，不覆盖已有config.env或账本。npm run service:stop停止，npm run service:uninstall卸载启动项，保留数据。

更新前建议网页“立即备份”。升级后检查“运行状态”及真实记录。接通电源时caffeinate阻止自动睡眠，合盖、主动睡眠、退出登录、断网和关机仍会中断服务；全天运行推荐服务器/NAS。

## Docker Compose

需要Docker及Compose v2，镜像支持linux/amd64和linux/arm64。下载GitHub Release的compose.yaml，在其所在目录执行：

```sh
docker compose up -d
```

首次运行自动下载ghcr.io/z2964141870-debug/record_money:0.4.0，无需构建或终端配置向导。打开http://127.0.0.1:4317完成网页配置。默认持久目录是compose文件旁的data/docker-storage，其中data保存账本和配置、logs供记录使用。启动入口以root仅准备挂载目录，再以node用户（UID 1000）运行服务；不递归修改原有文件权限。复用旧目录时，原有账本和配置仍须允许UID 1000读写。

更换目录或端口时，在执行所有Compose命令的同一个终端设置：

```sh
export LEDGER_STORAGE=/absolute/path/record-money
export LEDGER_WEB_PORT=4318
```

也可把上述两个非密钥变量放到compose文件旁的.env（Git忽略）。容器内部路径固定/app/storage，网页中存储位置只读，外部路径由挂载指定。容器内部服务监听0.0.0.0，但Compose只发布到主机127.0.0.1，且后端校验Host与CSRF。不应改成公网端口映射，网页无登录认证。

主机端口改为4318后，本机访问http://127.0.0.1:4318。远程管理通过SSH将本机4317转发到主机4318，然后访问本机4317：

```sh
ssh -N -L 4317:127.0.0.1:4318 your-host
```

原端口4317时转发到主机4317。更改LEDGER_WEB_PORT只解决端口占用，不改变容器内的PORT。

```sh
docker compose logs --tail=100
docker compose exec ledger npm --prefix /app/script run connections
docker compose exec ledger npm --prefix /app/script run backup
docker compose down
```

Docker标准输出由容器日志驱动保存并轮转；可用docker compose logs导出到指定位置/logs。升级时先备份，下载新版compose.yaml，在同一目录执行docker compose pull及docker compose up -d，持续使用同一个LEDGER_STORAGE。不要删除数据目录。源码自行构建可用docker build -f script/Dockerfile -t record-money:local .，再将compose镜像改为record-money:local。

## 发布源码压缩包

维护者在script目录执行：

```sh
npm ci
npm test
npm run build
npm run release
```

需要zip命令，默认输出data/releases/record-money-v0.4.0.zip和同名.sha256。也可npm run release -- /absolute/output。只按白名单打包代码、配置模板、许可证和可移植文档，data/logs只放空目录；源码包不打包node_modules、构建产物、凭证、运行位置、截图、账本、日志或个人验收记录。源代码目录中的.env、数据库、私钥和明显API密钥会导致打包失败。FILES.sha256记录逐文件摘要，.zip.sha256用于下载校验。

Mac维护者可运行npm run package:mac构建本机架构的预构建应用包，只从白名单代码和新安装的生产依赖构建，绝不复制开发数据。构建需要Xcode命令行工具，使用官方Node发行版（仅依赖系统动态库）。用户无需这些工具。

.github/workflows/release.yml在推送v*版本标签后，自动测试、构建源码包、Apple Silicon和Intel安装包及两架构Docker镜像。全部成功后创建GitHub Release，附安装包、源码、校验和与compose.yaml；Docker发布到GHCR。需要仓库允许GitHub Actions，任务用仓库GITHUB_TOKEN，不需要额外存储个人发布密钥。新GHCR包首次发布后需检查公开可见性，确认匿名用户可以拉取。仓库公开前应检查整个Git历史；Git忽略不能清除已经提交的内容。

## 备份与恢复

每日SQLite备份与附件副本自动保存在data/backups。独立备份应另存到外置硬盘或其他主机，不能只留在运行硬盘。

在对应实例的script目录运行npm run backup；恢复前停止后台服务或容器，运行npm run restore -- /absolute/backup.sqlite，恢复完成再启动。Docker可用docker compose run --rm ledger npm --prefix /app/script run restore -- /app/storage/data/backups/文件名.sqlite。请同时保留备份对应的附件目录，不把备份提交到Git。

## 数据与兼容范围

不连接银行或支付平台抓取账目，不执行金融交易；记录和提醒只依据输入与本地数据。人民币整数分，北京时间。模型调用会发送当前文本、最近会话和相关账本信息；读图会发送上传的图片。请选择自己信任的服务，HTTPS可保护传输。

目前支持Responses API，不支持只有Chat Completions的接口。模型必须支持图片输入和JSON对象输出，推理参数可关闭。便宜模型通过基本连接测试不等于复杂截图准确，见[MODELS.md](MODELS.md)。
