# v0.5.0

飞书或钉钉聊天记账，支持读图、退款、资金账户、贷款、物品清单、三种账单图表和定时提醒。

## 安装

- **Windows 10/11 x64**：下载 `record-money-v0.5.0-windows-x64.zip`，解压后双击 `RecordMoney.exe`。
- **Mac M系列**：下载 `record-money-v0.5.0-macos-arm64.zip`。
- **Intel Mac**：下载 `record-money-v0.5.0-macos-x64.zip`。
- **Linux/NAS**：下载 `compose.yaml`，执行 `docker compose up -d`。

Windows和Mac内置运行环境，无需Node、Docker或终端。Windows支持10 22H2/11的Intel/AMD电脑，首次打开自动创建桌面快捷方式；Mac支持macOS 14+。安装包尚未代码签名或Apple公证，首次打开可能有系统安全提示。[详细安装步骤](https://github.com/z2964141870-debug/record_money/blob/codex/feishu-ledger-v0.1/reports/DISTRIBUTION.md)。

## 创建机器人

选择一个平台，照着教程创建应用、开通权限、发布，再把凭证填进记账助手。

- **[飞书机器人教程](https://github.com/z2964141870-debug/record_money/blob/codex/feishu-ledger-v0.1/reports/FEISHU.md)**：自建应用、机器人能力、消息与图片权限、长连接事件。
- **[钉钉机器人教程](https://github.com/z2964141870-debug/record_money/blob/codex/feishu-ledger-v0.1/reports/DINGTALK.md)**：企业内部应用、Stream模式、发送与图片权限。

下方附件 `FEISHU.md`、`DINGTALK.md` 也可单独下载。

再填模型服务地址、API Key和模型名。模型需支持Responses和图片输入，不需要Agent或Codex账号。私聊机器人发送“绑定账本”，在网页确认绑定后开始记账。

`record-money-v0.5.0.zip` 是开发用源码包；`.sha256` 是校验文件。账本和密钥保存在本机，电脑睡眠或关机会中断服务。

本版新增Windows安装包、登录自启与托盘菜单，升级前自动备份。[版本记录](https://github.com/z2964141870-debug/record_money/blob/codex/feishu-ledger-v0.1/reports/CHANGELOG.md)。
