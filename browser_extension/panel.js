// 连接与状态面板（Popup 与 Side Panel 共用，交互模式参考 ChatHub 类侧栏应用）

class GrokConnectionPanel {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.grokTabId = null;
        this.messageCount = 0;

        this.initElements();
        this.loadSettings();
        this.setupEventListeners();
        this.updateStatus();

        this.checkBackgroundConnection();
    }

    initElements() {
        this.wsUrlInput = document.getElementById('wsUrl');
        this.connectBtn = document.getElementById('connectBtn');
        this.disconnectBtn = document.getElementById('disconnectBtn');
        this.connectionStatus = document.getElementById('connectionStatus');

        this.grokUrlInput = document.getElementById('grokUrl');
        this.autoOpenCheckbox = document.getElementById('autoOpen');
        this.openGrokBtn = document.getElementById('openGrokBtn');

        this.statusElement = document.getElementById('status');
        this.wsStatusElement = document.getElementById('wsStatus');
        this.grokTabStatusElement = document.getElementById('grokTabStatus');
        this.grokUrlStatusElement = document.getElementById('grokUrlStatus');
        this.pageStatusElement = document.getElementById('pageStatus');
        this.lastActivityElement = document.getElementById('lastActivity');
        this.messagesSentElement = document.getElementById('messagesSent');
        this.lastErrorElement = document.getElementById('lastError');

        this.refreshBtn = document.getElementById('refreshBtn');
        this.clearStatsBtn = document.getElementById('clearStatsBtn');
    }

    loadSettings() {
        chrome.storage.local.get(
            ['wsUrl', 'grokUrl', 'autoOpen', 'messageCount'],
            (result) => {
                if (result.wsUrl) {
                    this.wsUrlInput.value = result.wsUrl;
                }
                if (result.grokUrl) {
                    this.grokUrlInput.value = result.grokUrl;
                }
                if (result.autoOpen !== undefined) {
                    this.autoOpenCheckbox.checked = result.autoOpen;
                }
                if (result.messageCount) {
                    this.messageCount = result.messageCount;
                    this.messagesSentElement.textContent = this.messageCount;
                }
            }
        );
    }

    saveSettings() {
        chrome.storage.local.set({
            wsUrl: this.wsUrlInput.value,
            grokUrl: this.grokUrlInput.value,
            autoOpen: this.autoOpenCheckbox.checked,
            messageCount: this.messageCount,
        });
    }

    setupEventListeners() {
        this.connectBtn.addEventListener('click', () => this.connectToBackend());
        this.disconnectBtn.addEventListener('click', () => this.disconnectFromBackend());
        this.openGrokBtn.addEventListener('click', () => this.openGrokTab());
        this.refreshBtn.addEventListener('click', () => this.refreshStatus());
        this.clearStatsBtn.addEventListener('click', () => this.clearStats());

        this.wsUrlInput.addEventListener('change', () => this.saveSettings());
        this.grokUrlInput.addEventListener('change', () => this.saveSettings());
        this.autoOpenCheckbox.addEventListener('change', () => this.saveSettings());

        window.addEventListener('focus', () => this.refreshStatus());
        chrome.runtime.onMessage.addListener((message) => {
            if (message?.type === 'notification') {
                this.refreshStatus();
            }
        });
    }

    async checkBackgroundConnection() {
        try {
            const response = await chrome.runtime.sendMessage({ type: 'getStatus' });
            this.applyStatus(response);
        } catch (error) {
            this.updateConnectionStatus(false);
            this.updateGrokTabStatus();
            this.updatePageStatus(false, false);
            this.updateLastError(error.message);
        }
    }

    async connectToBackend() {
        const wsUrl = this.wsUrlInput.value.trim();

        if (!wsUrl) {
            this.showConnectionError('请输入 WebSocket 地址');
            return;
        }

        try {
            this.connectBtn.disabled = true;
            this.connectBtn.textContent = '连接中…';
            this.connectBtn.classList.add('connecting');

            const response = await chrome.runtime.sendMessage({
                type: 'connect',
                wsUrl: wsUrl,
            });

            if (response.success) {
                this.showConnectionSuccess('已连接本地后端');
                await this.refreshStatus();
                if (this.autoOpenCheckbox.checked) {
                    setTimeout(() => this.openGrokTab(), 500);
                }
            } else {
                this.showConnectionError(response.error || '连接失败');
                this.updateConnectionStatus(false);
            }
        } catch (error) {
            this.showConnectionError(`连接错误：${error.message}`);
            this.updateConnectionStatus(false);
        } finally {
            this.connectBtn.disabled = false;
            this.connectBtn.textContent = '连接';
            this.connectBtn.classList.remove('connecting');
        }
    }

    disconnectFromBackend() {
        chrome.runtime.sendMessage({ type: 'disconnect' }, (response) => {
            if (response && response.success) {
                this.showConnectionSuccess('已断开');
                this.updateConnectionStatus(false);
            }
        });
    }

    async openGrokTab() {
        const grokUrl = this.grokUrlInput.value.trim();

        if (!grokUrl) {
            alert('请输入有效的 Grok 地址');
            return;
        }

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'openGrokTab',
                grokUrl: grokUrl,
            });

            if (response && response.success) {
                this.grokTabId = response.tabId;
                this.showConnectionSuccess('已打开 Grok 标签页');
                await this.refreshStatus();
            } else {
                this.showConnectionError(response?.error || '打开标签页失败');
            }
        } catch (error) {
            this.showConnectionError(`打开标签页出错：${error.message}`);
        }
    }

    updateConnectionStatus(connected, clientId = null) {
        this.connected = connected;

        if (connected) {
            this.statusElement.textContent = '已连接';
            this.statusElement.className = 'status-indicator connected';
            this.wsStatusElement.textContent = clientId
                ? `已连接 (${clientId.substring(0, 8)}…)`
                : '已连接';
            this.wsStatusElement.style.color = '#10a37f';
            this.connectBtn.disabled = true;
            this.disconnectBtn.disabled = false;
        } else {
            this.statusElement.textContent = '未连接';
            this.statusElement.className = 'status-indicator disconnected';
            this.wsStatusElement.textContent = '未连接';
            this.wsStatusElement.style.color = '#666';
            this.connectBtn.disabled = false;
            this.disconnectBtn.disabled = true;
        }

        this.saveSettings();
    }

    updateGrokTabStatus(status = {}) {
        if (status.grokTabOpen && status.grokTabId) {
            this.grokTabStatusElement.textContent = `已打开 (ID: ${status.grokTabId})`;
            this.grokTabStatusElement.style.color = '#10a37f';
            this.grokUrlStatusElement.textContent =
                status.grokTabUrl || '已匹配 Grok 页面';
        } else {
            this.grokTabStatusElement.textContent = '未打开';
            this.grokTabStatusElement.style.color = '#666';
            this.grokUrlStatusElement.textContent = '未检测到 Grok 标签页';
        }
    }

    updatePageStatus(contentScriptReady, pageReady) {
        if (!contentScriptReady) {
            this.pageStatusElement.textContent = '内容脚本未就绪';
            this.pageStatusElement.style.color = '#666';
            return;
        }
        if (pageReady) {
            this.pageStatusElement.textContent = '页面就绪';
            this.pageStatusElement.style.color = '#10a37f';
            return;
        }
        this.pageStatusElement.textContent = '页面加载中或未登录';
        this.pageStatusElement.style.color = '#d97706';
    }

    updateLastActivity(activity) {
        this.lastActivityElement.textContent = activity
            ? new Date(activity).toLocaleString()
            : '无';
    }

    updateLastError(error) {
        if (error) {
            this.lastErrorElement.textContent = error;
            this.lastErrorElement.style.color = '#c62828';
            return;
        }
        this.lastErrorElement.textContent = '无';
        this.lastErrorElement.style.color = '#666';
    }

    showConnectionSuccess(message) {
        this.connectionStatus.textContent = message;
        this.connectionStatus.className = 'connection-status success';
        setTimeout(() => {
            this.connectionStatus.className = 'connection-status';
        }, 3000);
    }

    showConnectionError(message) {
        this.connectionStatus.textContent = message;
        this.connectionStatus.className = 'connection-status error';
        setTimeout(() => {
            this.connectionStatus.className = 'connection-status';
        }, 5000);
    }

    async refreshStatus() {
        this.refreshBtn.disabled = true;
        this.refreshBtn.textContent = '刷新中…';
        try {
            await this.checkBackgroundConnection();
        } finally {
            this.refreshBtn.disabled = false;
            this.refreshBtn.textContent = '刷新';
        }
    }

    clearStats() {
        this.messageCount = 0;
        this.messagesSentElement.textContent = '0';
        this.lastActivityElement.textContent = '无';
        chrome.storage.local.remove(['messageCount', 'lastActivity']);
    }

    updateStatus() {
        this.messagesSentElement.textContent = this.messageCount;
    }

    applyStatus(status) {
        if (!status) {
            this.updateConnectionStatus(false);
            this.updateGrokTabStatus();
            this.updatePageStatus(false, false);
            this.updateLastActivity(null);
            this.updateLastError(null);
            return;
        }
        this.connected = !!status.connected;
        this.grokTabId = status.grokTabId || null;
        this.messageCount = status.messageCount || 0;
        this.messagesSentElement.textContent = this.messageCount;
        this.updateConnectionStatus(this.connected, status.clientId);
        this.updateGrokTabStatus(status);
        this.updatePageStatus(status.contentScriptReady, status.pageReady);
        this.updateLastActivity(status.lastActivity);
        this.updateLastError(status.lastError);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.grokConnectionPanel = new GrokConnectionPanel();
});
