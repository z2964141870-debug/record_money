# 私人记账助手

选择飞书或钉钉，通过私聊文字与账单图片管理个人账本，在网页查看资金账户、长期贷款、物品成本和真实账目图表。金额由程序按整数分计算；图片先核对，确认后入账。钉钉目前完成接口模拟验收，尚待实际应用联调。

每个用户独立部署，数据保存在自己指定的位置。支持兼容Responses API、JSON对象输出及图片输入的模型，模型品牌和价格不限。

- [安装、配置与Docker部署](reports/DISTRIBUTION.md)
- [使用说明](reports/README.md)
- [飞书应用配置](reports/FEISHU.md)
- [钉钉应用配置](reports/DINGTALK.md)
- [模型选择与验收](reports/MODELS.md)

## 下载后使用

在[GitHub Releases](https://github.com/z2964141870-debug/record_money/releases/latest)下载对应安装包。

- Mac（macOS 14+）：M系列下载macos-arm64.zip，Intel下载macos-x64.zip。解压后将应用放进“应用程序”，双击打开，在网页选择聊天渠道并填写凭证，点击“连接并保存”。内置运行环境，自动安装登录启动的后台服务。当前未经Apple公证，首次运行可能需系统安全确认。
- Linux/NAS：下载compose.yaml，在所在目录执行docker compose up -d。镜像自动下载，打开http://127.0.0.1:4317完成同一网页配置。需要Docker Compose，无需Node或自行构建；远程访问用SSH转发。

不需要Agent或Codex账号。飞书/钉钉创建应用、权限及发布由平台要求，配置后网页会展示必要步骤并引导绑定本人。每个实例只绑定一个渠道和一位用户，已有实例不通过首次配置切换渠道。

## 源码开发

要求Node.js 24+，本机运行：

```sh
cd script
npm ci
npm run build
npm start
```

网页默认地址：http://127.0.0.1:4317 。Mac合盖或关机会中断服务，需要全天运行时部署到服务器或NAS。

MIT许可证。源码包只含源代码与文档；Mac安装包内含运行环境和生产依赖。所有发布包均不含维护者凭证、账本、聊天、图片或日志。详细依赖许可证见各依赖包；Docker中文字体由Noto提供。
