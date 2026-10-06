# 钉钉接入

本版提供飞书或钉钉二选一的安装配置，每个实例只绑定一位用户。钉钉采用官方dingtalk-stream SDK的Stream模式，无需公网回调地址或自己配置HTTPS域名。

1. 打开https://open-dev.dingtalk.com/，创建企业内部应用，复制Client ID（AppKey）与Client Secret（AppSecret）。
2. 在应用能力中添加机器人，填写名称与信息，消息接收模式选择Stream。
3. 打开记账助手，将聊天渠道选为“钉钉”，填入应用及模型服务凭证，点击“连接并保存”。凭证测试验证accessToken，不代表已获得所有消息权限。
4. 在应用权限管理中开通机器人发送单聊消息、机器人下载消息文件以及媒体上传所需权限，创建并发布版本，可用范围仅选择本人。权限名称可能随后台版本变化，以对应接口的当前文档为准。
5. 在钉钉搜索机器人并私聊发送“绑定账本”，回到记账助手核对待绑定用户，点击“绑定此用户”。此消息只用于发现用户，不入账；收到绑定回执后可开始使用。

文字、图片、确认方案、资金账户、贷款、物品、提醒和图表使用同一账本逻辑。群聊消息、语音、普通Webhook群机器人不在本版支持范围内。绑定用户以dingtalk:用户ID保存，消息ID按渠道区分，群消息和其他用户消息不会入账。

主动账单和催记账使用机器人单聊批量发送接口，不依赖会话Webhook的临时有效期。文字模板sampleText，图片模板sampleImageMsg，媒体图片上传取得media_id后发送。图片下载采用机器人文件下载接口与downloadCode。网络或权限失败保留消息或发送队列，可在运行状态查看和重试。

代码接入及虚构接口测试完成；维护者尚未提供实际钉钉应用，真实Stream、收图、发图和主动发送需在你的应用验收。不应把“凭证有效”当作功能均已验收。建议先用虚构收支及非私人收据，核对回执和网页记录后再记真实账目。

官方参考：

- https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs
- https://open.dingtalk.com/document/orgapp/obtain-the-access_token-of-an-internal-app
- https://open.dingtalk.com/document/orgapp/robot-batch-send-single-chat-messages
- https://open.dingtalk.com/document/orgapp/download-the-file-content-of-the-robot-receiving-message

更换渠道不是网页模型设置：已有实例的所有者绑定不能切换，应使用独立数据目录部署另一实例，避免跨渠道用户身份混淆。
