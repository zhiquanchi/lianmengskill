// Background service worker for Grok AI Assistant extension

class GrokBackground {
    constructor() {
        this.ws = null;
        this.lastWsUrl = null;
        this.connected = false;
        this.clientId = null;
        this.grokTabId = null;
        this.grokTabUrl = null;
        this.contentScriptReady = false;
        this.pageReady = false;
        this.lastError = null;
        this.lastActivity = null;
        this.heartbeatIntervalMs = 20000;
        this.heartbeatTimer = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        
        this.pendingRequests = new Map();
        this.nextRequestId = 1;
        
        this.setupMessageListener();
        this.setupAlarms();
        
        // Try to restore previous connection
        this.loadPersistedState();
    }
    
    async loadPersistedState() {
        const result = await chrome.storage.local.get([
            'clientId',
            'wsUrl',
            'grokTabId',
            'grokTabUrl',
            'contentScriptReady',
            'pageReady',
            'lastError',
            'lastActivity',
        ]);
        
        if (result.wsUrl) {
            this.lastWsUrl = result.wsUrl;
            setTimeout(() => {
                this.connect(result.wsUrl).catch((e) =>
                    console.error('Auto-reconnect on startup failed:', e)
                );
            }, 1000);
        }
        
        if (result.grokTabId) {
            this.grokTabId = result.grokTabId;
        }

        this.grokTabUrl = result.grokTabUrl || null;
        this.contentScriptReady = !!result.contentScriptReady;
        this.pageReady = !!result.pageReady;
        this.lastError = result.lastError || null;
        this.lastActivity = result.lastActivity || null;
    }
    
    savePersistedState() {
        chrome.storage.local.set({
            clientId: this.clientId,
            wsUrl: this.lastWsUrl || this.ws?.url || '',
            grokTabId: this.grokTabId,
            grokTabUrl: this.grokTabUrl,
            contentScriptReady: this.contentScriptReady,
            pageReady: this.pageReady,
            lastError: this.lastError,
            lastActivity: this.lastActivity,
        });
    }
    
    clearPersistedState() {
        chrome.storage.local.remove(['clientId', 'wsUrl']);
    }
    
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            // Handle messages from popup
            this.handlePopupMessage(message, sender, sendResponse);
            return true; // Keep message channel open for async response
        });
    }
    
    setupAlarms() {
        // Setup heartbeat alarm for WebSocket connection
        chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 });
        
        chrome.alarms.onAlarm.addListener((alarm) => {
            if (alarm.name === 'heartbeat') {
                if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
                    this.sendHeartbeat();
                    return;
                }

                if (this.lastWsUrl) {
                    this.connect(this.lastWsUrl).catch((error) => {
                        console.debug('Alarm reconnect skipped:', error?.message || error);
                    });
                }
            }
        });
    }
    
    async handlePopupMessage(message, sender, sendResponse) {
        try {
            switch (message.type) {
                case 'connect':
                    try {
                        await this.connect(message.wsUrl);
                        sendResponse({
                            success: true,
                            clientId: this.clientId,
                        });
                    } catch (err) {
                        sendResponse({
                            success: false,
                            error: err?.message || String(err),
                        });
                    }
                    break;
                    
                case 'disconnect':
                    this.disconnect();
                    sendResponse({ success: true });
                    break;
                    
                case 'openGrokTab':
                    const tabId = await this.openGrokTab(message.grokUrl);
                    sendResponse({ 
                        success: !!tabId, 
                        tabId: tabId,
                        error: tabId ? null : this.lastError,
                    });
                    break;
                    
                case 'getStatus':
                    sendResponse(await this.getStatus());
                    break;

                case 'contentScriptReady':
                    this.handleContentScriptReady(sender);
                    sendResponse({ success: true });
                    break;

                case 'pageReady':
                    this.handlePageReady(sender, message.url);
                    sendResponse({ success: true });
                    break;
                    
                case 'sendQuestion':
                    // Forward question to WebSocket server
                    const answer = await this.sendQuestionToBackend(message.question);
                    sendResponse({ 
                        success: !!answer, 
                        answer: answer 
                    });
                    break;
                    
                default:
                    sendResponse({ 
                        success: false, 
                        error: 'Unknown message type' 
                    });
            }
        } catch (error) {
            console.error('Error handling message:', error);
            this.recordError(error?.message || String(error));
            sendResponse({ 
                success: false, 
                error: error.message 
            });
        }
    }
    
    /**
     * Opens WebSocket and resolves only after the socket is OPEN (MV3-safe).
     * Previously, connect() returned before onopen, so popup always saw success: false.
     */
    async connect(wsUrl) {
        if (this.connected && this.ws) {
            console.log('Already connected, reconnecting...');
            this.disconnect();
        }

        this.lastWsUrl = wsUrl;

        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn) => {
                if (settled) return;
                settled = true;
                fn();
            };

            const timeoutId = setTimeout(() => {
                finish(() => {
                    try {
                        this.ws?.close();
                    } catch (_) {
                        /* ignore */
                    }
                    this.ws = null;
                    this.connected = false;
                    reject(new Error('Connection timeout (10s). Is the backend running on ws://127.0.0.1:8765/ws ?'));
                });
            }, 10000);

            let socket;
            try {
                socket = new WebSocket(wsUrl);
                this.ws = socket;
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
                            new Error(
                                event.reason ||
                                    `Connection closed before open (code ${event.code})`
                            )
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
        console.log('WebSocket connection established');
        this.connected = true;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.lastError = null;
        this.setLastActivity();
        this.savePersistedState();
        
        // Notify popup
        this.notifyPopup('connected', { clientId: this.clientId });
        
        // Start heartbeat
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
        const messageType = data.type;
        
        switch (messageType) {
            case 'connected':
                // Server assigned client ID
                this.clientId = data.client_id || data.clientId;
                console.log(`Connected with client ID: ${this.clientId}`);
                this.lastError = null;
                this.setLastActivity();
                this.savePersistedState();
                break;
                
            case 'question':
                // Question from backend to forward to Grok
                this.handleQuestionFromBackend(data);
                break;
                
            case 'pong':
                // Heartbeat response
                console.debug('Heartbeat response received');
                break;
                
            default:
                console.log('Unknown message type from server:', messageType);
        }
    }
    
    async handleQuestionFromBackend(data) {
        const { question, request_id } = data;
        
        if (!question) {
            console.error('Received question without text');
            return;
        }
        
        console.log(`Processing question from backend: ${question.substring(0, 100)}...`);
        
        try {
            // Send question to Grok and get answer
            const answer = await this.sendQuestionToGrok(question);
            
            if (answer) {
                // Send answer back to backend
                this.sendToBackend({
                    type: 'answer',
                    request_id: request_id,
                    answer: answer
                });
                
                // Update stats
                this.updateMessageCount();
                this.setLastActivity();
            } else {
                console.error('Failed to get answer from Grok');
                
                // Send error back to backend
                this.sendToBackend({
                    type: 'error',
                    request_id: request_id,
                    error: 'Failed to get answer from Grok'
                });
            }
        } catch (error) {
            console.error('Error handling question:', error);
            this.recordError(error?.message || String(error));
            
            this.sendToBackend({
                type: 'error',
                request_id: request_id,
                error: error.message
            });
        }
    }
    
    async sendQuestionToGrok(question) {
        return await this.retryWithBackoff(
            () => this.sendQuestionToGrokOnce(question),
            3,
            1000
        );
    }

    async sendQuestionToGrokOnce(question) {
        const status = await this.refreshTabState();
        if (!status.grokTabId) {
            await this.openGrokTab();
        }
        
        if (!this.grokTabId) {
            throw new Error('Grok tab not available');
        }

        await this.prepareFreshConversation();
        await this.ensureContentScriptInjected();

        const response = await chrome.tabs.sendMessage(this.grokTabId, {
            type: 'sendQuestion',
            question: question,
            newConversation: true,
        });

        if (response && response.success) {
            this.setLastActivity();
            return response.answer;
        }

        throw new Error(response?.error || 'Failed to get answer from content script');
    }

    async prepareFreshConversation() {
        if (!this.grokTabId) {
            return;
        }

        let tab;
        try {
            tab = await chrome.tabs.get(this.grokTabId);
        } catch (_) {
            return;
        }

        const freshUrl = this.getFreshConversationUrl(tab.url || this.grokTabUrl || 'https://grok.com/');
        if (freshUrl && tab.url !== freshUrl) {
            await chrome.tabs.update(this.grokTabId, { url: freshUrl, active: true });
            await this.waitForTabComplete(this.grokTabId, 15000);
            this.grokTabUrl = freshUrl;
            this.contentScriptReady = false;
            this.pageReady = false;
            this.savePersistedState();
            return;
        }

        await chrome.tabs.update(this.grokTabId, { active: true });
        if (tab.windowId) {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
    }
    
    async retryWithBackoff(operation, maxRetries, initialDelay) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                console.log(`Attempt ${attempt} failed:`, error.message);
                
                if (attempt < maxRetries) {
                    const delay = initialDelay * Math.pow(2, attempt - 1);
                    console.log(`Retrying in ${delay}ms...`);
                    await this.sleep(delay);
                }
            }
        }
        
        throw lastError;
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    async openGrokTab(grokUrl = 'https://grok.com') {
        try {
            const normalizedUrl = this.normalizeGrokUrl(grokUrl);
            const existingTab = await this.findExistingGrokTab();
            if (existingTab?.id) {
                this.grokTabId = existingTab.id;
                this.grokTabUrl = existingTab.url || normalizedUrl;
                this.pageReady = false;
                this.contentScriptReady = false;
                await chrome.tabs.update(existingTab.id, { active: true, url: existingTab.url || normalizedUrl });
                await chrome.windows.update(existingTab.windowId, { focused: true });
                await this.ensureContentScriptInjected();
                this.setLastActivity();
                this.savePersistedState();
                return existingTab.id;
            }
            
            // Open new tab
            const tab = await chrome.tabs.create({
                url: normalizedUrl,
                active: true
            });
            
            this.grokTabId = tab.id;
            this.grokTabUrl = tab.url || normalizedUrl;
            this.pageReady = false;
            this.contentScriptReady = false;
            this.lastError = null;
            this.setLastActivity();
            this.savePersistedState();
            
            console.log(`Opened Grok tab with ID: ${this.grokTabId}`);
            
            // Wait for tab to load
            await new Promise(resolve => setTimeout(resolve, 2000));
            await this.ensureContentScriptInjected();
            
            return this.grokTabId;
            
        } catch (error) {
            console.error('Error opening Grok tab:', error);
            this.grokTabId = null;
            this.grokTabUrl = null;
            this.contentScriptReady = false;
            this.pageReady = false;
            this.recordError(error?.message || 'Failed to open Grok tab');
            return null;
        }
    }

    waitForTabComplete(tabId, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                chrome.tabs.onUpdated.removeListener(listener);
                reject(new Error('Timed out waiting for Grok tab to finish loading'));
            }, timeoutMs);

            const listener = (updatedTabId, changeInfo) => {
                if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
                    return;
                }

                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            };

            chrome.tabs.onUpdated.addListener(listener);
        });
    }
    
    async ensureContentScriptInjected() {
        if (!this.grokTabId) return false;
        
        try {
            // Check if content script is already injected
            const response = await chrome.tabs.sendMessage(this.grokTabId, { type: 'ping' });
            this.contentScriptReady = !!response?.success;
            this.pageReady = !!response?.ready;
            this.lastError = null;
            this.savePersistedState();
            return true;
        } catch (error) {
            // Content script not ready, try to execute it
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: this.grokTabId },
                    files: ['content.js']
                });
                console.log('Content script injected');
                this.contentScriptReady = true;
                this.lastError = null;
                this.savePersistedState();
                return true;
            } catch (injectError) {
                console.error('Failed to inject content script:', injectError);
                this.recordError(injectError?.message || 'Failed to inject content script');
                return false;
            }
        }
    }
    
    sendToBackend(data) {
        if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(data));
                this.setLastActivity();
                return true;
            } catch (error) {
                console.error('Error sending to backend:', error);
                this.recordError(error?.message || 'Error sending to backend');
                return false;
            }
        } else {
            console.error('WebSocket not connected, cannot send message');
            this.recordError('WebSocket not connected');
            return false;
        }
    }
    
    sendHeartbeat() {
        if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
            this.sendToBackend({ type: 'ping' });
        }
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.sendHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, this.heartbeatIntervalMs);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    
    onWebSocketClose(event) {
        const wasConnected = this.connected;
        console.log(`WebSocket connection closed: ${event.code} ${event.reason}`);
        this.connected = false;
        this.ws = null;
        this.clientId = null;
        this.stopHeartbeat();
        if (event.code !== 1000) {
            this.recordError(event.reason || `WebSocket closed (${event.code})`);
        }
        this.savePersistedState();

        // Notify popup
        this.notifyPopup('disconnected', {
            code: event.code,
            reason: event.reason,
        });

        // 1000 = normal close (user disconnect); do not auto-reconnect
        if (event.code === 1000) {
            return;
        }

        // Never reached onopen (e.g. backend down): do not auto-reconnect loop
        if (!wasConnected) {
            return;
        }

        const url = this.lastWsUrl;
        if (!url || this.reconnectAttempts >= this.maxReconnectAttempts) {
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.log('Max reconnection attempts reached');
                this.clearPersistedState();
            }
            return;
        }

        this.reconnectAttempts++;
        console.log(
            `Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
        );

        setTimeout(() => {
            this.connect(url).catch((err) =>
                console.error('Reconnect failed:', err)
            );
        }, this.reconnectDelay);

        this.reconnectDelay *= 2;
    }
    
    onWebSocketError(error) {
        console.error('WebSocket error:', error);
        this.handleConnectionError(error);
    }
    
    handleConnectionError(error) {
        this.connected = false;
        this.stopHeartbeat();
        this.recordError(error?.message || 'Connection error');
        this.notifyPopup('error', { error: error.message });
    }
    
    disconnect() {
        this.lastWsUrl = null;
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.close(1000, 'User disconnected');
            this.ws = null;
        }

        this.connected = false;
        this.clientId = null;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.lastError = null;

        this.clearPersistedState();
        this.savePersistedState();
        this.notifyPopup('disconnected');
    }
    
    notifyPopup(event, data = {}) {
        // Send notification to popup if it's open
        chrome.runtime.sendMessage({
            type: 'notification',
            event: event,
            ...data
        }).catch(() => {
            // Popup not open, that's ok
        });
    }
    
    updateMessageCount() {
        chrome.storage.local.get(['messageCount'], (result) => {
            const count = (result.messageCount || 0) + 1;
            chrome.storage.local.set({ messageCount: count });
        });
    }

    handleContentScriptReady(sender) {
        if (sender?.tab?.id) {
            this.grokTabId = sender.tab.id;
            this.grokTabUrl = sender.tab.url || this.grokTabUrl;
        }

        this.contentScriptReady = true;
        this.lastError = null;
        this.setLastActivity();
        this.savePersistedState();
        this.notifyPopup('statusChanged');
    }

    handlePageReady(sender, url) {
        if (sender?.tab?.id) {
            this.grokTabId = sender.tab.id;
            this.grokTabUrl = sender.tab.url || url || this.grokTabUrl;
        }

        this.contentScriptReady = true;
        this.pageReady = true;
        this.lastError = null;
        this.setLastActivity();
        this.savePersistedState();
        this.notifyPopup('statusChanged');
    }

    async getStatus() {
        const status = await this.refreshTabState();
        const storage = await chrome.storage.local.get(['messageCount', 'lastActivity']);
        return {
            connected: this.connected && this.ws?.readyState === WebSocket.OPEN,
            clientId: this.clientId,
            wsUrl: this.lastWsUrl || this.ws?.url || '',
            grokTabId: status.grokTabId,
            grokTabUrl: status.grokTabUrl,
            grokTabOpen: status.grokTabOpen,
            contentScriptReady: status.contentScriptReady,
            pageReady: status.pageReady,
            lastError: this.lastError,
            lastActivity: storage.lastActivity || this.lastActivity,
            messageCount: storage.messageCount || 0,
        };
    }

    async refreshTabState() {
        const existingTab = await this.findExistingGrokTab();
        if (!existingTab?.id) {
            this.grokTabId = null;
            this.grokTabUrl = null;
            this.contentScriptReady = false;
            this.pageReady = false;
            this.savePersistedState();
            return {
                grokTabId: null,
                grokTabUrl: null,
                grokTabOpen: false,
                contentScriptReady: false,
                pageReady: false,
            };
        }

        this.grokTabId = existingTab.id;
        this.grokTabUrl = existingTab.url || null;

        try {
            const response = await chrome.tabs.sendMessage(existingTab.id, { type: 'getStatus' });
            this.contentScriptReady = !!response;
            this.pageReady = !!response?.ready;
            this.lastError = null;
        } catch (error) {
            this.contentScriptReady = false;
            this.pageReady = false;
        }

        this.savePersistedState();

        return {
            grokTabId: this.grokTabId,
            grokTabUrl: this.grokTabUrl,
            grokTabOpen: true,
            contentScriptReady: this.contentScriptReady,
            pageReady: this.pageReady,
        };
    }

    async findExistingGrokTab() {
        if (this.grokTabId) {
            try {
                const tab = await chrome.tabs.get(this.grokTabId);
                if (this.isSupportedGrokUrl(tab.url)) {
                    return tab;
                }
            } catch (_) {
                this.grokTabId = null;
            }
        }

        const tabs = await chrome.tabs.query({});
        return tabs.find((tab) => this.isSupportedGrokUrl(tab.url)) || null;
    }

    isSupportedGrokUrl(url = '') {
        return [
            'https://grok.com/',
            'https://grok.x.com/',
            'https://chat.x.ai/',
            'https://x.com/i/grok',
        ].some((prefix) => url.startsWith(prefix));
    }

    normalizeGrokUrl(url = '') {
        const normalized = (url || '').trim();
        if (!normalized) {
            return 'https://grok.com/';
        }

        if (!/^https?:\/\//i.test(normalized)) {
            return `https://${normalized}`;
        }

        return normalized;
    }

    getFreshConversationUrl(url = '') {
        try {
            const parsed = new URL(this.normalizeGrokUrl(url));
            if (parsed.hostname === 'x.com') {
                return 'https://x.com/i/grok';
            }

            return `${parsed.origin}/`;
        } catch (_) {
            return 'https://grok.com/';
        }
    }

    recordError(message) {
        this.lastError = message || null;
        this.setLastActivity();
        this.savePersistedState();
        this.notifyPopup('error', { error: this.lastError });
    }

    setLastActivity() {
        this.lastActivity = new Date().toISOString();
    }
    
    async sendQuestionToBackend(question) {
        // This would be used if popup wants to send a question directly
        const requestId = this.nextRequestId++;
        
        return new Promise((resolve, reject) => {
            // Store the promise resolvers
            this.pendingRequests.set(requestId, { resolve, reject });
            
            // Send question to backend
            const sent = this.sendToBackend({
                type: 'questionFromExtension',
                question: question,
                request_id: requestId
            });
            
            if (!sent) {
                this.pendingRequests.delete(requestId);
                reject(new Error('Failed to send question to backend'));
            }
            
            // Set timeout for response (30 seconds)
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Response timeout'));
                }
            }, 30000);
        });
    }
}

// Initialize background service (service workers have no `window`; use globalThis for debugging)
const grokBackground = new GrokBackground();
globalThis.grokBackground = grokBackground;