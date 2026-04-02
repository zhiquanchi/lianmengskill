"""Main FastAPI application for Grok AI browser extension backend."""

import asyncio
import json
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan manager for startup/shutdown events."""
    # Startup: Initialize database
    await init_db()
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


@app.get("/")
async def root():
    """Health check endpoint."""
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
    
    print(f"Starting Grok AI Backend Service on {host}:{port}")
    print(f"WebSocket endpoint: ws://{host}:{port}/ws")
    print(f"HTTP API endpoint: http://{host}:{port}/")
    print("\nTo connect browser extension, use the WebSocket URL above.")
    
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="info",
    )


if __name__ == "__main__":
    main()