# 私人记账助手

在飞书或钉钉发一句话，就能记账。

不配置 AI 也可用固定格式记账；自然语言和图片功能需要相应模型。

- `奶茶20` → 支出20元，餐饮/饮料。
- `妈妈红包30` → 收入30元。
- `刚才那杯其实18` → 修改上一笔。

支持账单图片识别、退款、资金账户、贷款、物品清单、账单图表和每天20:00催记账。图片先核对，确认后入账。

## 开始用

1. **[下载安装包](https://github.com/z2964141870-debug/record_money/releases/latest)**：Windows解压后打开 `RecordMoney.exe`；Mac解压后打开应用；Linux/NAS下载 `compose.yaml`，执行 `docker compose up -d`。
2. **创建一个机器人**：按 [飞书教程](reports/FEISHU.md) 或 [钉钉教程](reports/DINGTALK.md) 创建应用、开权限并发布。
3. **填写配置**：选择平台，填写应用ID和Secret。选“固定格式”即可用；选“固定格式 + AI”再填模型地址、Key、模型名和接口类型。私聊机器人后，在网页绑定自己。

不需要Agent或Codex账号。支持Responses和Chat Completions接口，读图可选。每套安装绑定一个平台、一位用户，账本保存在自己的电脑。

想用便宜模型，可以考虑阿里云 `qwen3.7-flash`：官方支持读图和结构化输出，北京地域≤32K输入时每百万Token输入/输出为0.2/0.8元（2026-10-06核对，[计费来源](https://help.aliyun.com/zh/model-studio/model-pricing)）。本项目尚未实测该模型，接入后请先测试连接与非敏感样例。

Windows支持Windows 10 22H2/11的64位Intel/AMD电脑。Mac支持macOS 14及以上，M系列和Intel分别下载对应版本。首次打开可能需要系统安全确认。睡眠、合盖可能会中断服务，可调整电源设置；关机后服务停止。全天在线请用服务器或NAS。

[使用说明](reports/README.md) · [安装与服务器部署](reports/DISTRIBUTION.md) · [模型配置](reports/MODELS.md)

开源协议：MIT。代码在 `script`，说明在 `reports`；本机数据在 `data`，日志在 `logs`，均不随安装包发布。
