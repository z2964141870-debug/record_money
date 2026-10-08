# v0.8.0

新增截图持仓与每天14:30理财分析。可选短期波段、长期定投或控制风险，报告在网页保存并可推送机器人。净值和ETF参考注明时间，建议不自动下单。[基金说明](https://github.com/z2964141870-debug/record_money/blob/v0.8.0/reports/FUNDS.md) · [分析说明](https://github.com/z2964141870-debug/record_money/blob/v0.8.0/reports/INVESTMENT_REVIEW.md)

## 下载与配置

- **Windows 10/11 x64**：解压`record-money-v0.8.0-windows-x64.zip`，打开`RecordMoney.exe`。
- **Mac**：M系列选`macos-arm64.zip`，Intel选`macos-x64.zip`，解压后打开应用，要求macOS 14+。
- **Linux/NAS**：下载`compose.yaml`，执行`docker compose up -d`，打开<http://127.0.0.1:4317>。

先按[飞书机器人教程与权限](https://github.com/z2964141870-debug/record_money/blob/v0.8.0/reports/FEISHU.md)或[钉钉机器人教程与权限](https://github.com/z2964141870-debug/record_money/blob/v0.8.0/reports/DINGTALK.md)创建并发布应用；教程与基金、理财分析说明都附在Release里。

填写应用ID、Secret，选“固定格式”或“固定格式 + AI”。私聊机器人后在网页绑定自己。[命令表](https://github.com/z2964141870-debug/record_money/blob/v0.8.0/reports/README.md) · [模型配置](https://github.com/z2964141870-debug/record_money/blob/v0.8.0/reports/MODELS.md)

源码ZIP供开发，`.sha256`供校验。安装包未公证/签名，首次打开可能有系统安全提示；睡眠期间暂停处理，关机后需重新启动。自动补收目前仅支持飞书。

## 验证范围

升级保留账本、配置和对话。全天准点分析需要电脑或服务器持续在线。[验证记录](https://github.com/z2964141870-debug/record_money/blob/codex/feishu-ledger-v0.1/reports/VALIDATION.md)。Windows安全提示、自启及文件夹对话框仍待人工验收。
