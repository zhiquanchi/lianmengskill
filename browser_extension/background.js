// Background service worker for Grok AI Assistant extension
import { GrokTabManager } from './grok_tab_manager.js';
import { extractSimplyCodesDiscountFromTab } from './simplycodes_extractor.js';
import { extractCashbackMonitorDiv9FromTab } from './cashbackmonitor_extractor.js';
import { WsConnectionManager } from './ws_connection_manager.js';

class GrokBackground {
    constructor() {
        this.ws = null;
        this.lastWsUrl = null;
        this.connected = false;
        this.clientId = null;
        this.grokTabId = null;
        this.grokTabUrl = null;
        this.simplyCodesTabId = null;
        this.cashbackMonitorTabId = null;
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
        this.wsConnectionManager = new WsConnectionManager(this);
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

                case 'queryCashbackMonitorDiv9':
                    const cashbackData = await this.queryCashbackMonitorDiv9(message.store);
                    sendResponse({
                        success: true,
                        data: cashbackData,
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
        return this.wsConnectionManager.connect(wsUrl);
    }
    
    onWebSocketOpen() {
        return this.wsConnectionManager.onWebSocketOpen();
    }
    
    onWebSocketMessage(event) {
        return this.wsConnectionManager.onWebSocketMessage(event);
    }
    
    handleWebSocketMessage(data) {
        return this.wsConnectionManager.handleWebSocketMessage(data);
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

    normalizeCashbackMonitorStoreInput(raw = '') {
        const input = (raw || '').trim();
        if (!input) {
            return '';
        }

        try {
            if (/^https?:\/\//i.test(input)) {
                const url = new URL(input);
                const path = url.pathname || '';
                const match = path.match(/\/cashback-store\/([^/]+)\/?/i);
                if (match?.[1]) {
                    return decodeURIComponent(match[1]).trim();
                }
            }
        } catch (_) {
            // fall through
        }

        return input
            .toLowerCase()
            .replace(/^www\./, '')
            .replace(/\.com$/, '')
            .replace(/\/.*$/, '')
            .replace(/\s+/g, '');
    }

    async queryCashbackMonitorDiv9(store) {
        const normalized = this.normalizeCashbackMonitorStoreInput(store);
        if (!normalized) {
            throw new Error('请输入有效的店铺名或 CashbackMonitor 链接');
        }

        const tab = await this.openCashbackMonitorStoreTab(normalized);
        const extraction = await this.extractDiv9FromCashbackMonitorPage(tab.id);

        if (!extraction?.found) {
            throw new Error(extraction?.reason || '未找到 /html/body/div[9] 节点');
        }

        this.setLastActivity();
        this.lastError = null;
        this.savePersistedState();

        return {
            store: normalized,
            pageUrl: tab.url || `https://www.cashbackmonitor.com/cashback-store/${normalized}/`,
            xpath: extraction.xpath,
            text: extraction.text,
            html: extraction.html,
            meta: {
                tagName: extraction.tagName,
                id: extraction.id,
                className: extraction.className,
            },
        };
    }

    async openCashbackMonitorStoreTab(storeSlug) {
        const targetUrl = `https://www.cashbackmonitor.com/cashback-store/${encodeURIComponent(storeSlug)}/`;
        const existing = await this.findExistingCashbackMonitorTab();

        let tab;
        if (existing?.id) {
            tab = await chrome.tabs.update(existing.id, { url: targetUrl, active: true });
            this.cashbackMonitorTabId = tab.id;
            if (tab.windowId) {
                await chrome.windows.update(tab.windowId, { focused: true });
            }
        } else {
            tab = await chrome.tabs.create({ url: targetUrl, active: true });
            this.cashbackMonitorTabId = tab.id;
        }

        await this.waitForTabReadyGeneric(tab.id, 20000, 'CashbackMonitor');
        const latestTab = await chrome.tabs.get(tab.id);
        return latestTab;
    }

    async findExistingCashbackMonitorTab() {
        if (this.cashbackMonitorTabId) {
            try {
                const tab = await chrome.tabs.get(this.cashbackMonitorTabId);
                if (this.isCashbackMonitorUrl(tab.url)) {
                    return tab;
                }
            } catch (_) {
                this.cashbackMonitorTabId = null;
            }
        }

        const tabs = await chrome.tabs.query({ url: ['https://www.cashbackmonitor.com/*'] });
        return tabs.find((tab) => this.isCashbackMonitorUrl(tab.url)) || null;
    }

    isCashbackMonitorUrl(url = '') {
        return /^https:\/\/www\.cashbackmonitor\.com\//i.test(url || '');
    }

    async extractDiv9FromCashbackMonitorPage(tabId) {
        return extractCashbackMonitorDiv9FromTab(tabId);
    }

    async waitForTabReadyGeneric(tabId, timeoutMs = 15000, label = 'page') {
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
        throw new Error(`Timed out waiting for ${label} tab to load`);
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
        return this.wsConnectionManager.sendToBackend(data);
    }
    
    sendHeartbeat() {
        return this.wsConnectionManager.sendHeartbeat();
    }

    startHeartbeat() {
        return this.wsConnectionManager.startHeartbeat();
    }

    stopHeartbeat() {
        return this.wsConnectionManager.stopHeartbeat();
    }
    
    onWebSocketClose(event) {
        return this.wsConnectionManager.onWebSocketClose(event);
    }
    
    onWebSocketError(error) {
        return this.wsConnectionManager.onWebSocketError(error);
    }
    
    handleConnectionError(error) {
        return this.wsConnectionManager.handleConnectionError(error);
    }
    
    disconnect() {
        return this.wsConnectionManager.disconnect();
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