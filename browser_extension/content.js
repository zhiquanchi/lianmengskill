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
        this.inputXPath = '/html/body/div[2]/div/div[3]/div/div/main/div[2]/div/div[2]/div/div[1]/form/div/div/div[2]/div[1]/div/div/div/p';
        
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
        const xpathMatch = this.getElementByXPath(this.inputXPath);
        if (xpathMatch) {
            return xpathMatch;
        }

        // Try various selectors for the chat input
        const selectors = [
            'textarea[data-testid*="chat"]',
            'textarea[aria-label*="message"]',
            'textarea[placeholder*="message"]',
            'textarea[placeholder*="ask"]',
            'textarea[placeholder*="prompt"]',
            'div[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"][data-testid*="chat"]',
            'input[type="text"]',
            '.chat-input',
            '#prompt-textarea',
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
    
    findSendButton() {
        // Try various selectors for send/submit button
        const selectors = [
            'button[data-testid*="send"]',
            'button[aria-label*="send"]',
            'button[aria-label*="submit"]',
            'button:has(svg)',
            '.send-button',
            '[data-testid="send-button"]',
            'button[type="submit"]'
        ];
        
        for (const selector of selectors) {
            const element = this.querySelectorSafe(selector);
            if (element && element.offsetParent !== null) {
                return element;
            }
        }

        const buttons = this.querySelectorAllSafe('button');
        return buttons.find((button) => {
            if (!button || button.offsetParent === null || button.disabled) {
                return false;
            }

            const label = [
                button.textContent,
                button.getAttribute('aria-label'),
                button.getAttribute('title'),
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();

            return ['send', 'submit', 'ask', 'grok'].some((keyword) =>
                label.includes(keyword)
            );
        }) || null;
        
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
            
            await this.fillInput(inputElement, question);
            
            // Step 2: Find and click send button
            const sendButton = await this.waitForElement(() => this.findSendButton(), 3000);
            if (sendButton) {
                await this.clickSendButton(sendButton);
            } else {
                await this.pressEnterToSend(inputElement);
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
    
    async fillInput(inputElement, text) {
        // Clear existing value
        if (inputElement.tagName === 'TEXTAREA' || inputElement.tagName === 'INPUT') {
            this.setNativeInputValue(inputElement, '');
            this.dispatchInputEvents(inputElement);
        } else if (inputElement.isContentEditable) {
            this.setContentEditableValue(inputElement, '');
        }
        
        await this.sleep(100);
        
        // Set new value
        if (inputElement.tagName === 'TEXTAREA' || inputElement.tagName === 'INPUT') {
            this.setNativeInputValue(inputElement, text);
            this.dispatchInputEvents(inputElement);
        } else if (inputElement.isContentEditable) {
            this.setContentEditableValue(inputElement, text);
        }
        
        // Focus the element
        inputElement.focus();
        inputElement.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
        inputElement.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
        
        await this.sleep(300);
    }
    
    async clickSendButton(button) {
        // Scroll into view if needed
        button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        await this.sleep(200);
        
        // Click the button
        button.click();
        
        // Also try dispatching events for good measure
        button.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
        }));
        
        await this.sleep(500);
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
        inputElement.focus();

        const keyboardEventInit = {
            bubbles: true,
            cancelable: true,
            key: 'Enter',
            code: 'Enter',
            which: 13,
            keyCode: 13,
        };

        inputElement.dispatchEvent(new KeyboardEvent('keydown', keyboardEventInit));
        inputElement.dispatchEvent(new KeyboardEvent('keypress', keyboardEventInit));
        inputElement.dispatchEvent(new KeyboardEvent('keyup', keyboardEventInit));

        if (inputElement.form) {
            inputElement.form.requestSubmit?.();
        }

        await this.sleep(500);
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

    setContentEditableValue(element, value) {
        element.focus();
        if (document.getSelection) {
            const selection = document.getSelection();
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        element.textContent = value;
        this.dispatchInputEvents(element);

        const parentEditable = element.closest('[contenteditable="true"]');
        if (parentEditable && parentEditable !== element) {
            parentEditable.textContent = value;
            this.dispatchInputEvents(parentEditable);
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