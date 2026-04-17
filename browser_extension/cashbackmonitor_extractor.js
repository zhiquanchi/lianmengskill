export const CASHBACKMONITOR_XPATHS = {
    div9: '/html/body/div[9]',
};

export async function extractCashbackMonitorDiv9FromTab(tabId) {
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [CASHBACKMONITOR_XPATHS.div9],
        func: (xpath) => {
            const getFirstNodeByXPath = (xpathExpression) => {
                try {
                    const snapshot = document.evaluate(
                        xpathExpression,
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    );
                    const node = snapshot.singleNodeValue;
                    return node instanceof HTMLElement ? node : null;
                } catch (_) {
                    return null;
                }
            };

            const node = getFirstNodeByXPath(xpath);
            if (!node) {
                return {
                    found: false,
                    xpath,
                    reason: 'XPath node not found',
                };
            }

            const text = (node.innerText || node.textContent || '').replace(/\s+\n/g, '\n').trim();
            const html = (node.innerHTML || '').trim();

            return {
                found: true,
                xpath,
                text,
                html,
                tagName: node.tagName,
                id: node.id || '',
                className: node.className || '',
            };
        },
    });

    return result || { found: false, reason: 'No result from extraction script' };
}

