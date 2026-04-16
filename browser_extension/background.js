// Background service worker for Grok AI Assistant extension
import { GrokTabManager } from './grok_tab_manager.js';
import { extractSimplyCodesDiscountFromTab } from './simplycodes_extractor.js';

class GrokBackground {
    constructor() {
        this.ws = null;
        this.lastWsUrl = null;
        this.connected = false;
        this.clientId = null;
        this.grokTabId = null;
        this.grokTabUrl = null;
        this.simplyCodesTabId = null;
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
        this.grokTabManager = new GrokTabManager(this);
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

                case 'querySimplyCodesDiscount':
                    const discountData = await this.querySimplyCodesDiscount(message.competitor);
                    sendResponse({
                        success: true,
                        data: discountData,
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

    normalizeCompetitorInput(raw = '') {
        const input = (raw || '').trim().toLowerCase();
        if (!input) {
            return '';
        }

        try {
            if (/^https?:\/\//i.test(input)) {
                return new URL(input).hostname.replace(/^www\./, '');
            }
        } catch (_) {
            // fall through
        }

        return input
            .replace(/^www\./, '')
            .replace(/^store\//, '')
            .replace(/\/.*$/, '')
            .replace(/\s+/g, '');
    }

    buildSimplyCodesStoreCandidates(competitor) {
        const normalized = this.normalizeCompetitorInput(competitor);
        if (!normalized) {
            return [];
        }

        const candidates = new Set();
        candidates.add(normalized);

        if (!normalized.includes('.')) {
            candidates.add(`${normalized}.com`);
        }

        return Array.from(candidates);
    }

    async querySimplyCodesDiscount(competitor) {
        const candidates = this.buildSimplyCodesStoreCandidates(competitor);
        if (candidates.length === 0) {
            throw new Error('请输入有效的竞品名称或域名');
        }

        let lastReason = '';
        for (const storePath of candidates) {
            const tab = await this.openSimplyCodesStoreTab(storePath);
            const extraction = await this.extractDiscountFromSimplyCodesPage(tab.id);

            if (extraction.blockedByCloudflare) {
                throw new Error('SimplyCodes 触发了 Cloudflare 验证，请先在该标签页手动完成验证后再点击“查询折扣额度”');
            }

            if (extraction.found) {
                this.setLastActivity();
                this.lastError = null;
                this.savePersistedState();
                return {
                    competitor: competitor,
                    discountText: extraction.discountText,
                    discountValue: extraction.discountValue,
                    discountUnit: extraction.discountUnit,
                    source: extraction.source,
                    selector: extraction.selector,
                    couponCode: extraction.couponCode || '',
                    pageUrl: tab.url || `https://simplycodes.com/store/${storePath}`,
                    storeCandidate: storePath,
                };
            }

            lastReason = extraction.reason || `在 ${storePath} 页面未识别到折扣`;
        }

        throw new Error(lastReason || '未识别到可用折扣信息');
    }

    async openSimplyCodesStoreTab(storePath) {
        const targetUrl = `https://simplycodes.com/store/${encodeURIComponent(storePath)}`;
        const existing = await this.findExistingSimplyCodesTab();

        let tab;
        if (existing?.id) {
            tab = await chrome.tabs.update(existing.id, { url: targetUrl, active: true });
            this.simplyCodesTabId = tab.id;
            if (tab.windowId) {
                await chrome.windows.update(tab.windowId, { focused: true });
            }
        } else {
            tab = await chrome.tabs.create({ url: targetUrl, active: true });
            this.simplyCodesTabId = tab.id;
        }

        await this.waitForTabReady(tab.id, 15000);
        const latestTab = await chrome.tabs.get(tab.id);
        return latestTab;
    }

    async findExistingSimplyCodesTab() {
        if (this.simplyCodesTabId) {
            try {
                const tab = await chrome.tabs.get(this.simplyCodesTabId);
                if (this.isSimplyCodesUrl(tab.url)) {
                    return tab;
                }
            } catch (_) {
                this.simplyCodesTabId = null;
            }
        }

        const tabs = await chrome.tabs.query({ url: ['https://simplycodes.com/*'] });
        return tabs.find((tab) => this.isSimplyCodesUrl(tab.url)) || null;
    }

    isSimplyCodesUrl(url = '') {
        return /^https:\/\/simplycodes\.com\//i.test(url || '');
    }

    async waitForTabReady(tabId, timeoutMs = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab?.status === 'complete') {
                    return true;
                }
            } catch (_) {
                // ignore while waiting
            }
            await this.sleep(250);
        }
        throw new Error('Timed out waiting for SimplyCodes tab to load');
    }

    async extractDiscountFromSimplyCodesPage(tabId) {
        return extractSimplyCodesDiscountFromTab(tabId);
    }

    async prepareFreshConversation() {
        return this.grokTabManager.prepareFreshConversation();
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
        return this.grokTabManager.openGrokTab(grokUrl);
    }

    waitForTabComplete(tabId, timeoutMs = 15000) {
        return this.grokTabManager.waitForTabComplete(tabId, timeoutMs);
    }
    
    async ensureContentScriptInjected() {
        return this.grokTabManager.ensureContentScriptInjected();
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
        return this.grokTabManager.refreshTabState();
    }

    async findExistingGrokTab() {
        return this.grokTabManager.findExistingGrokTab();
    }

    isSupportedGrokUrl(url = '') {
        return this.grokTabManager.isSupportedGrokUrl(url);
    }

    normalizeGrokUrl(url = '') {
        return this.grokTabManager.normalizeGrokUrl(url);
    }

    getFreshConversationUrl(url = '') {
        return this.grokTabManager.getFreshConversationUrl(url);
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

/**
 * 点击扩展图标打开 Side Panel（与 ChatHub 等侧栏类扩展的交互一致）。
 * 需要 Chrome 114+ / Edge 114+ 且 manifest 中声明 side_panel 与 sidePanel 权限。
 */
async function registerSidePanelOpenOnActionClick() {
    if (!chrome.sidePanel?.setPanelBehavior) {
        return;
    }
    try {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch (error) {
        console.warn('Side panel behavior not set:', error?.message || error);
    }
}

chrome.runtime.onInstalled.addListener(() => {
    registerSidePanelOpenOnActionClick();
});

registerSidePanelOpenOnActionClick();