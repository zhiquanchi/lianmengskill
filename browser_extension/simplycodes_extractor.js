export const SIMPLYCODES_SELECTORS = {
    couponCards: [
        '[data-testid*="coupon"]',
        '[data-testid*="offer"]',
        'article',
        'li[class*="coupon"]',
        'div[class*="coupon"]',
        'div[class*="offer"]',
    ],
    topPickBadges: [
        '[class*="top"][class*="pick"]',
        '[data-testid*="top"]',
        '[aria-label*="Top pick"]',
        '[title*="Top pick"]',
    ],
    codeCandidates: [
        'code',
        '[class*="code"]',
        '[data-testid*="code"]',
        'button',
    ],
};

export async function extractSimplyCodesDiscountFromTab(tabId) {
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [SIMPLYCODES_SELECTORS],
        func: (selectors) => {
            const text = (document.body?.innerText || '').toLowerCase();
            const title = (document.title || '').toLowerCase();
            const blockedByCloudflare =
                title.includes('请稍候') ||
                title.includes('just a moment') ||
                text.includes('cloudflare') ||
                text.includes('security check') ||
                text.includes('正在进行安全验证');

            if (blockedByCloudflare) {
                return { blockedByCloudflare: true, found: false, reason: 'Blocked by Cloudflare' };
            }

            const safeQueryAll = (selector, root = document) => {
                try {
                    return Array.from(root.querySelectorAll(selector));
                } catch (_) {
                    return [];
                }
            };

            const getNodesByXPath = (xpathExpression) => {
                try {
                    const snapshot = document.evaluate(
                        xpathExpression,
                        document,
                        null,
                        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                        null
                    );
                    const nodes = [];
                    for (let i = 0; i < snapshot.snapshotLength; i++) {
                        const node = snapshot.snapshotItem(i);
                        if (node instanceof HTMLElement) {
                            nodes.push(node);
                        }
                    }
                    return nodes;
                } catch (_) {
                    return [];
                }
            };

            const discountXPath = '//*[@id="codes-grid"]/div/div/article/header/div/div/h3';
            const discountXPathNodes = getNodesByXPath(discountXPath);

            const getVerifiedPromosRoot = () => {
                try {
                    const xpathResult = document.evaluate(
                        '//*[@id="verified-promos-section"]',
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    );
                    const node = xpathResult.singleNodeValue;
                    return node instanceof HTMLElement ? node : null;
                } catch (_) {
                    return null;
                }
            };

            const parseDiscount = (rawText = '') => {
                const valueText = (rawText || '').replace(/\s+/g, ' ').trim();
                if (!valueText) {
                    return null;
                }

                const percentMatch = valueText.match(/(\d+(?:\.\d+)?)\s*%/);
                if (percentMatch) {
                    const value = Number.parseFloat(percentMatch[1]);
                    if (Number.isFinite(value)) {
                        return {
                            discountText: `${value}%`,
                            discountValue: value,
                            discountUnit: '%',
                            discountType: 'percent',
                        };
                    }
                }

                const moneyMatch =
                    valueText.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:off|discount|savings?)/i) ||
                    valueText.match(/\$(\d+(?:\.\d+)?)/);
                if (moneyMatch) {
                    const value = Number.parseFloat(moneyMatch[1]);
                    if (Number.isFinite(value)) {
                        return {
                            discountText: `$${value}`,
                            discountValue: value,
                            discountUnit: '$',
                            discountType: 'amount',
                        };
                    }
                }

                return null;
            };

            const couponCards = [];
            const seen = new Set();
            const verifiedPromosRoot = getVerifiedPromosRoot();
            if (!verifiedPromosRoot) {
                return {
                    found: false,
                    reason: 'verified-promos-section not found',
                };
            }

            for (const selector of selectors.couponCards || []) {
                for (const element of safeQueryAll(selector, verifiedPromosRoot)) {
                    if (!(element instanceof HTMLElement) || seen.has(element)) {
                        continue;
                    }
                    seen.add(element);
                    couponCards.push({ element, selector });
                }
            }

            const parsedCards = couponCards
                .map(({ element, selector }) => {
                    const cardText = (element.innerText || '').replace(/\s+/g, ' ').trim();
                    if (!cardText || !/(%|\$|off|discount|save|coupon|code)/i.test(cardText)) {
                        return null;
                    }

                    let bestPercentValue = null;
                    let bestAmountValue = null;
                    let percentValueSelector = discountXPath;
                    let amountValueSelector = discountXPath;
                    const valueCandidates = [];
                    for (const node of discountXPathNodes) {
                        if (!element.contains(node)) {
                            continue;
                        }
                        valueCandidates.push({
                            selector: discountXPath,
                            text: (node.textContent || '').trim(),
                        });
                    }

                    if (valueCandidates.length === 0) {
                        return null;
                    }

                    for (const candidate of valueCandidates) {
                        const parsed = parseDiscount(candidate.text);
                        if (!parsed) {
                            continue;
                        }
                        if (parsed.discountType === 'percent') {
                            if (!bestPercentValue || parsed.discountValue > bestPercentValue.discountValue) {
                                bestPercentValue = parsed;
                                percentValueSelector = candidate.selector;
                            }
                            continue;
                        }
                        if (parsed.discountType === 'amount') {
                            if (!bestAmountValue || parsed.discountValue > bestAmountValue.discountValue) {
                                bestAmountValue = parsed;
                                amountValueSelector = candidate.selector;
                            }
                        }
                    }

                    if (!bestPercentValue && !bestAmountValue) {
                        return null;
                    }

                    let topPickSelector = '';
                    for (const badgeSelector of selectors.topPickBadges || []) {
                        if (safeQueryAll(badgeSelector, element).length > 0) {
                            topPickSelector = badgeSelector;
                            break;
                        }
                    }
                    const textTopPick = /top\s*pick/i.test(cardText);

                    let couponCode = '';
                    for (const codeSelector of selectors.codeCandidates || []) {
                        const codeNode = safeQueryAll(codeSelector, element).find((node) =>
                            /^[A-Z0-9][A-Z0-9_-]{3,}$/i.test((node.textContent || '').trim())
                        );
                        if (codeNode) {
                            couponCode = (codeNode.textContent || '').trim();
                            break;
                        }
                    }

                    return {
                        selector,
                        topPickSelector: topPickSelector || (textTopPick ? 'text:top pick' : ''),
                        couponCode,
                        bestPercentValue,
                        bestAmountValue,
                        percentValueSelector,
                        amountValueSelector,
                    };
                })
                .filter(Boolean);

            if (parsedCards.length === 0) {
                return {
                    found: false,
                    reason: 'No discount parsed from xpath //*[@id="codes-grid"]/div/div/article/header/div/div/h3 within #verified-promos-section',
                };
            }

            const pickBestByType = (typeKey) =>
                parsedCards
                    .map((item) => ({
                        ...item,
                        bestValue: item[typeKey],
                        valueSelector:
                            typeKey === 'bestPercentValue' ? item.percentValueSelector : item.amountValueSelector,
                    }))
                    .filter((item) => item.bestValue)
                    .sort((a, b) => b.bestValue.discountValue - a.bestValue.discountValue)[0] || null;

            const bestPercentCard = pickBestByType('bestPercentValue');
            const bestAmountCard = pickBestByType('bestAmountValue');

            if (!bestPercentCard && !bestAmountCard) {
                return {
                    found: false,
                    reason: 'No valid percent or amount discount parsed from xpath within #verified-promos-section',
                };
            }

            const discountParts = [];
            if (bestAmountCard) {
                discountParts.push(`最高金额折扣 ${bestAmountCard.bestValue.discountText}`);
            }
            if (bestPercentCard) {
                discountParts.push(`最高比例折扣 ${bestPercentCard.bestValue.discountText}`);
            }

            const primaryChoice = bestPercentCard || bestAmountCard;
            const selectorParts = [];
            if (bestAmountCard) {
                selectorParts.push(
                    `amount(card:${bestAmountCard.selector}; value:${bestAmountCard.valueSelector}; topPick:${bestAmountCard.topPickSelector || 'none'})`
                );
            }
            if (bestPercentCard) {
                selectorParts.push(
                    `percent(card:${bestPercentCard.selector}; value:${bestPercentCard.valueSelector}; topPick:${bestPercentCard.topPickSelector || 'none'})`
                );
            }

            return {
                found: true,
                discountText: discountParts.join('；'),
                discountValue: primaryChoice.bestValue.discountValue,
                discountUnit: primaryChoice.bestValue.discountUnit,
                couponCode: primaryChoice.couponCode,
                source: 'Max discount by type',
                selector: selectorParts.join(' | '),
                maxPercentDiscount: bestPercentCard
                    ? {
                          discountText: bestPercentCard.bestValue.discountText,
                          discountValue: bestPercentCard.bestValue.discountValue,
                          discountUnit: bestPercentCard.bestValue.discountUnit,
                          couponCode: bestPercentCard.couponCode,
                          selector: `card:${bestPercentCard.selector}; value:${bestPercentCard.valueSelector}; topPick:${bestPercentCard.topPickSelector || 'none'}`,
                      }
                    : null,
                maxAmountDiscount: bestAmountCard
                    ? {
                          discountText: bestAmountCard.bestValue.discountText,
                          discountValue: bestAmountCard.bestValue.discountValue,
                          discountUnit: bestAmountCard.bestValue.discountUnit,
                          couponCode: bestAmountCard.couponCode,
                          selector: `card:${bestAmountCard.selector}; value:${bestAmountCard.valueSelector}; topPick:${bestAmountCard.topPickSelector || 'none'}`,
                      }
                    : null,
            };
        },
    });

    return result || { found: false, reason: 'No result from extraction script' };
}
