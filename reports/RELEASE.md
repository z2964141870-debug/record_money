# v0.6.0

不配置AI也能记账：`支出 20 餐饮 奶茶`。自然语言可选Responses或Chat Completions，读图按模型能力启用。升级保留账本、配置和聊天。

## 下载与配置

- **Windows 10/11 x64**：解压`record-money-v0.6.0-windows-x64.zip`，打开`RecordMoney.exe`。
- **Mac**：M系列选`macos-arm64.zip`，Intel选`macos-x64.zip`，解压后打开应用，要求macOS 14+。
- **Linux/NAS**：下载`compose.yaml`，执行`docker compose up -d`，打开<http://127.0.0.1:4317>。

先按[飞书机器人教程与权限](https://github.com/z2964141870-debug/record_money/blob/v0.6.0/reports/FEISHU.md)或[钉钉机器人教程与权限](https://github.com/z2964141870-debug/record_money/blob/v0.6.0/reports/DINGTALK.md)创建并发布应用；这两份教程也附在Release里。

填写应用ID、Secret，选“固定格式”或“固定格式 + AI”。私聊机器人后在网页绑定自己。[命令表](https://github.com/z2964141870-debug/record_money/blob/v0.6.0/reports/README.md) · [模型配置](https://github.com/z2964141870-debug/record_money/blob/v0.6.0/reports/MODELS.md)

源码ZIP供开发，`.sha256`供校验。安装包未公证/签名，首次打开可能有系统安全提示；电脑睡眠或关机会中断服务。

## 验证范围

自动测试、Mac独立安装、Linux容器、Windows原生安装包验收及现有模型关闭思考后的标准样例通过。Qwen候选尚无凭证，未实测；新版无模型的真实飞书/钉钉入站仍待人工验收，接口模拟已覆盖。Windows首次安全提示、快捷方式、自启和文件夹对话框尚未人工验收。[完整记录](https://github.com/z2964141870-debug/record_money/blob/v0.6.0/reports/VALIDATION.md)
