// Popup script for Grok AI Assistant extension

class GrokPopup {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.grokTabId = null;
        this.messageCount = 0;
        
        this.initElements();
        this.loadSettings();
        this.setupEventListeners();
        this.updateStatus();
        
        // Check initial connection
        this.checkBackgroundConnection();
    }
    
    initElements() {
        // Connection elements
        this.wsUrlInput = document.getElementById('wsUrl');
        this.connectBtn = document.getElementById('connectBtn');
        this.disconnectBtn = document.getElementById('disconnectBtn');
        this.connectionStatus = document.getElementById('connectionStatus');
        
        // Grok elements
        this.grokUrlInput = document.getElementById('grokUrl');
        this.autoOpenCheckbox = document.getElementById('autoOpen');
        this.openGrokBtn = document.getElementById('openGrokBtn');
        
        // Status elements
        this.statusElement = document.getElementById('status');
        this.wsStatusElement = document.getElementById('wsStatus');
        this.grokTabStatusElement = document.getElementById('grokTabStatus');
        this.grokUrlStatusElement = document.getElementById('grokUrlStatus');
        this.pageStatusElement = document.getElementById('pageStatus');
        this.lastActivityElement = document.getElementById('lastActivity');
        this.messagesSentElement = document.getElementById('messagesSent');
        this.lastErrorElement = document.getElementById('lastError');
        
        // Control elements
        this.refreshBtn = document.getElementById('refreshBtn');
        this.clearStatsBtn = document.getElementById('clearStatsBtn');
    }
    
    loadSettings() {
        chrome.storage.local.get([
            'wsUrl',
            'grokUrl',
            'autoOpen',
            'messageCount'
        ], (result) => {
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
        });
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
        // Connection buttons
        this.connectBtn.addEventListener('click', () => this.connectToBackend());
        this.disconnectBtn.addEventListener('click', () => this.disconnectFromBackend());
        
        // Grok buttons
        this.openGrokBtn.addEventListener('click', () => this.openGrokTab());
        
        // Control buttons
        this.refreshBtn.addEventListener('click', () => this.refreshStatus());
        this.clearStatsBtn.addEventListener('click', () => this.clearStats());
        
        // Save settings on change
        this.wsUrlInput.addEventListener('change', () => this.saveSettings());
        this.grokUrlInput.addEventListener('change', () => this.saveSettings());
        this.autoOpenCheckbox.addEventListener('change', () => this.saveSettings());
        
        // Check connection when popup opens
        window.addEventListener('focus', () => this.refreshStatus());
        chrome.runtime.onMessage.addListener((message) => {
            if (message?.type === 'notification') {
                this.refreshStatus();
            }
        });
    }
    
    async checkBackgroundConnection() {
        try {
            // Send message to background script to check connection status
            const response = await chrome.runtime.sendMessage({ type: 'getStatus' });

            this.applyStatus(response);
        } catch (error) {
            // Background script not responding
            this.updateConnectionStatus(false);
            this.updateGrokTabStatus();
            this.updatePageStatus(false, false);
            this.updateLastError(error.message);
        }
    }
    
    async connectToBackend() {
        const wsUrl = this.wsUrlInput.value.trim();
        
        if (!wsUrl) {
            this.showConnectionError('Please enter a WebSocket URL');
            return;
        }
        
        try {
            // Update UI
            this.connectBtn.disabled = true;
            this.connectBtn.textContent = 'Connecting...';
            this.connectBtn.classList.add('connecting');
            
            // Send connect request to background script
            const response = await chrome.runtime.sendMessage({
                type: 'connect',
                wsUrl: wsUrl
            });
            
            if (response.success) {
                this.showConnectionSuccess('Connected to backend');
                await this.refreshStatus();
                
                // Auto-open Grok tab if enabled
                if (this.autoOpenCheckbox.checked) {
                    setTimeout(() => this.openGrokTab(), 500);
                }
            } else {
                this.showConnectionError(response.error || 'Failed to connect');
                this.updateConnectionStatus(false);
            }
        } catch (error) {
            this.showConnectionError(`Connection error: ${error.message}`);
            this.updateConnectionStatus(false);
        } finally {
            this.connectBtn.disabled = false;
            this.connectBtn.textContent = 'Connect';
            this.connectBtn.classList.remove('connecting');
        }
    }
    
    disconnectFromBackend() {
        chrome.runtime.sendMessage({ type: 'disconnect' }, (response) => {
            if (response && response.success) {
                this.showConnectionSuccess('Disconnected successfully');
                this.updateConnectionStatus(false);
            }
        });
    }
    
    async openGrokTab() {
        const grokUrl = this.grokUrlInput.value.trim();
        
        if (!grokUrl) {
            alert('Please enter a valid Grok URL');
            return;
        }
        
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'openGrokTab',
                grokUrl: grokUrl
            });
            
            if (response && response.success) {
                this.grokTabId = response.tabId;
                this.showConnectionSuccess('Grok tab opened successfully');
                await this.refreshStatus();
            } else {
                this.showConnectionError(response?.error || 'Failed to open Grok tab');
            }
        } catch (error) {
            this.showConnectionError(`Error opening tab: ${error.message}`);
        }
    }
    
    updateConnectionStatus(connected, clientId = null) {
        this.connected = connected;
        
        if (connected) {
            this.statusElement.textContent = 'Connected';
            this.statusElement.className = 'status-indicator connected';
            
            this.wsStatusElement.textContent = clientId ? `Connected (${clientId.substring(0, 8)}...)` : 'Connected';
            this.wsStatusElement.style.color = '#10a37f';
            
            this.connectBtn.disabled = true;
            this.disconnectBtn.disabled = false;
        } else {
            this.statusElement.textContent = 'Disconnected';
            this.statusElement.className = 'status-indicator disconnected';
            
            this.wsStatusElement.textContent = 'Not connected';
            this.wsStatusElement.style.color = '#666';
            
            this.connectBtn.disabled = false;
            this.disconnectBtn.disabled = true;
        }
        
        this.saveSettings();
    }
    
    updateGrokTabStatus(status = {}) {
        if (status.grokTabOpen && status.grokTabId) {
            this.grokTabStatusElement.textContent = `Open (ID: ${status.grokTabId})`;
            this.grokTabStatusElement.style.color = '#10a37f';
            this.grokUrlStatusElement.textContent = status.grokTabUrl || 'Matched Grok page';
        } else {
            this.grokTabStatusElement.textContent = 'Not open';
            this.grokTabStatusElement.style.color = '#666';
            this.grokUrlStatusElement.textContent = 'No Grok tab detected';
        }
    }

    updatePageStatus(contentScriptReady, pageReady) {
        if (!contentScriptReady) {
            this.pageStatusElement.textContent = 'Content script not ready';
            this.pageStatusElement.style.color = '#666';
            return;
        }

        if (pageReady) {
            this.pageStatusElement.textContent = 'Page ready';
            this.pageStatusElement.style.color = '#10a37f';
            return;
        }

        this.pageStatusElement.textContent = 'Page loading or not logged in';
        this.pageStatusElement.style.color = '#d97706';
    }

    updateLastActivity(activity) {
        this.lastActivityElement.textContent = activity
            ? new Date(activity).toLocaleString()
            : 'Never';
    }

    updateLastError(error) {
        if (error) {
            this.lastErrorElement.textContent = error;
            this.lastErrorElement.style.color = '#c62828';
            return;
        }

        this.lastErrorElement.textContent = 'None';
        this.lastErrorElement.style.color = '#666';
    }
    
    showConnectionSuccess(message) {
        this.connectionStatus.textContent = message;
        this.connectionStatus.className = 'connection-status success';
        
        // Auto-hide after 3 seconds
        setTimeout(() => {
            this.connectionStatus.className = 'connection-status';
        }, 3000);
    }
    
    showConnectionError(message) {
        this.connectionStatus.textContent = message;
        this.connectionStatus.className = 'connection-status error';
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
            this.connectionStatus.className = 'connection-status';
        }, 5000);
    }
    
    async refreshStatus() {
        this.refreshBtn.disabled = true;
        this.refreshBtn.textContent = 'Refreshing...';

        try {
            await this.checkBackgroundConnection();
        } finally {
            this.refreshBtn.disabled = false;
            this.refreshBtn.textContent = 'Refresh';
        }
    }
    
    clearStats() {
        this.messageCount = 0;
        this.messagesSentElement.textContent = '0';
        this.lastActivityElement.textContent = 'Never';
        
        chrome.storage.local.remove(['messageCount', 'lastActivity']);
    }
    
    updateStatus() {
        // Update message count
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

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.grokPopup = new GrokPopup();
});