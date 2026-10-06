# 私人记账助手

在飞书或钉钉发一句话，就能记账。

- `奶茶20` → 支出20元，餐饮/饮料。
- `妈妈红包30` → 收入30元。
- `刚才那杯其实18` → 修改上一笔。

支持账单图片识别、退款、资金账户、贷款、物品清单、账单图表和每天20:00催记账。图片先核对，确认后入账。

## 开始用

1. **[下载安装包](https://github.com/z2964141870-debug/record_money/releases/latest)**：Mac解压后打开应用；Linux/NAS下载 `compose.yaml`，执行 `docker compose up -d`。
2. **创建一个机器人**：按 [飞书教程](reports/FEISHU.md) 或 [钉钉教程](reports/DINGTALK.md) 创建应用、开权限并发布。
3. **填写配置**：打开记账助手，选择平台，填写应用ID、Secret、模型服务地址、API Key和模型名。私聊机器人后，在网页绑定自己。

不需要Agent或Codex账号。模型需要支持Responses接口和图片输入。每套安装绑定一个平台、一位用户，账本保存在自己的电脑。

Mac支持macOS 14及以上，M系列和Intel分别下载对应版本。首次打开可能需要系统安全确认。合盖、关机后服务会可能会中断，可以做一些设置。全天在线请用服务器或NAS。

[使用说明](reports/README.md) · [安装与服务器部署](reports/DISTRIBUTION.md) · [模型配置](reports/MODELS.md)

开源协议：MIT。代码在 `script`，说明在 `reports`；本机数据在 `data`，日志在 `logs`，均不随安装包发布。
