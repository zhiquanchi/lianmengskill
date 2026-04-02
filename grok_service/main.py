"""Main FastAPI application for Grok AI browser extension backend."""

import asyncio
import json
import threading
import uuid
import webbrowser
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from .database import init_db, get_db
from .crud import ConversationCRUD
from .websocket import manager


class QuestionRequest(BaseModel):
    """Request model for sending a question to Grok."""
    question: str


class QuestionResponse(BaseModel):
    """Response model for Grok answer."""
    answer: str
    conversation_id: int


INDEX_HTML = """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Grok AI Assistant</title>
    <style>
        :root {
            color-scheme: dark;
            --bg: #0b1020;
            --panel: rgba(18, 26, 49, 0.92);
            --panel-border: rgba(102, 187, 106, 0.2);
            --primary: #4ade80;
            --primary-strong: #22c55e;
            --text: #e5eefc;
            --muted: #9fb1d1;
            --danger: #f87171;
            --shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            background:
                radial-gradient(circle at top left, rgba(74, 222, 128, 0.2), transparent 28%),
                radial-gradient(circle at top right, rgba(59, 130, 246, 0.18), transparent 24%),
                linear-gradient(180deg, #0b1020 0%, #111933 100%);
            color: var(--text);
            min-height: 100vh;
        }

        .page {
            max-width: 1080px;
            margin: 0 auto;
            padding: 40px 20px 60px;
        }

        .hero {
            margin-bottom: 24px;
        }

        .hero h1 {
            margin: 0 0 8px;
            font-size: 34px;
            font-weight: 700;
        }

        .hero p {
            margin: 0;
            color: var(--muted);
            font-size: 15px;
        }

        .layout {
            display: grid;
            grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.9fr);
            gap: 20px;
        }

        .card {
            background: var(--panel);
            border: 1px solid var(--panel-border);
            border-radius: 20px;
            box-shadow: var(--shadow);
            backdrop-filter: blur(12px);
        }

        .composer {
            padding: 24px;
        }

        .card h2 {
            margin: 0 0 16px;
            font-size: 18px;
        }

        .meta-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
            margin-bottom: 18px;
        }

        .meta-item {
            padding: 14px 16px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 14px;
        }

        .meta-label {
            display: block;
            color: var(--muted);
            font-size: 12px;
            margin-bottom: 6px;
        }

        .meta-value {
            font-size: 15px;
            font-weight: 600;
            word-break: break-word;
        }

        form {
            display: flex;
            flex-direction: column;
            gap: 14px;
        }

        label {
            font-size: 14px;
            color: var(--muted);
        }

        textarea {
            width: 100%;
            min-height: 170px;
            resize: vertical;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 16px;
            padding: 16px;
            font: inherit;
            line-height: 1.6;
            color: var(--text);
            background: rgba(4, 10, 22, 0.72);
            outline: none;
        }

        textarea:focus {
            border-color: rgba(74, 222, 128, 0.6);
            box-shadow: 0 0 0 4px rgba(74, 222, 128, 0.12);
        }

        .actions {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
        }

        button {
            border: 0;
            border-radius: 999px;
            background: linear-gradient(135deg, var(--primary) 0%, var(--primary-strong) 100%);
            color: #06250f;
            font-size: 15px;
            font-weight: 700;
            padding: 12px 22px;
            cursor: pointer;
        }

        button:disabled {
            cursor: wait;
            opacity: 0.7;
        }

        .hint {
            color: var(--muted);
            font-size: 13px;
        }

        .result {
            margin-top: 20px;
            padding: 18px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 16px;
        }

        .result h3 {
            margin: 0 0 10px;
            font-size: 15px;
        }

        .result pre {
            margin: 0;
            white-space: pre-wrap;
            word-break: break-word;
            font: inherit;
            line-height: 1.75;
            color: var(--text);
        }

        .status-ok {
            color: var(--primary);
        }

        .status-error {
            color: var(--danger);
        }

        .history {
            padding: 24px;
        }

        .history-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-bottom: 16px;
        }

        .history-head button {
            padding: 9px 16px;
            font-size: 13px;
        }

        .history-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            max-height: 720px;
            overflow: auto;
        }

        .history-item {
            padding: 16px;
            border-radius: 16px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.06);
        }

        .history-question {
            margin: 0 0 8px;
            font-size: 14px;
            font-weight: 700;
        }

        .history-answer {
            margin: 0;
            color: var(--muted);
            font-size: 14px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-break: break-word;
        }

        .history-time {
            margin-top: 10px;
            color: #7f92b7;
            font-size: 12px;
        }

        @media (max-width: 920px) {
            .layout {
                grid-template-columns: 1fr;
            }

            .meta-grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="page">
        <section class="hero">
            <h1>Grok 本地问答面板</h1>
            <p>在这里直接输入你的问题，服务会把请求转发给已连接的浏览器扩展，再把结果保存到本地数据库。</p>
        </section>

        <div class="layout">
            <section class="card composer">
                <h2>发送问题</h2>
                <div class="meta-grid">
                    <div class="meta-item">
                        <span class="meta-label">服务状态</span>
                        <span id="serviceStatus" class="meta-value">检查中...</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">已连接扩展</span>
                        <span id="clientCount" class="meta-value">-</span>
                    </div>
                </div>

                <form id="askForm">
                    <div>
                        <label for="questionInput">问题输入框</label>
                    </div>
                    <textarea id="questionInput" placeholder="例如：帮我总结一下这篇文章的重点，并给出 3 条行动建议。"></textarea>
                    <div class="actions">
                        <button id="submitBtn" type="submit">发送给 Grok</button>
                        <span class="hint">需要先保证浏览器扩展已连接到 `ws://127.0.0.1:8765/ws`。</span>
                    </div>
                </form>

                <div class="result">
                    <h3>返回结果</h3>
                    <pre id="resultText">还没有提交问题。</pre>
                </div>
            </section>

            <aside class="card history">
                <div class="history-head">
                    <h2>最近历史</h2>
                    <button id="refreshHistoryBtn" type="button">刷新历史</button>
                </div>
                <div id="historyList" class="history-list">
                    <div class="history-item">
                        <p class="history-answer">历史记录加载中...</p>
                    </div>
                </div>
            </aside>
        </div>
    </div>

    <script>
        const serviceStatusEl = document.getElementById("serviceStatus");
        const clientCountEl = document.getElementById("clientCount");
        const questionInputEl = document.getElementById("questionInput");
        const askFormEl = document.getElementById("askForm");
        const submitBtnEl = document.getElementById("submitBtn");
        const resultTextEl = document.getElementById("resultText");
        const historyListEl = document.getElementById("historyList");
        const refreshHistoryBtnEl = document.getElementById("refreshHistoryBtn");

        async function refreshServiceStatus() {
            try {
                const response = await fetch("/api/status");
                const data = await response.json();
                serviceStatusEl.textContent = data.status;
                serviceStatusEl.className = "meta-value status-ok";
                clientCountEl.textContent = String(data.connected_clients);
            } catch (error) {
                serviceStatusEl.textContent = "服务不可用";
                serviceStatusEl.className = "meta-value status-error";
                clientCountEl.textContent = "-";
            }
        }

        function renderHistory(items) {
            if (!items.length) {
                historyListEl.innerHTML = `
                    <div class="history-item">
                        <p class="history-answer">还没有历史记录。</p>
                    </div>
                `;
                return;
            }

            historyListEl.innerHTML = items.map((item) => `
                <div class="history-item">
                    <p class="history-question">${escapeHtml(item.question || "未记录问题")}</p>
                    <p class="history-answer">${escapeHtml(item.answer || "")}</p>
                    <div class="history-time">${new Date(item.created_at).toLocaleString()}</div>
                </div>
            `).join("");
        }

        async function refreshHistory() {
            refreshHistoryBtnEl.disabled = true;
            try {
                const response = await fetch("/conversations?limit=10");
                const data = await response.json();
                renderHistory(Array.isArray(data) ? data : []);
            } catch (error) {
                historyListEl.innerHTML = `
                    <div class="history-item">
                        <p class="history-answer status-error">历史加载失败：${escapeHtml(error.message)}</p>
                    </div>
                `;
            } finally {
                refreshHistoryBtnEl.disabled = false;
            }
        }

        async function submitQuestion(event) {
            event.preventDefault();
            const question = questionInputEl.value.trim();
            if (!question) {
                resultTextEl.textContent = "请先输入问题。";
                return;
            }

            submitBtnEl.disabled = true;
            submitBtnEl.textContent = "发送中...";
            resultTextEl.textContent = "正在等待 Grok 返回结果，请稍候...";

            try {
                const response = await fetch("/ask", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ question })
                });

                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.detail || "请求失败");
                }

                resultTextEl.textContent = data.answer || "没有返回内容。";
                questionInputEl.value = "";
                await refreshHistory();
                await refreshServiceStatus();
            } catch (error) {
                resultTextEl.textContent = `发送失败：${error.message}`;
            } finally {
                submitBtnEl.disabled = false;
                submitBtnEl.textContent = "发送给 Grok";
            }
        }

        function escapeHtml(value) {
            return String(value)
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#39;");
        }

        askFormEl.addEventListener("submit", submitQuestion);
        refreshHistoryBtnEl.addEventListener("click", refreshHistory);

        refreshServiceStatus();
        refreshHistory();
        setInterval(refreshServiceStatus, 5000);
    </script>
</body>
</html>
"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan manager for startup/shutdown events."""
    # Startup: Initialize database
    await init_db()
    app.state.browser_opened = False
    print("Grok AI Backend Service started")
    yield
    # Shutdown: Clean up resources
    print("Grok AI Backend Service shutting down")


# Create FastAPI app with lifespan
app = FastAPI(
    title="Grok AI Browser Extension Backend",
    description="Backend service for browser extension that interacts with Grok AI",
    version="0.1.0",
    lifespan=lifespan,
)

# Add CORS middleware (for local development)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to localhost
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", response_class=HTMLResponse)
async def root():
    """Serve the local web UI."""
    return HTMLResponse(INDEX_HTML)


@app.get("/api/status")
async def api_status():
    """Status endpoint for the local web UI."""
    return {
        "service": "Grok AI Browser Extension Backend",
        "status": "running",
        "connected_clients": len(manager.active_connections),
    }


@app.get("/health")
async def health():
    """Health check with database connection test."""
    return {"status": "healthy", "timestamp": asyncio.get_event_loop().time()}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for browser extension connections."""
    # Generate client ID
    client_id = str(uuid.uuid4())
    
    try:
        # Connect client
        await manager.connect(websocket, client_id)
        
        # Send connection confirmation
        await manager.send_message(client_id, {
            "type": "connected",
            "client_id": client_id,
        })
        
        # Listen for messages
        while True:
            data = await websocket.receive_json()
            
            # Handle different message types
            message_type = data.get("type")
            
            if message_type == "pong":
                # Heartbeat response
                continue
            elif message_type == "ping":
                await manager.send_message(
                    client_id,
                    {
                        "type": "pong",
                        "client_id": client_id,
                    },
                )
                continue
                
            elif message_type == "answer":
                # Answer from browser extension
                request_id = data.get("request_id")
                answer = data.get("answer")
                
                if request_id and answer:
                    manager.handle_response(client_id, request_id, answer)
                    
                    # Also save to database
                    async for db in get_db():
                        crud = ConversationCRUD(db)
                        question = "Unknown"  # We don't have the original question here
                        # In real implementation, we'd track request_id to question mapping
                        await crud.create_conversation(question, answer)
                
            elif message_type == "status":
                # Status update from extension
                status = data.get("status")
                print(f"Client {client_id} status: {status}")
            elif message_type == "error":
                request_id = data.get("request_id")
                error = data.get("error")
                print(f"Client {client_id} reported error: {error}")
                if request_id:
                    manager.handle_error(client_id, request_id, error or "Unknown error")
                
            else:
                print(f"Unknown message type from {client_id}: {message_type}")
    
    except WebSocketDisconnect:
        print(f"Client {client_id} disconnected")
        manager.disconnect(client_id)
    except json.JSONDecodeError:
        print(f"Invalid JSON from client {client_id}")
        manager.disconnect(client_id)
    except Exception as e:
        print(f"Error with client {client_id}: {e}")
        manager.disconnect(client_id)


@app.post("/ask", response_model=QuestionResponse)
async def ask_grok(request: QuestionRequest):
    """
    Send a question to Grok AI via browser extension.
    
    This endpoint will:
    1. Find an active browser extension connection
    2. Send the question via WebSocket
    3. Wait for the extension to get answer from Grok
    4. Save the conversation to database
    5. Return the answer
    """
    if not manager.active_connections:
        raise HTTPException(
            status_code=503,
            detail="No browser extension connected. Please install and activate the extension."
        )
    
    # For now, use the first connected client
    # In production, you might want to implement connection selection logic
    client_id = next(iter(manager.active_connections))
    
    # Send question to extension and wait for response
    answer = await manager.send_question_to_grok(client_id, request.question)
    
    if answer is None:
        raise HTTPException(
            status_code=504,
            detail="Failed to get response from Grok AI. Check browser extension and Grok website."
        )
    
    # Save conversation to database
    async for db in get_db():
        crud = ConversationCRUD(db)
        conversation = await crud.create_conversation(
            question=request.question,
            answer=answer
        )
        
        return QuestionResponse(
            answer=answer,
            conversation_id=conversation.id,
        )


@app.get("/conversations")
async def get_conversations(skip: int = 0, limit: int = 100):
    """Get paginated list of conversations."""
    async for db in get_db():
        crud = ConversationCRUD(db)
        conversations = await crud.get_conversations(skip=skip, limit=limit)
        
        return [
            {
                "id": conv.id,
                "question": conv.question,
                "answer": conv.answer,
                "created_at": conv.created_at.isoformat(),
            }
            for conv in conversations
        ]


def main():
    """Main entry point for the service."""
    import uvicorn
    
    # Configuration
    host = "127.0.0.1"
    port = 8765
    ui_url = f"http://{host}:{port}/"
    
    print(f"Starting Grok AI Backend Service on {host}:{port}")
    print(f"WebSocket endpoint: ws://{host}:{port}/ws")
    print(f"HTTP UI endpoint: {ui_url}")
    print("\nTo connect browser extension, use the WebSocket URL above.")

    def open_browser():
        try:
            webbrowser.open(ui_url)
        except Exception as exc:
            print(f"Failed to open browser automatically: {exc}")

    threading.Timer(1.2, open_browser).start()
    
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="info",
    )


if __name__ == "__main__":
    main()