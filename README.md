# Grok AI 浏览器扩展

一个用于 Chrome/Edge 的浏览器扩展，可与 xAI 的 Grok AI（chat.x.ai）交互，并将对话保存到本地 SQLite 数据库。

## 架构说明

### 后端服务（Python）
- 基于 **FastAPI** 的 Web 服务，支持 WebSocket。
- 使用 **SQLAlchemy + SQLAlchemyCRUDPlus** 处理数据库操作。
- 使用 **SQLite** 进行本地数据存储。
- 提供 WebSocket 服务，与浏览器扩展进行实时通信。

### 浏览器扩展（Manifest V3）
- **侧栏界面**：主界面固定在浏览器侧栏（交互参考 [ChatHub](https://github.com/chathub-dev/chathub)；本仓库未复制其源码，仅借鉴“侧栏 + 点击图标打开”的模式）。
- **内容脚本**：注入 Grok 相关页面并模拟输入、读取回复。
- **后台服务**：WebSocket 客户端连接本地 Python 服务。
- **标签页管理**：打开并维持 Grok 网页标签页。

## 功能特性
- 从后端发起问题，通过浏览器扩展发送给 Grok AI。
- 自动打开 chat.x.ai，并模拟用户交互。
- 捕获 Grok 回复并回传后端。
- 将对话记录存储到本地 SQLite 数据库。
- 通过 WebSocket 进行实时通信。
- 支持 Chrome 与 Edge 浏览器。

## 数据库结构
- `conversations` 表字段：`id`、`question`、`answer`、`created_at`。
- 基础对话追踪，不包含用户鉴权。

## 初始化与使用（uv）

### 1. 初始化项目环境并安装依赖
```bash
uv sync
```

### 2. 启动后端服务
```bash
uv run grok-service
# 或
uv run python -m grok_service.main
```

### 3. 加载浏览器扩展
1. 打开 Chrome/Edge 扩展页面（`chrome://extensions/` 或 `edge://extensions/`）。
2. 启用“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择 `browser_extension/` 目录。
4. 点击工具栏扩展图标打开侧栏，配置 WebSocket 并连接。

## 项目结构
```text
lianmengskill/
├── grok_service/           # Python 后端服务
│   ├── __init__.py
│   ├── main.py             # FastAPI 应用入口
│   ├── database.py         # 数据库连接与模型定义
│   ├── websocket.py        # WebSocket 连接管理
│   ├── models.py           # SQLAlchemy 数据模型
│   └── crud.py             # 基于 SQLAlchemyCRUDPlus 的 CRUD 操作
├── browser_extension/      # Chrome/Edge 浏览器扩展
│   ├── manifest.json       # 扩展清单文件
│   ├── sidepanel.html      # 侧栏主界面
│   ├── panel.js            # 共用面板逻辑（连接 + 状态）
│   ├── background.js       # 后台 Service Worker
│   ├── content.js          # Grok 页面内容脚本
│   ├── styles.css          # 样式文件
│   └── sidepanel.css       # 侧栏布局覆盖样式
├── tests/                  # 测试目录
├── pyproject.toml          # 项目依赖配置
└── README.md               # 项目说明文档
```

## 通信流程
1. 后端在 `ws://localhost:8765/ws` 启动 WebSocket 服务。
2. 浏览器扩展连接该 WebSocket 服务。
3. 后端通过 WebSocket 向扩展发送问题。
4. 扩展打开或复用 chat.x.ai 标签页并模拟输入。
5. 扩展捕获 Grok 回复并通过 WebSocket 回传。
6. 后端将对话保存到 SQLite 数据库。
7. 后端将结果返回给原始请求方。

## 开发说明
- 采用 WebSocket 实现实时双向通信。
- 使用固定标签页策略：维持单一 chat.x.ai 标签页。
- 对失败操作采用指数退避重试（最多 3 次）。
- 仅限本地环境使用，不需要额外鉴权。