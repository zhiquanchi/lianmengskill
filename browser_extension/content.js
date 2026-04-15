// Content script for Grok AI website (chat.x.ai)
// Injected into the Grok page to interact with the chat interface

class GrokContentScript {
    constructor() {
        this.isReady = false;
        this.isProcessing = false;
        this.currentQuestion = null;
        this.answerObserver = null;
        this.maxWaitTime = 30000; // 30 seconds max wait for response
        this.pollInterval = 500; // Check every 500ms
        this.newConversationXPath = '/html/body/div[2]/div/div[2]/div/div[1]/div[2]/div[2]';
        this.inputContainerXPath =
            '/html/body/div[2]/div/div[2]/div/div/main/div[2]/div[3]/div[1]/div[2]/div/form/div/div/div[2]/div[1]/div/div/div';
        this.inputXPath =
            '/html/body/div[2]/div/div[2]/div/div/main/div[2]/div[3]/div[1]/div[2]/div/form/div/div/div[2]/div[1]/div/div/div/p';
        this.submitButtonXPath =
            '/html/body/div[2]/div/div[2]/div/div/main/div[2]/div[3]/div[1]/div[2]/div/form/div/div/div[2]/div[2]/div/div[2]/div[3]/button';
        
        this.setupMessageListener();
        this.initializeObserver();
        
        // Notify background script that content script is ready
        this.sendReadySignal();
    }
    
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleBackgroundMessage(message, sender, sendResponse);
            return true; // Keep message channel open for async response
        });
    }
    
    async handleBackgroundMessage(message, sender, sendResponse) {
        try {
            switch (message.type) {
                case 'ping':
                    sendResponse({ success: true, ready: this.isReady });
                    break;
                    
                case 'sendQuestion':
                    const answer = await this.sendQuestion(message.question, {
                        newConversation: message.newConversation !== false,
                    });
                    sendResponse({ 
                        success: !!answer, 
                        answer: answer 
                    });
                    break;
                    
                case 'getStatus':
                    sendResponse({
                        ready: this.isReady,
                        isProcessing: this.isProcessing,
                        url: window.location.href
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
            sendResponse({ 
                success: false, 
                error: error.message 
            });
        }
    }
    
    sendReadySignal() {
        // Notify background script that we're ready
        chrome.runtime.sendMessage({ 
            type: 'contentScriptReady',
            url: window.location.href 
        }).catch(() => {
            // Background script not ready yet, retry
            setTimeout(() => this.sendReadySignal(), 1000);
        });
    }
    
    initializeObserver() {
        // Set up MutationObserver to detect when page is ready
        this.observer = new MutationObserver((mutations) => {
            this.checkPageReady();
        });
        
        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false
        });
        
        // Initial check
        setTimeout(() => this.checkPageReady(), 1000);
    }
    
    checkPageReady() {
        // Check if we can find key elements on the page
        // This will need to be adjusted based on actual Grok UI
        
        const hasInput = this.findInputElement();
        const hasSendButton = this.findSendButton();
        const hasChatContainer = this.findChatContainer();
        const hasNewConversationButton = this.findNewConversationButton();
        
        if ((hasInput && hasSendButton && hasChatContainer) || hasNewConversationButton) {
            if (!this.isReady) {
                console.log('Grok page is ready');
                this.isReady = true;
                
                // Notify background script
                chrome.runtime.sendMessage({
                    type: 'pageReady',
                    url: window.location.href
                }).catch(console.error);
            }
        } else {
            if (this.isReady) {
                console.log('Grok page elements lost');
                this.isReady = false;
            }
        }
    }

    querySelectorSafe(selector, root = document) {
        try {
            return root.querySelector(selector);
        } catch (error) {
            console.debug(`Invalid selector skipped: ${selector}`, error);
            return null;
        }
    }

    querySelectorAllSafe(selector, root = document) {
        try {
            return Array.from(root.querySelectorAll(selector));
        } catch (error) {
            console.debug(`Invalid selector skipped: ${selector}`, error);
            return [];
        }
    }

    getElementByXPath(xpath, root = document) {
        try {
            const result = document.evaluate(
                xpath,
                root,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
            );
            return result.singleNodeValue;
        } catch (error) {
            console.debug(`Invalid XPath skipped: ${xpath}`, error);
            return null;
        }
    }

    getElementLabel(element) {
        return [
            element?.textContent,
            element?.getAttribute?.('aria-label'),
            element?.getAttribute?.('title'),
            element?.getAttribute?.('data-testid'),
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .trim();
    }
    
    // DOM element finders - these need to be customized for actual Grok UI
    findInputElement() {
        const containerByXPath = this.getElementByXPath(this.inputContainerXPath);
        if (containerByXPath) {
            return containerByXPath;
        }

        const xpathMatch = this.getElementByXPath(this.inputXPath);
        if (xpathMatch) {
            return xpathMatch;
        }

        // Try various selectors for the chat input
        const selectors = [
            'div[contenteditable="true"]',
            '.tiptap.ProseMirror',
            '[data-lexical-editor="true"]',
            'textarea'
        ];
        
        for (const selector of selectors) {
            const element = this.querySelectorSafe(selector);
            if (element && element.offsetParent !== null) {
                return element;
            }
        }
        
        return null;
    }
    
    isLikelySendButton(button) {
        if (!button || button.tagName !== 'BUTTON' || button.offsetParent === null || button.disabled) {
            return false;
        }

        const type = (button.getAttribute('type') || '').toLowerCase();
        const label = this.getElementLabel(button);
        const dataTestId = (button.getAttribute('data-testid') || '').toLowerCase();
        const className = (button.className || '').toLowerCase();
        const attrs = `${type} ${label} ${dataTestId} ${className}`;

        const denyKeywords = [
            'refer',
            'quote',
            'content',
            'attach',
            'upload',
            'search',
            'tool',
            'voice',
            'mic',
            'image',
            'plus',
            'new chat',
            'new conversation',
        ];
        if (denyKeywords.some((keyword) => attrs.includes(keyword))) {
            return false;
        }

        if (type === 'submit') {
            return true;
        }

        const allowKeywords = ['send', 'submit', 'ask', 'grok', 'enter'];
        return allowKeywords.some((keyword) => attrs.includes(keyword));
    }

    findSendButton(inputElement = null) {
        const root = this.getEditableRoot(inputElement || this.findInputElement());
        const form = root?.closest?.('form') || null;

        if (form) {
            const formButtons = this.querySelectorAllSafe('button', form);
            const inFormSubmit = formButtons.find((button) => this.isLikelySendButton(button));
            if (inFormSubmit) {
                return inFormSubmit;
            }
        }

        // XPath 作为兜底，不再作为优先路径，避免误点到“引用内容”等功能按钮。
        const xpathMatch = this.getElementByXPath(this.submitButtonXPath);
        if (xpathMatch && this.isLikelySendButton(xpathMatch)) {
            return xpathMatch;
        }

        // Global fallback
        const buttons = this.querySelectorAllSafe('button');
        return buttons.find((button) => this.isLikelySendButton(button)) || null;
    }
    
    findChatContainer() {
        // Try to find the chat message container
        const selectors = [
            '.chat-container',
            '.messages',
            '[role="log"]',
            '.conversation',
            'main',
            'article'
        ];
        
        for (const selector of selectors) {
            const element = this.querySelectorSafe(selector);
            if (element && element.offsetParent !== null) {
                return element;
            }
        }
        
        // Fallback to body
        return document.body;
    }
    
    findLatestMessage(container) {
        // Find the latest message in the chat
        // This is highly dependent on Grok's HTML structure
        
        // Common selectors for chat messages
        const messageSelectors = [
            '.message',
            '[data-message-id]',
            '.chat-message',
            '.assistant-message',
            '.user-message',
            'div[class*="message"]',
            'div[role="article"]'
        ];
        
        let allMessages = [];
        
        for (const selector of messageSelectors) {
            const messages = this.querySelectorAllSafe(selector, container);
            if (messages.length > 0) {
                allMessages = messages;
                break;
            }
        }
        
        if (allMessages.length === 0) {
            // Try to find any divs that might be messages
            const divs = container.querySelectorAll('div');
            allMessages = Array.from(divs).filter(div => {
                const text = div.textContent || '';
                return text.length > 10 && !div.querySelector('div'); // Simple heuristic
            });
        }
        
        // Return the last message (most recent)
        return allMessages.length > 0 ? allMessages[allMessages.length - 1] : null;
    }
    
    async sendQuestion(question, options = {}) {
        if (this.isProcessing) {
            throw new Error('Already processing a question');
        }

        if (!options.newConversation && !this.isReady) {
            throw new Error('Page not ready. Please wait for Grok to load.');
        }
        
        this.isProcessing = true;
        this.currentQuestion = question;
        
        try {
            console.log(`Sending question to Grok: ${question.substring(0, 100)}...`);

            if (options.newConversation) {
                await this.startNewConversation();
            }

            const chatContainer = this.findChatContainer();
            const previousLatestMessage = chatContainer
                ? this.extractMessageText(this.findLatestMessage(chatContainer) || document.createElement('div'))
                : '';
            
            // Step 1: Find and fill the input
            const inputElement = await this.waitForElement(() => this.findInputElement());
            if (!inputElement) {
                throw new Error('Could not find input element');
            }

            window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
            await this.sleep(250);
            await this.clickElement(inputElement);

            // Grok 等页面用 React/ProseMirror：直接改 DOM 往往不会进内部状态，需模拟真实键入后再回车发送
            await this.typeTextUserLike(inputElement, question);
            await this.ensureDraftMatchesQuestion(inputElement, question);
            await this.pressEnterToSend(inputElement);
            await this.sleep(220);

            // Enter 未触发发送时，再尝试点击明确识别为 submit 的按钮。
            const sendButton = this.findSendButton(inputElement);
            const draftAfterEnter = this.normalizeDraftText(
                this.readCurrentDraft(this.getEditableRoot(inputElement))
            );
            const expectedDraft = this.normalizeDraftText(question);
            const enterTriggered = sendButton ? this.isSendButtonBusy(sendButton) : draftAfterEnter !== expectedDraft;

            if (!enterTriggered && sendButton) {
                await this.clickSendButton(sendButton);
                await this.waitForGenerationCycle(sendButton);
            }
            
            // Step 3: Wait for and extract the answer
            const answer = await this.waitForAnswer(previousLatestMessage);
            
            console.log(`Got answer from Grok: ${answer.substring(0, 100)}...`);
            return answer;
            
        } finally {
            this.isProcessing = false;
            this.currentQuestion = null;
        }
    }

    async startNewConversation() {
        const existingInput = this.findInputElement();
        if (existingInput) {
            return;
        }

        const newChatButton = await this.waitForElement(() => this.findNewConversationButton(), 5000);
        if (!newChatButton) {
            throw new Error('Could not find new conversation button');
        }

        await this.clickElement(newChatButton);
        await this.sleep(1500);

        const inputAfterClick = await this.waitForElement(() => this.findInputElement(), 8000);
        if (!inputAfterClick) {
            throw new Error('New conversation opened, but input box was not found');
        }
    }

    findNewConversationButton() {
        const xpathMatch = this.getElementByXPath(this.newConversationXPath);
        if (xpathMatch) {
            return xpathMatch;
        }

        const selectors = [
            'a[href="/"]',
            'a[href="/home"]',
            'button[data-testid*="new"]',
            'a[data-testid*="new"]',
            'button[aria-label*="new"]',
            'a[aria-label*="new"]',
        ];

        for (const selector of selectors) {
            const matches = this.querySelectorAllSafe(selector);
            const match = matches.find((element) => {
                if (!element || element.offsetParent === null) {
                    return false;
                }

                const label = this.getElementLabel(element);
                return ['new', 'chat', 'conversation', 'thread'].some((keyword) =>
                    label.includes(keyword)
                );
            });

            if (match) {
                return match;
            }
        }

        const candidates = this.querySelectorAllSafe('button, a');
        return candidates.find((element) => {
            if (!element || element.offsetParent === null) {
                return false;
            }

            const label = this.getElementLabel(element);
            return (
                ['new chat', 'new conversation', 'start new chat', 'new thread'].some((keyword) =>
                    label.includes(keyword)
                )
            );
        }) || null;
    }
    
    async waitForElement(elementFinder, timeout = 10000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            const element = elementFinder();
            if (element) {
                return element;
            }
            await this.sleep(200);
        }
        
        return null;
    }
    
    /**
     * 返回实际可编辑根节点（Grok 常见为外层 contenteditable div，内层为 p）
     */
    getEditableRoot(element) {
        if (!element) {
            return null;
        }
        if (element.isContentEditable) {
            return element;
        }
        return element.closest('[contenteditable="true"]') || element;
    }

    /**
     * 在光标处用 insertText 写入字符，让框架收到真实 input 流；必要时逐字插入。
     */
    async typeTextUserLike(element, text) {
        const value = text ?? '';
        const isNative =
            element.tagName === 'TEXTAREA' || element.tagName === 'INPUT';

        if (isNative) {
            element.focus();
            await this.sleep(50);
            this.setNativeInputValue(element, '');
            this.dispatchInputEvents(element);
            await this.sleep(30);
            let acc = '';
            for (const ch of value) {
                acc += ch;
                this.setNativeInputValue(element, acc);
                element.dispatchEvent(
                    new InputEvent('input', {
                        bubbles: true,
                        cancelable: false,
                        inputType: 'insertText',
                        data: ch,
                    })
                );
                await this.sleep(8);
            }
            element.dispatchEvent(new Event('change', { bubbles: true }));
            await this.sleep(120);
            return;
        }

        const root = this.getEditableRoot(element);
        if (!root) {
            throw new Error('Could not resolve editable root for typing');
        }

        root.focus();
        await this.sleep(80);

        const selection = window.getSelection();
        const clearRange = document.createRange();
        clearRange.selectNodeContents(root);
        clearRange.deleteContents();

        const caret = document.createRange();
        caret.setStart(root, 0);
        caret.collapse(true);
        selection.removeAllRanges();
        selection.addRange(caret);

        let inserted = false;
        try {
            inserted = document.execCommand('insertText', false, value);
        } catch (_) {
            inserted = false;
        }

        if (!inserted && value.length > 0) {
            for (const ch of value) {
                try {
                    document.execCommand('insertText', false, ch);
                } catch (_) {
                    /* ignore single char failure */
                }
                await this.sleep(12);
            }
        }

        if (this.normalizeDraftText(this.readCurrentDraft(root)) !== this.normalizeDraftText(value)) {
            this.replaceEditableText(root, value);
        }

        root.dispatchEvent(
            new InputEvent('input', {
                bubbles: true,
                cancelable: false,
                inputType: 'insertText',
                data: value.length ? value : null,
            })
        );
        root.dispatchEvent(new Event('change', { bubbles: true }));
        await this.sleep(150);
    }

    readCurrentDraft(element) {
        if (!element) {
            return '';
        }
        const isNative =
            element.tagName === 'TEXTAREA' || element.tagName === 'INPUT';
        if (isNative) {
            return element.value || '';
        }
        return (element.innerText || element.textContent || '').replace(/\u200B/g, '');
    }

    normalizeDraftText(text) {
        return (text || '')
            .replace(/\r\n/g, '\n')
            .replace(/\u00A0/g, ' ')
            .replace(/\u200B/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    replaceEditableText(root, value) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(root);
        range.deleteContents();

        if (value) {
            const textNode = document.createTextNode(value);
            root.appendChild(textNode);
            range.setStart(textNode, value.length);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        } else {
            range.setStart(root, 0);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }

    async ensureDraftMatchesQuestion(inputElement, expectedQuestion) {
        const root = this.getEditableRoot(inputElement);
        if (!root) {
            throw new Error('Could not resolve editable root for draft validation');
        }
        const expected = this.normalizeDraftText(expectedQuestion);
        let current = this.normalizeDraftText(this.readCurrentDraft(root));
        if (current === expected) {
            return;
        }

        // 首次注入失败时，使用更直接的 fallback 再写入一遍。
        this.replaceEditableText(root, expectedQuestion || '');
        root.dispatchEvent(
            new InputEvent('input', {
                bubbles: true,
                cancelable: false,
                inputType: 'insertText',
                data: expectedQuestion ? expectedQuestion : null,
            })
        );
        root.dispatchEvent(new Event('change', { bubbles: true }));
        await this.sleep(120);

        current = this.normalizeDraftText(this.readCurrentDraft(root));
        if (current !== expected) {
            throw new Error(`Draft mismatch before send. expected="${expected.slice(0, 80)}", actual="${current.slice(0, 80)}"`);
        }
    }
    
    async clickSendButton(button) {
        // Scroll into view if needed
        button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        await this.sleep(200);
        
        // 只点击一次，避免误触发附加动作（例如引用内容按钮）
        button.click();
        await this.sleep(500);
    }

    isSendButtonBusy(button) {
        if (!button) {
            return false;
        }

        const ariaDisabled = button.getAttribute('aria-disabled') === 'true';
        const label = this.getElementLabel(button);
        const hasBusyLabel =
            label.includes('stop') ||
            label.includes('generating') ||
            label.includes('thinking');

        return !!button.disabled || ariaDisabled || hasBusyLabel;
    }

    async waitForGenerationCycle(button) {
        // 参考 ChatHub 一类扩展的交互逻辑：先等发送开始，再等发送结束。
        const startDeadline = Date.now() + 5000;
        let started = false;

        while (Date.now() < startDeadline) {
            if (this.isSendButtonBusy(button)) {
                started = true;
                break;
            }
            await this.sleep(120);
        }

        if (!started) {
            return;
        }

        const finishDeadline = Date.now() + this.maxWaitTime;
        while (Date.now() < finishDeadline) {
            if (!this.isSendButtonBusy(button)) {
                return;
            }
            await this.sleep(250);
        }
    }

    async clickElement(element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await this.sleep(200);
        element.click?.();
        element.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window,
        }));
        element.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            view: window,
        }));
        element.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
        }));
        await this.sleep(500);
    }

    async pressEnterToSend(inputElement) {
        const root = this.getEditableRoot(inputElement);
        const targets = [];
        if (root && root !== inputElement) {
            targets.push(root, inputElement);
        } else {
            targets.push(inputElement);
        }

        const keyboardEventInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            charCode: 0,
        };

        for (const el of targets) {
            el.focus();
            await this.sleep(40);
            el.dispatchEvent(new KeyboardEvent('keydown', keyboardEventInit));
            el.dispatchEvent(new KeyboardEvent('keypress', keyboardEventInit));
            el.dispatchEvent(new KeyboardEvent('keyup', keyboardEventInit));
        }

        if (inputElement.form) {
            inputElement.form.requestSubmit?.();
        }

        await this.sleep(600);
    }

    setNativeInputValue(element, value) {
        const prototype = element.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor?.set) {
            descriptor.set.call(element, value);
        } else {
            element.value = value;
        }
    }

    dispatchInputEvents(element) {
        element.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            data: null,
            inputType: 'insertText',
        }));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    async waitForAnswer(previousLatestMessage = '') {
        const chatContainer = this.findChatContainer();
        if (!chatContainer) {
            throw new Error('Could not find chat container');
        }
        
        const startTime = Date.now();
        let lastMessageCount = 0;
        let lastMessageText = '';
        let stableCount = 0;
        
        console.log('Waiting for Grok response...');
        
        while (Date.now() - startTime < this.maxWaitTime) {
            const latestMessage = this.findLatestMessage(chatContainer);
            
            if (latestMessage) {
                const messageText = this.extractMessageText(latestMessage);
                const normalizedCurrentQuestion = (this.currentQuestion || '').trim();
                
                if (
                    messageText &&
                    messageText !== previousLatestMessage &&
                    messageText !== normalizedCurrentQuestion &&
                    messageText !== lastMessageText
                ) {
                    // New message text detected
                    lastMessageText = messageText;
                    lastMessageCount++;
                    stableCount = 0;
                    
                    console.log(`New message text detected (length: ${messageText.length})`);
                } else if (messageText && messageText === lastMessageText) {
                    // Same text, check if it's stable
                    stableCount++;
                    
                    if (stableCount >= 3) {
                        // Text has been stable for 3 checks (1.5 seconds)
                        console.log('Answer text stabilized, returning...');
                        return messageText;
                    }
                }
            }
            
            await this.sleep(this.pollInterval);
        }
        
        throw new Error(`Timeout waiting for answer. Last text: ${lastMessageText.substring(0, 100)}...`);
    }
    
    extractMessageText(messageElement) {
        // Extract clean text from message element
        // Remove any buttons, input elements, etc.
        
        const clone = messageElement.cloneNode(true);
        
        // Remove interactive elements
        const toRemove = clone.querySelectorAll('button, input, textarea, a[href]');
        toRemove.forEach(el => el.remove());
        
        // Get text content and clean it
        let text = clone.textContent || '';
        
        // Clean up the text
        text = text.trim();
        text = text.replace(/\s+/g, ' '); // Normalize whitespace
        text = text.replace(/\n+/g, '\n'); // Normalize newlines
        
        // Remove common UI text that's not part of the answer
        const uiPatterns = [
            /Loading\.\.\./g,
            /Thinking\.\.\./g,
            /Type a message\.\.\./g,
            /Send a message\.\.\./g
        ];
        
        uiPatterns.forEach(pattern => {
            text = text.replace(pattern, '');
        });
        
        return text.trim();
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Initialize content script when page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.grokContentScript = new GrokContentScript();
    });
} else {
    window.grokContentScript = new GrokContentScript();
}

// Export for debugging
console.log('Grok AI Content Script loaded');