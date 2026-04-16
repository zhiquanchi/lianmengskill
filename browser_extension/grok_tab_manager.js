export class GrokTabManager {
    constructor(host) {
        this.host = host;
    }

    async prepareFreshConversation() {
        const host = this.host;
        if (!host.grokTabId) {
            return;
        }

        let tab;
        try {
            tab = await chrome.tabs.get(host.grokTabId);
        } catch (_) {
            return;
        }

        const freshUrl = this.getFreshConversationUrl(tab.url || host.grokTabUrl || 'https://grok.com/');
        if (freshUrl && tab.url !== freshUrl) {
            await chrome.tabs.update(host.grokTabId, { url: freshUrl, active: true });
            await this.waitForTabComplete(host.grokTabId, 15000);
            host.grokTabUrl = freshUrl;
            host.contentScriptReady = false;
            host.pageReady = false;
            host.savePersistedState();
            return;
        }

        await chrome.tabs.update(host.grokTabId, { active: true });
        if (tab.windowId) {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
    }

    async openGrokTab(grokUrl = 'https://grok.com') {
        const host = this.host;
        try {
            const normalizedUrl = this.normalizeGrokUrl(grokUrl);
            const existingTab = await this.findExistingGrokTab();
            if (existingTab?.id) {
                host.grokTabId = existingTab.id;
                host.grokTabUrl = existingTab.url || normalizedUrl;
                host.pageReady = false;
                host.contentScriptReady = false;
                await chrome.tabs.update(existingTab.id, { active: true, url: existingTab.url || normalizedUrl });
                await chrome.windows.update(existingTab.windowId, { focused: true });
                await this.ensureContentScriptInjected();
                host.setLastActivity();
                host.savePersistedState();
                return existingTab.id;
            }

            const tab = await chrome.tabs.create({
                url: normalizedUrl,
                active: true,
            });

            host.grokTabId = tab.id;
            host.grokTabUrl = tab.url || normalizedUrl;
            host.pageReady = false;
            host.contentScriptReady = false;
            host.lastError = null;
            host.setLastActivity();
            host.savePersistedState();

            console.log(`Opened Grok tab with ID: ${host.grokTabId}`);

            await host.sleep(2000);
            await this.ensureContentScriptInjected();
            return host.grokTabId;
        } catch (error) {
            console.error('Error opening Grok tab:', error);
            host.grokTabId = null;
            host.grokTabUrl = null;
            host.contentScriptReady = false;
            host.pageReady = false;
            host.recordError(error?.message || 'Failed to open Grok tab');
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
        const host = this.host;
        if (!host.grokTabId) {
            return false;
        }

        try {
            const response = await chrome.tabs.sendMessage(host.grokTabId, { type: 'ping' });
            host.contentScriptReady = !!response?.success;
            host.pageReady = !!response?.ready;
            host.lastError = null;
            host.savePersistedState();
            return true;
        } catch (_) {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: host.grokTabId },
                    files: ['content.js'],
                });
                console.log('Content script injected');
                host.contentScriptReady = true;
                host.lastError = null;
                host.savePersistedState();
                return true;
            } catch (injectError) {
                console.error('Failed to inject content script:', injectError);
                host.recordError(injectError?.message || 'Failed to inject content script');
                return false;
            }
        }
    }

    async refreshTabState() {
        const host = this.host;
        const existingTab = await this.findExistingGrokTab();
        if (!existingTab?.id) {
            host.grokTabId = null;
            host.grokTabUrl = null;
            host.contentScriptReady = false;
            host.pageReady = false;
            host.savePersistedState();
            return {
                grokTabId: null,
                grokTabUrl: null,
                grokTabOpen: false,
                contentScriptReady: false,
                pageReady: false,
            };
        }

        host.grokTabId = existingTab.id;
        host.grokTabUrl = existingTab.url || null;

        try {
            const response = await chrome.tabs.sendMessage(existingTab.id, { type: 'getStatus' });
            host.contentScriptReady = !!response;
            host.pageReady = !!response?.ready;
            host.lastError = null;
        } catch (_) {
            host.contentScriptReady = false;
            host.pageReady = false;
        }

        host.savePersistedState();

        return {
            grokTabId: host.grokTabId,
            grokTabUrl: host.grokTabUrl,
            grokTabOpen: true,
            contentScriptReady: host.contentScriptReady,
            pageReady: host.pageReady,
        };
    }

    async findExistingGrokTab() {
        const host = this.host;
        if (host.grokTabId) {
            try {
                const tab = await chrome.tabs.get(host.grokTabId);
                if (this.isSupportedGrokUrl(tab.url)) {
                    return tab;
                }
            } catch (_) {
                host.grokTabId = null;
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
}
