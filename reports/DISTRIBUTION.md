# v0.3 安装与分发

每次部署只绑定一位用户，各自使用自己的飞书应用、模型服务和账本。支持macOS和Linux；Windows可使用Docker Desktop。源码按MIT许可证开放，压缩包是源码安装包，不是免安装的独立可执行程序。

## 本机首次安装

安装Node.js 24+，下载并解压发布包，在解压目录的script中执行：

```sh
npm ci
npm run setup
npm run build
npm start
```

向导填写存储位置（绝对路径）、飞书App ID、App Secret、模型Base URL、API Key、多模态模型名称、推理强度和网页端口。密钥不回显，回车可保留已有值。推理默认none，兼容不接受reasoning参数的模型。URL填写API基础地址，例如https://example.com/v1，不含密钥或/responses。

数据保存为“指定位置/data/config.env、ledger.sqlite、备份与附件等”，日志在“指定位置/logs”。源目录data/runtime-location.txt仅记录存储位置，不能代替账本备份。配置文件权限为600；现有账本不会自动搬到新目录，更换位置会打开另一套账本。

连接测试验证飞书凭证，再调用模型测试一次文字、一次不含私人信息的收据图，费用由用户模型服务收取，不写入账本。暂时离线可跳过，之后运行npm run connections补测。完整飞书配置与绑定见[FEISHU.md](FEISHU.md)。

打开http://127.0.0.1:4317，默认仅本机可访问；如向导修改端口，请使用新端口。程序在终端前台运行，退出或关机即停止。网页“设置 → 模型服务”可更换Base URL、API Key、模型和推理强度，可先测试再保存，下次调用生效且无需重启。API Key留空保留已有值；服务域名或端口变化须填写新密钥。更换服务保留本地对话及账本。飞书凭证修改后仍需重启。模型名称留空时不会自动选择其他供应商。

## Mac后台服务

构建后运行npm run service:install。launchd登录后启动，代码部署到~/Library/Application Support/RecordMoney/script，账本继续使用向导指定的存储位置。再次安装更新代码和启动配置，不覆盖已有config.env或账本。npm run service:stop停止，npm run service:uninstall卸载启动项，保留数据。

更新前建议网页“立即备份”。升级后检查“运行状态”及真实记录。接通电源时caffeinate阻止自动睡眠，合盖、主动睡眠、退出登录、断网和关机仍会中断服务；全天运行推荐服务器/NAS。

## Docker Compose

需要Docker及Compose v2，Linux主机与Apple Silicon均可自行构建。以下命令均在script目录执行：

```sh
docker compose build
docker compose run --rm ledger npm --prefix /app/script run setup
docker compose up -d
docker compose ps
```

默认持久目录是项目data/docker-storage，其中data保存账本和配置、logs供记录使用。容器以node用户（UID 1000）运行，Linux上挂载目录须由UID 1000读写；若提示EACCES，可先仅调整挂载目录权限，再运行向导：

```sh
docker compose run --rm --user root --entrypoint sh ledger -c 'mkdir -p /app/storage/data /app/storage/logs && chown -R 1000:1000 /app/storage'
```

更换目录或端口时，在执行所有Compose命令的同一个终端设置：

```sh
export LEDGER_STORAGE=/absolute/path/record-money
export LEDGER_WEB_PORT=4318
```

也可把上述两个非密钥变量放到script/.env（Git忽略）。容器内部路径固定/app/storage，向导不修改挂载位置。容器内部服务监听0.0.0.0，但Compose只发布到主机127.0.0.1，且后端校验Host与CSRF。不应改成公网端口映射，网页无登录认证。

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

Docker标准输出由容器日志驱动保存并轮转；可用docker compose logs导出到指定位置/logs。升级时先备份，替换源码后docker compose build，再docker compose up -d，持续使用同一个LEDGER_STORAGE。不要删除数据目录。

## 发布源码压缩包

维护者在script目录执行：

```sh
npm ci
npm test
npm run build
npm run release
```

需要zip命令，默认输出data/releases/record-money-v0.3.1.zip和同名.sha256。也可npm run release -- /absolute/output。只按白名单打包代码、配置模板、许可证和可移植文档，data/logs只放空目录；不打包node_modules、构建产物、凭证、运行位置、截图、账本、日志或个人验收记录。源代码目录中的.env、数据库、私钥和明显API密钥会导致打包失败。FILES.sha256记录逐文件摘要，.zip.sha256用于下载校验。

把这两个文件上传到GitHub Releases即可供下载。当前脚本只生成本地包，不自动公开仓库或发布Release。仓库公开前应检查整个Git历史、许可证与文档；Git忽略只防止后续误提交，不能清除已经提交的内容。

## 备份与恢复

每日SQLite备份与附件副本自动保存在data/backups。独立备份应另存到外置硬盘或其他主机，不能只留在运行硬盘。

在对应实例的script目录运行npm run backup；恢复前停止后台服务或容器，运行npm run restore -- /absolute/backup.sqlite，恢复完成再启动。Docker可用docker compose run --rm ledger npm --prefix /app/script run restore -- /app/storage/data/backups/文件名.sqlite。请同时保留备份对应的附件目录，不把备份提交到Git。

## 数据与兼容范围

不连接银行或支付平台抓取账目，不执行金融交易；记录和提醒只依据输入与本地数据。人民币整数分，北京时间。模型调用会发送当前文本、最近会话和相关账本信息；读图会发送上传的图片。请选择自己信任的服务，HTTPS可保护传输。

目前支持Responses API，不支持只有Chat Completions的接口。模型必须支持图片输入和JSON对象输出，推理参数可关闭。便宜模型通过基本连接测试不等于复杂截图准确，见[MODELS.md](MODELS.md)。
