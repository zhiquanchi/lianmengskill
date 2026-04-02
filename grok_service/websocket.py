"""WebSocket connection manager for browser extension communication."""

import asyncio
import json
from typing import Dict, Set
from fastapi import WebSocket


class ConnectionManager:
    """Manages WebSocket connections to browser extensions."""
    
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.pending_requests: Dict[str, asyncio.Future] = {}
    
    async def connect(self, websocket: WebSocket, client_id: str):
        """Accept WebSocket connection and store it."""
        await websocket.accept()
        self.active_connections[client_id] = websocket
        print(f"Client {client_id} connected. Total connections: {len(self.active_connections)}")
    
    def disconnect(self, client_id: str):
        """Remove WebSocket connection."""
        if client_id in self.active_connections:
            del self.active_connections[client_id]
            print(f"Client {client_id} disconnected. Total connections: {len(self.active_connections)}")
        
        # Cancel any pending requests for this client
        if client_id in self.pending_requests:
            self.pending_requests[client_id].cancel()
            del self.pending_requests[client_id]
    
    async def send_message(self, client_id: str, message: dict):
        """Send message to specific client."""
        if client_id in self.active_connections:
            try:
                await self.active_connections[client_id].send_json(message)
                return True
            except Exception as e:
                print(f"Failed to send message to {client_id}: {e}")
                self.disconnect(client_id)
                return False
        return False
    
    async def send_to_all(self, message: dict):
        """Send message to all connected clients."""
        disconnected = []
        for client_id, websocket in self.active_connections.items():
            try:
                await websocket.send_json(message)
            except Exception as e:
                print(f"Failed to send to {client_id}: {e}")
                disconnected.append(client_id)
        
        for client_id in disconnected:
            self.disconnect(client_id)
    
    async def send_question_to_grok(self, client_id: str, question: str) -> str | None:
        """
        Send a question to browser extension to forward to Grok.
        Returns the answer or None if failed.
        """
        if client_id not in self.active_connections:
            print(f"Client {client_id} not connected")
            return None
        
        # Create future for response
        future = asyncio.get_running_loop().create_future()
        self.pending_requests[client_id] = future
        
        # Send question to extension
        message = {
            "type": "question",
            "question": question,
            "request_id": id(future),  # Use future id as request identifier
        }
        
        try:
            await self.send_message(client_id, message)
            
            # Wait for response with timeout (30 seconds)
            answer = await asyncio.wait_for(future, timeout=30.0)
            return answer
            
        except asyncio.TimeoutError:
            print(f"Timeout waiting for response from {client_id}")
            return None
        except Exception as e:
            print(f"Error sending question to {client_id}: {e}")
            return None
        finally:
            # Clean up pending request
            if client_id in self.pending_requests:
                del self.pending_requests[client_id]
    
    def handle_response(self, client_id: str, request_id: int, answer: str):
        """Handle response from browser extension."""
        if client_id in self.pending_requests:
            future = self.pending_requests[client_id]
            if not future.done():
                future.set_result(answer)

    def handle_error(self, client_id: str, request_id: int, error: str):
        """Propagate extension-side errors back to waiting callers."""
        if client_id in self.pending_requests:
            future = self.pending_requests[client_id]
            if not future.done():
                future.set_exception(RuntimeError(error))


# Global connection manager instance
manager = ConnectionManager()