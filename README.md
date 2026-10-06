# 私人记账助手

通过飞书私聊文字与账单图片管理个人账本，在网页查看资金账户、长期贷款、物品成本和真实账目图表。金额由程序按整数分计算；图片先核对，确认后入账。

每个用户独立部署，数据保存在自己指定的位置。支持兼容Responses API、JSON对象输出及图片输入的模型，模型品牌和价格不限。

- [安装、配置与Docker部署](reports/DISTRIBUTION.md)
- [使用说明](reports/README.md)
- [飞书应用配置](reports/FEISHU.md)
- [模型选择与验收](reports/MODELS.md)

要求Node.js 24+，或Docker Compose。本机安装：

```sh
cd script
npm ci
npm run setup
npm run build
npm start
```

网页默认地址：http://127.0.0.1:4317 。Mac合盖或关机会中断服务，需要全天运行时部署到服务器或NAS。

MIT许可证。发布包仅含源代码、配置模板及文档，不含开发者凭证、账本、聊天、图片、日志或node_modules。详细依赖许可证见各依赖包；Docker中文字体由Noto提供。
