export class WsConnectionManager {
    constructor(host) {
        this.host = host;
    }

    async connect(wsUrl) {
        const host = this.host;
        if (host.connected && host.ws) {
            console.log('Already connected, reconnecting...');
            this.disconnect();
        }

        host.lastWsUrl = wsUrl;

        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn) => {
                if (settled) {
                    return;
                }
                settled = true;
                fn();
            };

            const timeoutId = setTimeout(() => {
                finish(() => {
                    try {
                        host.ws?.close();
                    } catch (_) {
                        // ignore
                    }
                    host.ws = null;
                    host.connected = false;
                    reject(new Error('Connection timeout (10s). Is the backend running on ws://127.0.0.1:8765/ws ?'));
                });
            }, 10000);

            let socket;
            try {
                socket = new WebSocket(wsUrl);
                host.ws = socket;
            } catch (error) {
                clearTimeout(timeoutId);
                finish(() => reject(error));
                return;
            }

            socket.onopen = () => {
                clearTimeout(timeoutId);
                this.onWebSocketOpen();
                finish(() => resolve());
            };

            socket.onmessage = (event) => this.onWebSocketMessage(event);

            socket.onclose = (event) => {
                clearTimeout(timeoutId);
                if (!settled) {
                    finish(() =>
                        reject(
                            new Error(event.reason || `Connection closed before open (code ${event.code})`)
                        )
                    );
                }
                this.onWebSocketClose(event);
            };

            socket.onerror = () => {
                clearTimeout(timeoutId);
                if (!settled) {
                    finish(() =>
                        reject(new Error('WebSocket error (check URL and host permission for localhost)'))
                    );
                }
                this.handleConnectionError(new Error('WebSocket error'));
            };
        });
    }

    onWebSocketOpen() {
        const host = this.host;
        console.log('WebSocket connection established');
        host.connected = true;
        host.reconnectAttempts = 0;
        host.reconnectDelay = 1000;
        host.lastError = null;
        host.setLastActivity();
        host.savePersistedState();
        host.notifyPopup('connected', { clientId: host.clientId });
        this.startHeartbeat();
    }

    onWebSocketMessage(event) {
        try {
            const data = JSON.parse(event.data);
            this.handleWebSocketMessage(data);
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    }

    handleWebSocketMessage(data) {
        const host = this.host;
        const messageType = data.type;

        switch (messageType) {
            case 'connected':
                host.clientId = data.client_id || data.clientId;
                console.log(`Connected with client ID: ${host.clientId}`);
                host.lastError = null;
                host.setLastActivity();
                host.savePersistedState();
                break;
            case 'question':
                host.handleQuestionFromBackend(data);
                break;
            case 'pong':
                console.debug('Heartbeat response received');
                break;
            default:
                console.log('Unknown message type from server:', messageType);
        }
    }

    sendToBackend(data) {
        const host = this.host;
        if (host.connected && host.ws?.readyState === WebSocket.OPEN) {
            try {
                host.ws.send(JSON.stringify(data));
                host.setLastActivity();
                return true;
            } catch (error) {
                console.error('Error sending to backend:', error);
                host.recordError(error?.message || 'Error sending to backend');
                return false;
            }
        }

        console.error('WebSocket not connected, cannot send message');
        host.recordError('WebSocket not connected');
        return false;
    }

    sendHeartbeat() {
        const host = this.host;
        if (host.connected && host.ws?.readyState === WebSocket.OPEN) {
            this.sendToBackend({ type: 'ping' });
        }
    }

    startHeartbeat() {
        const host = this.host;
        this.stopHeartbeat();
        this.sendHeartbeat();
        host.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, host.heartbeatIntervalMs);
    }

    stopHeartbeat() {
        const host = this.host;
        if (host.heartbeatTimer) {
            clearInterval(host.heartbeatTimer);
            host.heartbeatTimer = null;
        }
    }

    onWebSocketClose(event) {
        const host = this.host;
        const wasConnected = host.connected;
        console.log(`WebSocket connection closed: ${event.code} ${event.reason}`);
        host.connected = false;
        host.ws = null;
        host.clientId = null;
        this.stopHeartbeat();
        if (event.code !== 1000) {
            host.recordError(event.reason || `WebSocket closed (${event.code})`);
        }
        host.savePersistedState();

        host.notifyPopup('disconnected', {
            code: event.code,
            reason: event.reason,
        });

        if (event.code === 1000 || !wasConnected) {
            return;
        }

        const url = host.lastWsUrl;
        if (!url || host.reconnectAttempts >= host.maxReconnectAttempts) {
            if (host.reconnectAttempts >= host.maxReconnectAttempts) {
                console.log('Max reconnection attempts reached');
                host.clearPersistedState();
            }
            return;
        }

        host.reconnectAttempts++;
        console.log(
            `Reconnecting in ${host.reconnectDelay}ms (attempt ${host.reconnectAttempts}/${host.maxReconnectAttempts})`
        );

        setTimeout(() => {
            this.connect(url).catch((err) => console.error('Reconnect failed:', err));
        }, host.reconnectDelay);

        host.reconnectDelay *= 2;
    }

    onWebSocketError(error) {
        console.error('WebSocket error:', error);
        this.handleConnectionError(error);
    }

    handleConnectionError(error) {
        const host = this.host;
        host.connected = false;
        this.stopHeartbeat();
        host.recordError(error?.message || 'Connection error');
        host.notifyPopup('error', { error: error.message });
    }

    disconnect() {
        const host = this.host;
        host.lastWsUrl = null;
        this.stopHeartbeat();
        if (host.ws) {
            host.ws.close(1000, 'User disconnected');
            host.ws = null;
        }

        host.connected = false;
        host.clientId = null;
        host.reconnectAttempts = 0;
        host.reconnectDelay = 1000;
        host.lastError = null;

        host.clearPersistedState();
        host.savePersistedState();
        host.notifyPopup('disconnected');
    }
}
