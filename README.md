# Grok AI Browser Extension

A browser extension for Chrome/Edge that interacts with xAI's Grok AI (chat.x.ai) and saves conversations to a local SQLite database.

## Architecture

### Backend Service (Python)
- **FastAPI** web server with WebSocket support
- **SQLAlchemy + SQLAlchemyCRUDPlus** for database operations
- **SQLite** local database storage
- WebSocket server for real-time communication with browser extension

### Browser Extension (Manifest V3)
- **Side Panel UI**：主界面固定在浏览器侧栏（交互参考 [ChatHub](https://github.com/chathub-dev/chathub)；本仓库未复制其源码，仅借鉴侧栏 + 点击图标打开的模式）
- **Content Script**：注入 Grok 相关页面并模拟输入与读取回复
- **Background Service**：WebSocket 客户端连接本地 Python 服务
- **标签页管理**：打开并保持 Grok 网页标签页

## Features
- Send questions from backend to Grok AI via browser extension
- Automatically open chat.x.ai and simulate user interactions
- Capture Grok's responses and send back to backend
- Store conversations in local SQLite database
- Real-time communication via WebSocket
- Support for Chrome and Edge browsers

## Database Schema
- `conversations` table with fields: `id`, `question`, `answer`, `created_at`
- Basic conversation tracking without user authentication

## Installation & Usage

### 1. Install Python Dependencies
```bash
pip install -e .
```

### 2. Start Backend Service
```bash
grok-service
# or
python -m grok_service.main
```

### 3. Load Browser Extension
1. Open Chrome/Edge extensions page (`chrome://extensions/` or `edge://extensions/`)
2. Enable "Developer mode"
3. Click "Load unpacked" and select `browser_extension/` directory
4. 点击工具栏扩展图标打开侧栏，配置 WebSocket 并连接

## Project Structure
```
lianmengskill/
├── grok_service/           # Python backend service
│   ├── __init__.py
│   ├── main.py            # FastAPI application entry point
│   ├── database.py        # Database connection and models
│   ├── websocket.py       # WebSocket connection manager
│   ├── models.py          # SQLAlchemy models
│   └── crud.py            # CRUD operations using SQLAlchemyCRUDPlus
├── browser_extension/     # Chrome/Edge extension
│   ├── manifest.json      # Extension manifest
│   ├── sidepanel.html     # Side panel UI (primary)
│   ├── panel.js           # Shared panel logic (connection + status)
│   ├── background.js      # Background service worker
│   ├── content.js         # Content script for Grok pages
│   ├── styles.css         # Styling
│   └── sidepanel.css      # Side panel layout overrides
├── tests/                 # Test suite
├── pyproject.toml         # Project dependencies
└── README.md              # This file
```

## Communication Flow
1. Backend starts WebSocket server on `ws://localhost:8765/ws`
2. Browser extension connects to WebSocket server
3. Backend sends question via WebSocket to extension
4. Extension opens/uses chat.x.ai tab and simulates user input
5. Extension captures Grok's response and sends back via WebSocket
6. Backend saves conversation to SQLite database
7. Response is sent back to original requester

## Development Notes
- Uses WebSocket for real-time bidirectional communication
- Fixed tab approach: maintains single chat.x.ai tab
- Exponential backoff retry (3 attempts) for failed operations
- No authentication required (localhost only)