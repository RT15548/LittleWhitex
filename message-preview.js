import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";

const EXT_ID = "LittleWhiteBox";
const CONSTANTS = {
    MAX_HISTORY_RECORDS: 15,
    TARGET_ENDPOINT: '/api/backends/chat-completions/generate',
    CLEANUP_INTERVAL: 300000,
    DEBOUNCE_DELAY: 300
};

let isPreviewMode = false;
let capturedPreviewData = null;
let originalFetch = null;
let previewMessageIds = new Set();
let apiRequestHistory = [];
let isInterceptorActive = false;
let cleanupTimer = null;
let eventListeners = [];
let previewPromiseResolve = null;

function getSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = {};
    }
    if (!extension_settings[EXT_ID].preview) {
        extension_settings[EXT_ID].preview = {
            enabled: true,
            timeoutSeconds: 5
        };
    }
    return extension_settings[EXT_ID].preview;
}

function isTargetApiRequest(url, options = {}) {
    return url?.includes(CONSTANTS.TARGET_ENDPOINT) && 
           options.body && String(options.body).includes('"messages"');
}

function restoreOriginalFetch() {
    if (originalFetch && isInterceptorActive) {
        window.fetch = originalFetch;
        originalFetch = null;
        isInterceptorActive = false;
    }
}

function setupInterceptor() {
    restoreOriginalFetch();
    originalFetch = window.fetch;
    isInterceptorActive = true;
    
    window.fetch = function(url, options = {}) {
        const callOriginal = () => originalFetch.call(window, url, options);
        
        if (isTargetApiRequest(url, options)) {
            if (isPreviewMode) {
                return handlePreviewInterception(url, options);
            } else {
                recordRealApiRequest(url, options);
            }
        }
        
        return callOriginal();
    };
}

function recordRealApiRequest(url, options) {
    try {
        const requestData = JSON.parse(options.body);
        const context = getContext();
        const userInput = extractUserInputFromMessages(requestData.messages || []);
        
        const historyItem = {
            url,
            requestData,
            messages: requestData.messages || [],
            model: requestData.model || 'Unknown',
            timestamp: Date.now(),
            messageId: context.chat?.length || 0,
            characterName: context.characters?.[context.characterId]?.name || 'Unknown',
            userInput,
            isRealRequest: true
        };
        
        apiRequestHistory.unshift(historyItem);
        if (apiRequestHistory.length > CONSTANTS.MAX_HISTORY_RECORDS) {
            apiRequestHistory = apiRequestHistory.slice(0, CONSTANTS.MAX_HISTORY_RECORDS);
        }
    } catch (error) {}
}

async function handlePreviewInterception(url, options) {
    try {
        const requestData = JSON.parse(options.body);
        const userInput = extractUserInputFromMessages(requestData?.messages || []);
        
        capturedPreviewData = {
            url,
            requestData,
            messages: requestData?.messages || [],
            model: requestData?.model || 'Unknown',
            timestamp: Date.now(),
            userInput,
            isPreview: true
        };
        
        if (previewPromiseResolve) {
            previewPromiseResolve({ success: true, data: capturedPreviewData });
            previewPromiseResolve = null;
        }
        
        return new Response(JSON.stringify({
            choices: [{
                message: { content: "✓ 预览模式：请求已拦截" },
                finish_reason: "stop"
            }]
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
        
    } catch (error) {
        if (previewPromiseResolve) {
            previewPromiseResolve({ success: false, error: error.message });
            previewPromiseResolve = null;
        }
        return new Response(JSON.stringify({
            error: { message: "✘ 预览失败: " + error.message }
        }), { status: 500 });
    }
}

function interceptMessageCreation() {
    const context = getContext();
    const originalPush = context.chat.push;
    
    context.chat.push = function(...items) {
        if (isPreviewMode) {
            const startId = context.chat.length;
            const result = originalPush.apply(this, items);
            for (let i = 0; i < items.length; i++) {
                previewMessageIds.add(startId + i);
            }
            return result;
        }
        return originalPush.apply(this, items);
    };
    
    return function restore() {
        context.chat.push = originalPush;
        if (previewMessageIds.size > 0) {
            const idsToDelete = Array.from(previewMessageIds).sort((a, b) => b - a);
            idsToDelete.forEach(id => {
                if (id < context.chat.length) {
                    context.chat.splice(id, 1);
                }
            });
            previewMessageIds.clear();
        }
    };
}

function extractUserInputFromMessages(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
            return messages[i].content || '';
        }
    }
    return '';
}

function waitForPreviewInterception() {
    const settings = getSettings();
    const timeoutMs = settings.timeoutSeconds * 1000;
    
    return new Promise((resolve) => {
        previewPromiseResolve = resolve;
        setTimeout(() => {
            if (previewPromiseResolve) {
                previewPromiseResolve({ success: false, error: `等待超时 (${settings.timeoutSeconds}秒)` });
                previewPromiseResolve = null;
            }
        }, timeoutMs);
    });
}

async function showMessagePreview() {
    let restoreMessageCreation = null;
    let loadingToast = null;
    
    try {
        const settings = getSettings();
        if (!settings.enabled) {
            toastr.warning('消息预览功能未启用');
            return;
        }

        const textareaText = String($('#send_textarea').val()).trim();
        if (!textareaText) {
            toastr.error('请先输入消息内容');
            return;
        }

        isPreviewMode = true;
        capturedPreviewData = null;
        previewMessageIds.clear();
        previewPromiseResolve = null;
        
        restoreMessageCreation = interceptMessageCreation();
        
        loadingToast = toastr.info('正在拦截API请求...', '', { 
            timeOut: 0, 
            tapToDismiss: false 
        });

        $('#send_but').trigger('click');
        
        const result = await waitForPreviewInterception();
        
        toastr.clear();
        
        if (result.success) {
            await displayPreviewResult(result.data, textareaText);
        } else {
            toastr.error(`✘ 预览失败: ${result.error}`);
        }

    } catch (error) {
        if (loadingToast) toastr.clear();
        toastr.error('✘ 预览异常: ' + error.message);
    } finally {
        isPreviewMode = false;
        if (restoreMessageCreation) {
            restoreMessageCreation();
        }
        capturedPreviewData = null;
        previewPromiseResolve = null;
    }
}

async function displayPreviewResult(data, userInput) {
    try {
        const formattedContent = formatPreviewContent(data, userInput, false);
        const popupContent = `<div class="message-preview-container"><div class="message-preview-content-box">${formattedContent}</div></div>`;
        
        await callGenericPopup(popupContent, POPUP_TYPE.TEXT, '消息预览', { 
            wide: true, 
            large: true 
        });

        toastr.success('✓ 预览成功！', '', { timeOut: 2000 });
        
    } catch (error) {
        toastr.error('✘ 显示预览失败');
    }
}

function findApiRequestForMessage(messageId) {
    if (apiRequestHistory.length === 0) return null;
    
    const strategies = [
        record => record.associatedMessageId === messageId,
        record => record.messageId === messageId,
        record => Math.abs(record.messageId - messageId) <= 1
    ];

    for (const strategy of strategies) {
        const match = apiRequestHistory.find(strategy);
        if (match) return match;
    }

    return apiRequestHistory[0];
}

async function showMessageHistoryPreview(messageId) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        const apiRecord = findApiRequestForMessage(messageId);
        
        if (apiRecord && apiRecord.messages && apiRecord.messages.length > 0) {
            const formattedContent = formatPreviewContent(apiRecord, apiRecord.userInput, true);
            const popupContent = `<div class="message-preview-container"><div class="message-preview-content-box">${formattedContent}</div></div>`;
            
            await callGenericPopup(popupContent, POPUP_TYPE.TEXT, 
                `消息历史预览 - 第 ${messageId + 1} 条消息之前`, { 
                wide: true, 
                large: true 
            });
            
        } else {
            toastr.warning(`未找到第 ${messageId + 1} 条消息的API请求记录`);
        }

    } catch (error) {
        toastr.error('历史预览失败');
    }
}

function formatPreviewContent(data, userInput, isHistory = false) {
    let content = '';
    
    content += `${'='.repeat(60)}\n`;
    content += isHistory ? `消息历史预览\n` : `● LLM API请求预览\n`;
    content += `${'='.repeat(60)}\n\n`;
    
    content += `API信息:\n`;
    content += `${'-'.repeat(30)}\n`;
    content += `URL: ${data.url}\n`;
    content += `Model: ${data.model || 'Unknown'}\n`;
    content += `Messages: ${data.messages.length}\n`;
    content += `Time: ${new Date(data.timestamp).toLocaleString()}\n`;
    
    if (data.characterName) {
        content += `Character: ${data.characterName}\n`;
    }
    
    if (userInput) {
        const displayInput = userInput.length > 100 ? userInput.substring(0, 100) + '...' : userInput;
        content += `✎ 用户输入: "${displayInput}"\n`;
    }
    
    content += `\n${'─'.repeat(50)}\n\n`;
    content += formatMessagesArray(data.messages, userInput);
    content += `\n${'='.repeat(60)}`;
    
    return content;
}

function formatMessagesArray(messages, userInput) {
    let content = `💬 Messages (${messages.length}):\n`;
    content += `${'-'.repeat(30)}\n`;
    
    let processedMessages = [...messages];
    
    if (processedMessages.length >= 2) {
        const [lastMsg, secondLastMsg] = processedMessages.slice(-2);
        if (lastMsg.role === 'user' && secondLastMsg.role === 'user' && 
            lastMsg.content === secondLastMsg.content && lastMsg.content === userInput) {
            processedMessages.pop();
        }
    }

    processedMessages.forEach((msg, index) => {
        const msgContent = msg.content || '';
        const roleIcon = msg.role === 'system' ? '☼' : 
                         msg.role === 'user' ? '✎' : '♪';
        
        let inputNote = '';
        if (msg.role === 'user' && msgContent === userInput) {
            inputNote = ' // ⬅ 实际发送的内容';
        }
        
        content += `\n[${index + 1}] ${roleIcon} ${msg.role.toUpperCase()}${inputNote}\n`;
        content += `${msgContent}\n`;
        
        if (index < processedMessages.length - 1) {
            content += `${'-'.repeat(20)}\n`;
        }
    });
    
    return content;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

const addHistoryButtonsDebounced = debounce(() => {
    const settings = getSettings();
    if (!settings.enabled) return;

    $('.mes_history_preview').remove();
    $('#chat .mes').each(function() {
        const mesId = parseInt($(this).attr('mesid'));
        if (mesId <= 0) return;

        const extraButtons = $(this).find('.extraMesButtons');
        if (extraButtons.length > 0) {
            const historyButton = $(`<div title="查看历史API请求" class="mes_button mes_history_preview fa-solid fa-coffee"></div>`)
                .on('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    showMessageHistoryPreview(mesId);
                });
            extraButtons.prepend(historyButton);
        }
    });
}, CONSTANTS.DEBOUNCE_DELAY);

function cleanupMemory() {
    if (apiRequestHistory.length > CONSTANTS.MAX_HISTORY_RECORDS) {
        apiRequestHistory = apiRequestHistory.slice(0, CONSTANTS.MAX_HISTORY_RECORDS);
    }
    previewMessageIds.clear();
    if (capturedPreviewData) {
        capturedPreviewData = null;
    }
}

function addEventListeners() {
    const listeners = [
        { event: event_types.MESSAGE_RECEIVED, handler: addHistoryButtonsDebounced },
        { event: event_types.CHARACTER_MESSAGE_RENDERED, handler: addHistoryButtonsDebounced },
        { event: event_types.USER_MESSAGE_RENDERED, handler: addHistoryButtonsDebounced },
        { 
            event: event_types.CHAT_CHANGED, 
            handler: () => {
                apiRequestHistory = [];
                setTimeout(addHistoryButtonsDebounced, 200);
            }
        }
    ];

    listeners.forEach(({ event, handler }) => {
        eventSource.on(event, handler);
        eventListeners.push({ event, handler });
    });
}

function removeEventListeners() {
    eventListeners.forEach(({ event, handler }) => {
        eventSource.off(event, handler);
    });
    eventListeners = [];
}

function cleanup() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    removeEventListeners();
    restoreOriginalFetch();
    $('.mes_history_preview').remove();
    $('#message_preview_btn').remove();
    cleanupMemory();
    previewPromiseResolve = null;
}

function initMessagePreview() {
    try {
        cleanup();
        
        const settings = getSettings();
        
        const previewBtn = $(`<div id="message_preview_btn" class="fa-solid fa-coffee interactable" title="预览消息"></div>`)
            .on('click', showMessagePreview);
        $("#send_but").before(previewBtn);
        
        $("#xiaobaix_preview_enabled").prop("checked", settings.enabled).on("change", function() {
            settings.enabled = $(this).prop("checked");
            saveSettingsDebounced();
            $('#message_preview_btn').toggle(settings.enabled);
            
            if (settings.enabled) {
                addHistoryButtonsDebounced();
                cleanupTimer = setInterval(cleanupMemory, CONSTANTS.CLEANUP_INTERVAL);
            } else {
                $('.mes_history_preview').remove();
                if (cleanupTimer) clearInterval(cleanupTimer);
            }
        });
        
        if (!settings.enabled) $('#message_preview_btn').hide();
        
        setupInterceptor();
        addHistoryButtonsDebounced();
        
        if (eventSource) {
            addEventListeners();
        }
        
        if (settings.enabled) {
            cleanupTimer = setInterval(cleanupMemory, CONSTANTS.CLEANUP_INTERVAL);
        }
        
    } catch (error) {
        toastr.error('模块初始化失败');
    }
}

window.addEventListener('beforeunload', cleanup);

export { initMessagePreview };
