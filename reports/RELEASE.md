# v0.6.1

Mac开盖后立即触发飞书重连，网络恢复后自动补收离线消息。按原消息编号去重，疑似重复留待核对。升级保留账本、配置和聊天。

## 下载与配置

- **Windows 10/11 x64**：解压`record-money-v0.6.1-windows-x64.zip`，打开`RecordMoney.exe`。
- **Mac**：M系列选`macos-arm64.zip`，Intel选`macos-x64.zip`，解压后打开应用，要求macOS 14+。
- **Linux/NAS**：下载`compose.yaml`，执行`docker compose up -d`，打开<http://127.0.0.1:4317>。

先按[飞书机器人教程与权限](https://github.com/z2964141870-debug/record_money/blob/v0.6.1/reports/FEISHU.md)或[钉钉机器人教程与权限](https://github.com/z2964141870-debug/record_money/blob/v0.6.1/reports/DINGTALK.md)创建并发布应用；这两份教程也附在Release里。

填写应用ID、Secret，选“固定格式”或“固定格式 + AI”。私聊机器人后在网页绑定自己。[命令表](https://github.com/z2964141870-debug/record_money/blob/v0.6.1/reports/README.md) · [模型配置](https://github.com/z2964141870-debug/record_money/blob/v0.6.1/reports/MODELS.md)

源码ZIP供开发，`.sha256`供校验。安装包未公证/签名，首次打开可能有系统安全提示；睡眠期间暂停处理，关机后需重新启动。自动补收目前仅支持飞书。

## 验证范围

81项本机测试、Mac安装包及真实飞书历史接口通过。唤醒重连与补收流程已模拟验收，真实合盖验收见[验证记录](https://github.com/z2964141870-debug/record_money/blob/codex/feishu-ledger-v0.1/reports/VALIDATION.md)。Windows安全提示、自启及文件夹对话框仍待人工验收。
