# 钉钉接入

本版提供飞书或钉钉二选一的安装配置，每个实例只绑定一位用户。钉钉采用官方dingtalk-stream SDK的Stream模式，无需公网回调地址或自己配置HTTPS域名。

1. 打开https://open-dev.dingtalk.com/，创建企业内部应用，复制Client ID（AppKey）与Client Secret（AppSecret）。
2. 在应用能力中添加机器人，填写名称与信息，消息接收模式选择Stream。
3. 打开记账助手，将聊天渠道选为“钉钉”，填入应用及模型服务凭证，点击“连接并保存”。凭证测试验证accessToken，不代表已获得所有消息权限。
4. 在应用权限管理中确认企业内机器人发消息权限（qyapi_robot_sendmsg，包括机器人消息文件下载）和基本权限（qyapi_base，包括媒体上传），创建并发布版本，可用范围选择“仅我可见”。钉钉平台的首次版本号至少1.0.0，与本项目代码版本号分别管理。权限名称可能随后台版本变化，以对应接口的当前文档为准。
5. 在钉钉搜索机器人并私聊发送“绑定账本”，回到记账助手核对待绑定用户，点击“绑定此用户”。此消息只用于发现用户，不入账；收到绑定回执后可开始使用。

文字、图片、确认方案、资金账户、贷款、物品、提醒和图表使用同一账本逻辑。群聊消息、语音、普通Webhook群机器人不在本版支持范围内。绑定用户以dingtalk:用户ID保存，消息ID按渠道区分，群消息和其他用户消息不会入账。

主动账单和催记账使用机器人单聊批量发送接口，不依赖会话Webhook的临时有效期。文字模板sampleText，图片模板sampleImageMsg，媒体图片上传取得media_id后发送。图片下载采用机器人文件下载接口与downloadCode。网络或权限失败保留消息或发送队列，可在运行状态查看和重试。

2026-10-06真实应用联调已验证Stream连接、本人绑定、文字20元记账及连续对话改为18元、支出查询、媒体上传、三种图表与定时提醒实际接收，以及服务重启后绑定和账本保留。收图、下载和图片确认入账仍待验收，不应把“凭证有效”当作功能均已验收。建议先用虚构收支及非私人收据，核对回执和网页记录后再记真实账目。

联调发现的来源标签问题已在后续源码修复：新增收支与退款依据消息渠道标为dingtalk、feishu或web-chat。v0.4.0已发布安装包仍是发布时的代码，不包含这一后续修复。

官方参考：

- https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs
- https://open.dingtalk.com/document/orgapp/obtain-the-access_token-of-an-internal-app
- https://open.dingtalk.com/document/orgapp/robot-batch-send-single-chat-messages
- https://open.dingtalk.com/document/orgapp/download-the-file-content-of-the-robot-receiving-message

更换渠道不是网页模型设置：已有实例的所有者绑定不能切换，应使用独立数据目录部署另一实例，避免跨渠道用户身份混淆。
