# MiMo Token Plan 用量汇总面板

聚合管理多个小米 MiMo 账号的 Token Plan 使用额度的可视化界面。

## 功能

- **🚀 一键登录** — 点击按钮弹出浏览器窗口，登录小米账号即可自动获取 Cookie 和全部数据
- **多账号管理** — 添加、编辑、删除多个 MiMo 账号
- **汇总统计** — 顶部卡片展示总账号数、总用量、总余额、总价值
- **图表分析** — 环形图、柱状图、堆叠图、使用率横向图
- **对比总览** — 表格形式对比所有账号的关键指标
- **数据导入/导出** — JSON 格式一键备份与恢复
- **自动刷新** — 存储 Cookie 后可随时一键刷新

## 快速开始

```bash
# 1. 安装依赖
npm install playwright-core

# 2. 启动代理服务器
node server.js

# 3. 打开浏览器访问
# http://localhost:3456
```

## 添加账号

### 方式一：一键登录（推荐）

1. 点击面板上的「🚀 登录账号」按钮
2. 系统自动弹出浏览器窗口，打开 MiMo 登录页面
3. 输入小米账号密码登录
4. 登录成功后自动获取 Cookie 和所有数据
5. 面板自动显示新账号，无需手动操作

### 方式二：控制台脚本（备用）

1. 在浏览器中打开 [MiMo plan-manage 页面](https://platform.xiaomimimo.com/console/plan-manage)
2. 按 `F12` → `Console`，粘贴面板「设置」页面中的脚本执行
3. 回到面板点击「📥 从服务器拉取」

### 方式三：手动输入

从 plan-manage 页面手动读取数据，在面板中选择「手动添加」。

## 已验证的 MiMo API 端点

| 端点 | 说明 |
|------|------|
| `/api/v1/userProfile` | 用户信息（userId, email） |
| `/api/v1/tokenPlan/detail` | Plan 详情（planName, planCode, 到期时间, 自动续费） |
| `/api/v1/tokenPlan/usage` | 用量数据（used, limit, percent） |
| `/api/v1/tokenPlan/apiKey` | API Key 信息 |
| `/api/v1/tokenPlan/list` | 所有可选套餐列表 |
| `/api/v1/balance` | 账户余额（现金 + 赠送） |

## 文件结构

```
Mimo-Token-Usage/
├── index.html       # 主面板（纯前端）
├── server.js        # Node.js 代理服务器（CORS + Cookie + 认证）
├── auth.js          # Playwright 浏览器自动登录模块
├── accounts.json    # 账号数据持久化
├── package.json     # 依赖配置
└── README.md
```

## 定价参考

| 模型 | 输入（缓存命中） | 输入（未命中） | 输出 |
|------|-----------------|---------------|------|
| mimo-v2.5-pro / mimo-v2-pro | ¥1.40/M | ¥7.00/M | ¥21.00/M |
| mimo-v2.5 | ¥0.56/M | ¥2.80/M | ¥14.00/M |
| mimo-v2-flash | ¥0.07/M | ¥0.70/M | ¥2.10/M |
