/**
 * LittleWhiteBox (小白X) - Message Preview Module
 *
 * Copyright 2025 biex
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * ADDITIONAL TERMS:
 * If you reference, modify, or distribute any file from this project,
 * you must include attribution to the original author "biex" in your
 * project documentation, README, or credits section.
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, main_api } from "../../../../script.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { prepareOpenAIMessages } from "../../../openai.js";

const EXT_ID = "LittleWhiteBox";
const PREVIEW_MODULE_NAME = "xiaobaix-preview";

let apiRequestHistory = [];
let lastApiRequest = null;
let originalSendFunction = null;
const MAX_HISTORY_RECORDS = 50;

// 获取设置
function getSettings() {
    if (!extension_settings[EXT_ID].preview) {
        extension_settings[EXT_ID].preview = {
            enabled: true,
            maxPreviewLength: 300
        };
    }
    return extension_settings[EXT_ID].preview;
}

// 创建预览按钮
function createPreviewButton() {
    return $(`<div id="message_preview_btn" class="fa-solid fa-coffee interactable" title="预览将要发送给LLM的消息"></div>`).on('click', showMessagePreview);
}

// 创建历史按钮
function createMessageHistoryButton() {
    return $(`<div title="查看此消息前的历史记录" class="mes_button mes_history_preview fa-solid fa-coffee"></div>`);
}

// 为消息添加历史按钮
function addHistoryButtonsToMessages() {
    const settings = getSettings();
    if (!settings.enabled) return;

    $('.mes_history_preview').remove();
    $('#chat .mes').each(function() {
        const mesId = parseInt($(this).attr('mesid'));
        if (mesId <= 0) return;

        const extraButtons = $(this).find('.extraMesButtons');
        if (extraButtons.length > 0) {
            const historyButton = createMessageHistoryButton().on('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                showMessageHistoryPreview(mesId);
            });
            extraButtons.prepend(historyButton);
        }
    });
}

// 查找对应的API请求数据
function findApiRequestForMessage(messageId) {
    if (apiRequestHistory.length === 0) return null;
    
    const strategies = [
        record => record.associatedMessageId === messageId,
        record => record.messageId === messageId,
        record => record.messageId === messageId - 1,
        record => record.chatLength === messageId
    ];

    for (const strategy of strategies) {
        const match = apiRequestHistory.find(strategy);
        if (match) return match;
    }

    const candidates = apiRequestHistory.filter(record => record.messageId <= messageId);
    return candidates.length > 0 ? candidates.sort((a, b) => b.messageId - a.messageId)[0] : null;
}

// 显示消息历史预览
async function showMessageHistoryPreview(messageId) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        const context = getContext();
        const historyMessages = context.chat.slice(0, messageId);
        if (historyMessages.length === 0) {
            toastr.info('此消息之前没有历史记录');
            return;
        }

        const apiRecord = findApiRequestForMessage(messageId);
        let messageData;

        if (apiRecord?.messages?.length) {
            messageData = {
                type: 'api_intercepted',
                messages: apiRecord.messages,
                model: apiRecord.model,
                timestamp: apiRecord.timestamp,
                userInput: extractActualUserInput(apiRecord.messages)
            };
        } else {
            const originalChat = [...context.chat];
            context.chat = historyMessages;
            messageData = await getCurrentMessageContent();
            context.chat = originalChat;
        }

        messageData.isHistoryPreview = true;
        messageData.targetMessageId = messageId;
        messageData.historyCount = historyMessages.length;

        const popupContent = `<div class="message-preview-container"><div class="message-preview-content-box">${formatPreviewContent(messageData, true)}</div></div>`;
        await callGenericPopup(popupContent, POPUP_TYPE.TEXT, `消息历史预览 - 第 ${messageId + 1} 条消息之前`, { wide: true, large: true });

    } catch (error) {
        toastr.error('无法显示消息历史预览: ' + error.message);
    }
}

// 阻止消息创建
function preventMessageCreation() {
    const context = getContext();
    const originalMethods = {
        push: Array.prototype.push,
        unshift: Array.prototype.unshift,
        splice: Array.prototype.splice,
        appendChild: Element.prototype.appendChild,
        insertBefore: Element.prototype.insertBefore
    };
    
    const originalChatMethods = {
        push: context.chat.push,
        unshift: context.chat.unshift,
        splice: context.chat.splice
    };
    
    context.chat.push = context.chat.unshift = () => context.chat.length;
    context.chat.splice = (start, deleteCount, ...items) => {
        return items.length > 0 ? [] : originalChatMethods.splice.call(context.chat, start, deleteCount);
    };
    
    const originalFunctions = {};
    ['Generate', 'addOneMessage', 'printMessages'].forEach(fn => {
        if (window[fn]) {
            originalFunctions[fn] = window[fn];
            window[fn] = fn === 'Generate' ? () => Promise.resolve() : () => {};
        }
    });
    
    const isMessageElement = (child) => child?.classList && (
        child.classList.contains('mes') || 
        child.classList.contains('message') || 
        child.id?.includes('mes')
    );
    
    Element.prototype.appendChild = function(child) { 
        return isMessageElement(child) ? child : originalMethods.appendChild.call(this, child); 
    };
    
    Element.prototype.insertBefore = function(newNode, referenceNode) { 
        return isMessageElement(newNode) ? newNode : originalMethods.insertBefore.call(this, newNode, referenceNode); 
    };
    
    return function restoreMessageCreation() {
        context.chat.push = originalChatMethods.push;
        context.chat.unshift = originalChatMethods.unshift;
        context.chat.splice = originalChatMethods.splice;
        
        Object.keys(originalFunctions).forEach(fn => {
            window[fn] = originalFunctions[fn];
        });
        
        Element.prototype.appendChild = originalMethods.appendChild;
        Element.prototype.insertBefore = originalMethods.insertBefore;
    };
}

// 获取当前消息内容
async function getCurrentMessageContent() {
    const context = getContext();
    const textareaText = String($('#send_textarea').val());
    const character = context.characters[context.characterId];
    
    if (!character) throw new Error('没有选择角色');

    if (lastApiRequest && (Date.now() - lastApiRequest.timestamp < 60000)) {
        return {
            type: 'api_intercepted',
            messages: lastApiRequest.messages,
            userInput: textareaText,
            model: lastApiRequest.model,
            timestamp: lastApiRequest.timestamp
        };
    }

    if (main_api === 'openai') {
        try {
            const { getWorldInfoPrompt } = await import('../../../world-info.js');
            const { power_user } = await import('../../../power-user.js');
            const { getExtensionPrompt, extension_prompt_types } = await import('../../../extensions.js');

            const fullChat = [...context.chat];
            if (textareaText.trim()) {
                fullChat.push({
                    name: context.name1 || 'User',
                    is_user: true,
                    send_date: Date.now(),
                    mes: textareaText
                });
            }

            const worldInfo = await getWorldInfoPrompt(fullChat, context.maxContext || 4096).catch(() => ({ worldInfoBefore: '', worldInfoAfter: '' }));
            
            const extensionPrompts = [];
            for (const type of [extension_prompt_types.BEFORE_PROMPT, extension_prompt_types.IN_PROMPT, extension_prompt_types.AFTER_PROMPT]) {
                const prompt = await getExtensionPrompt(type).catch(() => null);
                if (prompt) extensionPrompts.push({ role: 'system', content: prompt });
            }

            const [messages, counts] = await prepareOpenAIMessages({
                name2: character.name,
                charDescription: character.description || '',
                charPersonality: character.personality || '',
                scenario: character.scenario || '',
                worldInfoBefore: worldInfo.worldInfoBefore || '',
                worldInfoAfter: worldInfo.worldInfoAfter || '',
                extensionPrompts,
                personaDescription: power_user?.persona_description || '',
                messages: fullChat,
                messageExamples: character.mes_example ? [character.mes_example] : [],
            }, false);

            return { type: 'openai', messages, tokenCount: counts, userInput: textareaText };
        } catch (error) {
            throw error;
        }
    }

    return { type: 'other', userInput: textareaText, character, chat: context.chat, api: main_api };
}

// 捕获真实消息数据
async function captureRealMessageData() {
    return new Promise((resolve) => {
        const textareaText = String($('#send_textarea').val()).trim();
        if (!textareaText) {
            resolve({ success: false, error: '请先在输入框中输入内容' });
            return;
        }
        const context = getContext();
        const originalChat = [...context.chat];
        let isPreviewMode = true;
        
        const tempMessage = {
            name: context.name1 || 'User',
            is_user: true,
            send_date: Date.now(),
            mes: textareaText,
            extra: { isPreviewTemp: true }
        };
        context.chat.push(tempMessage);
        const restoreMessageCreation = preventMessageCreation();
        const originalFetch = window.fetch;
        let requestCaptured = false;
        
        window.fetch = function(url, options) {
            const isLLMRequest = url?.includes('/v1/chat/completions') || 
                url?.includes('/generate') || 
                (url?.includes('/api/') && options?.body?.includes('messages'));
            if (isLLMRequest && isPreviewMode) {
                requestCaptured = true;
                try {
                    const requestData = JSON.parse(options.body);
                    if (requestData.messages) {
                        lastApiRequest = {
                            url, 
                            messages: requestData.messages, 
                            model: requestData.model,
                            timestamp: Date.now(), 
                            fullRequest: requestData,
                            isPreview: true
                        };
                    }
                } catch (e) {}
                return Promise.resolve(new Response(JSON.stringify({
                    choices: [{ message: { content: "PREVIEW_MODE_INTERCEPTED" } }]
                }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            return originalFetch.apply(this, arguments);
        };
        
        const fullRestore = () => {
            isPreviewMode = false;
            window.fetch = originalFetch;
            if (originalSendFunction) {
                window.Generate = originalSendFunction;
                originalSendFunction = null;
            }
            restoreMessageCreation();
            context.chat.length = originalChat.length;
            context.chat.splice(0, context.chat.length, ...originalChat);
        };
        
        const timeout = setTimeout(() => {
            fullRestore();
            resolve({ success: requestCaptured, data: lastApiRequest, userInput: textareaText });
        }, 3000);
        
        try {
            $('#send_but').click();
            setTimeout(() => {
                clearTimeout(timeout);
                fullRestore();
                resolve({ success: requestCaptured, data: lastApiRequest, userInput: textareaText });
            }, 1000);
        } catch (error) {
            clearTimeout(timeout);
            fullRestore();
            resolve({ success: false, error: error.message, userInput: textareaText });
        }
    });
}

// 显示消息预览
async function showMessagePreview() {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        toastr.info('正在捕获消息数据...');
        const captureResult = await captureRealMessageData();
        let rawContent = '';

        if (captureResult.success && captureResult.data?.messages) {
            const { data } = captureResult;
            rawContent = `=== 捕获到的LLM API请求 ===\nURL: ${data.url}\nModel: ${data.model || 'Unknown'}\nMessages Count: ${data.messages.length}\n`;
            if (captureResult.userInput) rawContent += `📝 用户输入: "${captureResult.userInput}"\n`;
            rawContent += `\n${formatMessagesArray(data.messages, captureResult.userInput)}`;
        } else {
            const messageData = await getCurrentMessageContent();
            rawContent = formatPreviewContent(messageData, false);
        }

        const popupContent = `<div class="message-preview-container"><div class="message-preview-content-box">${rawContent}</div></div>`;
        await callGenericPopup(popupContent, POPUP_TYPE.TEXT, '消息预览 - 数据捕获', { wide: true, large: true });

    } catch (error) {
        toastr.error('无法显示消息预览: ' + error.message);
    }
}

// 格式化消息数组
function formatMessagesArray(messages, userInput) {
    let content = `messages: [\n`;
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
        let inputNote = '';

        if (msg.role === 'user') {
            if (msgContent === userInput) {
                inputNote = ' // 👈 实际发送的内容';
            } else if (msgContent.startsWith('/')) {
                const commandTypes = ['echo', 'gen', 'send', 'sendas'].filter(cmd => msgContent.includes(`/${cmd}`));
                inputNote = ` // 👈 不會實際發送給ai的斜杠命令${commandTypes.length ? ` (${commandTypes.join(' + ').toUpperCase()})` : ''}`;
                if (userInput && userInput !== msgContent && !userInput.startsWith('[') && userInput.length < 100) {
                    const displayContent = userInput.length > 50 ? userInput.substring(0, 50) + '...' : userInput;
                    inputNote += ` (核心内容: "${displayContent}")`;
                }
            }
        }

        content += `  {\n    role: '${msg.role}'${inputNote},\n`;
        content += `    content: ${JSON.stringify(msgContent, null, 4).replace(/^/gm, '    ')}\n  }`;
        if (index < processedMessages.length - 1) content += ',';
        content += '\n';
    });
    content += `]`;
    return content;
}

// 格式化预览内容
function formatPreviewContent(messageData, isHistory) {
    let content = '';

    if (isHistory) {
        content += `=== 📚 消息历史预览 ===\n目标消息: 第 ${messageData.targetMessageId + 1} 条\n`;
        content += `历史记录数量: ${messageData.historyCount} 条消息\n\n`;
    }

    if (messageData.type === 'api_intercepted' && messageData.messages) {
        content += `=== 捕获到的LLM API请求${isHistory ? ' (历史记录)' : ''} ===\n`;
        content += `Model: ${messageData.model || 'Unknown'}\nMessages Count: ${messageData.messages.length}\n`;
        if (messageData.userInput) content += `📝 用户输入: "${messageData.userInput}"\n`;
        content += `\n${formatMessagesArray(messageData.messages, messageData.userInput)}`;
    } else if (messageData.type === 'openai' && messageData.messages) {
        content += '=== OpenAI 消息格式 ===\n';
        if (messageData.tokenCount) {
            const tokenCount = typeof messageData.tokenCount === 'object' ? 
                JSON.stringify(messageData.tokenCount) : messageData.tokenCount;
            content += `预估Token数量: ${tokenCount}\n`;
        }
        content += `消息总数: ${messageData.messages.length}\n\n${formatMessagesArray(messageData.messages, messageData.userInput)}`;
    } else if (messageData.chat?.length) {
        content += `=== 💬 聊天历史记录 ===\n聊天历史总数: ${messageData.chat.length}\n\n`;
        messageData.chat.forEach((msg, index) => {
            const role = msg.is_user ? '用户' : (msg.name || '角色');
            content += `[${index + 1}] ${role}: ${msg.mes || ''}\n`;
            if (msg.send_date) content += `时间: ${new Date(msg.send_date).toLocaleString()}\n\n`;
        });
    } else {
        content += '无法获取消息内容\n';
    }
    return content;
}

// 提取实际的用户输入
function extractActualUserInput(messages) {
    if (!messages?.length) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role === 'user') {
            const content = message.content || '';
            return content.startsWith('/') ? parseSlashCommandContent(content) : content;
        }
    }
    return '';
}

// 解析斜杠命令内容
function parseSlashCommandContent(content) {
    const commands = content.includes('\n') ? 
        content.split('\n').filter(line => line.trim().startsWith('/')) : 
        content.split('|').map(cmd => cmd.trim()).filter(cmd => cmd);

    let extractedContent = '';
    let commandTypes = [];

    for (const command of commands) {
        const patterns = [
            [/^\/gen\s+([\s\S]+)$/, 'gen'],
            [/^\/send\s+(.+)$/s, 'send'],
            [/^\/echo\s+(.+)$/s, 'echo']
        ];

        for (const [pattern, type] of patterns) {
            const match = command.match(pattern);
            if (match) {
                if (!extractedContent) extractedContent = match[1].trim();
                commandTypes.push(type);
                break;
            }
        }
    }

    if (extractedContent) {
        return extractedContent.length > 100 ? extractedContent.substring(0, 100) + '...' : extractedContent;
    }
    return commandTypes.length > 0 ? `[${commandTypes.join(' + ').toUpperCase()} 命令组合]` : 
        (content.length > 50 ? content.substring(0, 50) + '...' : content);
}

// 保存API请求到历史
function saveApiRequestToHistory(requestData) {
    const context = getContext();
    const historyItem = {
        ...requestData,
        messageId: context.chat?.length || 0,
        chatLength: context.chat?.length || 0,
        characterName: context.characters?.[context.characterId]?.name || 'Unknown'
    };

    apiRequestHistory.unshift(historyItem);
    if (apiRequestHistory.length > MAX_HISTORY_RECORDS) {
        apiRequestHistory = apiRequestHistory.slice(0, MAX_HISTORY_RECORDS);
    }
}

// 拦截API请求
function interceptApiRequests() {
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const [url, options] = args;
        const isLLMRequest = url && (
            url.includes('/api/openai') || url.includes('/v1/chat/completions') || 
            url.includes('/api/backends/chat-completions') || url.includes('/generate') || 
            url.includes('/chat/completions') || url.includes('claude') || url.includes('anthropic')
        );
        const isExcludedRequest = url && (
            url.includes('/api/chats/') || url.includes('/api/characters') || 
            url.includes('/api/settings') || url.includes('/api/images') || url.includes('/api/files')
        );
        if (isLLMRequest && !isExcludedRequest && options?.body) {
            try {
                const requestData = JSON.parse(options.body);
                const apiData = {
                    url, 
                    model: requestData.model || 'Unknown', 
                    timestamp: Date.now(),
                    messages: requestData.messages || [], 
                    fullRequest: requestData
                };
                
                if (!apiData.isPreview) {
                    lastApiRequest = apiData;
                    saveApiRequestToHistory(apiData);
                }
            } catch (e) {}
        }
        return originalFetch.apply(this, args);
    };
}

// 模块初始化
function initMessagePreview() {
    try {
        interceptApiRequests();
        
        // 将预览按钮添加到发送按钮前
        $("#send_but").before(createPreviewButton());
        
        // 初始化设置
        const settings = getSettings();
        $("#xiaobaix_preview_enabled").prop("checked", settings.enabled).on("change", function() {
            settings.enabled = $(this).prop("checked");
            saveSettingsDebounced();
            $('#message_preview_btn').toggle(settings.enabled);
            
            if (settings.enabled) {
                addHistoryButtonsToMessages();
            } else {
                $('.mes_history_preview').remove();
            }
        });
        
        if (!settings.enabled) $('#message_preview_btn').hide();
        
        // 添加历史按钮到现有消息
        addHistoryButtonsToMessages();
        
        // 设置事件监听器
        if (eventSource) {
            [event_types.CHARACTER_MESSAGE_RENDERED, event_types.USER_MESSAGE_RENDERED, 
             event_types.MESSAGE_RECEIVED, event_types.MESSAGE_SWIPED].forEach(eventType => {
                eventSource.on(eventType, () => setTimeout(addHistoryButtonsToMessages, 100));
            });
            
            eventSource.on(event_types.CHAT_CHANGED, () => {
                setTimeout(() => {
                    addHistoryButtonsToMessages();
                    apiRequestHistory = [];
                }, 200);
            });
            
            eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
                setTimeout(() => {
                    const recentRequest = apiRequestHistory.find(record =>
                        !record.associatedMessageId && (Date.now() - record.timestamp) < 30000
                    );
                    if (recentRequest) recentRequest.associatedMessageId = messageId;
                }, 100);
            });
        }
        
        console.log('[小白X] 消息预览模块初始化完成');
    } catch (error) {
        console.error('[小白X] 消息预览模块初始化失败:', error);
    }
}

// 导出函数
export { initMessagePreview };
