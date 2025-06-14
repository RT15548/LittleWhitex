import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, main_api } from "../../../../script.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { prepareOpenAIMessages } from "../../../openai.js";

const EXT_ID = "LittleWhiteBox";
const PREVIEW_MODULE_NAME = "xiaobaix-preview";

let apiRequestHistory = [];
let lastApiRequest = null;
const MAX_HISTORY_RECORDS = 50;

async function safeImportModules() {
    const modules = {};
    
    try {
        const worldInfoModule = await import('../../../world-info.js');
        modules.getWorldInfoPrompt = worldInfoModule.getWorldInfoPrompt;
    } catch (e) {
        modules.getWorldInfoPrompt = () => Promise.resolve({ worldInfoBefore: '', worldInfoAfter: '' });
    }
    
    try {
        const powerUserModule = await import('../../../power-user.js');
        modules.power_user = powerUserModule.power_user;
    } catch (e) {
        modules.power_user = {};
    }
    
    try {
        const extensionsModule = await import('../../../extensions.js');
        modules.getExtensionPrompt = extensionsModule.getExtensionPrompt;
        modules.extension_prompt_types = extensionsModule.extension_prompt_types || {
            BEFORE_PROMPT: 0,
            IN_PROMPT: 1,
            AFTER_PROMPT: 2
        };
    } catch (e) {
        modules.getExtensionPrompt = () => Promise.resolve(null);
        modules.extension_prompt_types = {
            BEFORE_PROMPT: 0,
            IN_PROMPT: 1,
            AFTER_PROMPT: 2
        };
    }
    
    return modules;
}

function getSettings() {
    if (!extension_settings[EXT_ID].preview) {
        extension_settings[EXT_ID].preview = {
            enabled: true,
            maxPreviewLength: 300,
            interceptTimeout: 5000
        };
    }
    return extension_settings[EXT_ID].preview;
}

function createPreviewButton() {
    return $(`<div id="message_preview_btn" class="fa-solid fa-coffee interactable" title="预览将要发送给LLM的消息"></div>`).on('click', showMessagePreview);
}

function createMessageHistoryButton() {
    return $(`<div title="查看此消息前的历史记录" class="mes_button mes_history_preview fa-solid fa-coffee"></div>`);
}

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
        push: context.chat.push.bind(context.chat),
        unshift: context.chat.unshift.bind(context.chat),
        splice: context.chat.splice.bind(context.chat)
    };
    
    context.chat.push = () => context.chat.length;
    context.chat.unshift = () => context.chat.length;
    context.chat.splice = (start, deleteCount, ...items) => {
        return items.length > 0 ? [] : originalChatMethods.splice(start, deleteCount);
    };
    
    const originalFunctions = {};
    const functionsToBlock = ['Generate', 'addOneMessage', 'printMessages', 'finishGenerating', 'showSwipeButtons'];
    
    functionsToBlock.forEach(fn => {
        if (window[fn]) {
            originalFunctions[fn] = window[fn];
            if (fn === 'Generate') {
                window[fn] = () => Promise.resolve('PREVIEW_MODE');
            } else {
                window[fn] = () => {};
            }
        }
    });
    
    const isMessageElement = (child) => {
        if (!child?.classList) return false;
        return child.classList.contains('mes') || 
               child.classList.contains('message') || 
               child.id?.includes('mes') ||
               child.querySelector?.('.mes') !== null;
    };
    
    Element.prototype.appendChild = function(child) { 
        if (isMessageElement(child)) return child;
        return originalMethods.appendChild.call(this, child); 
    };
    
    Element.prototype.insertBefore = function(newNode, referenceNode) { 
        if (isMessageElement(newNode)) return newNode;
        return originalMethods.insertBefore.call(this, newNode, referenceNode); 
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
            const modules = await safeImportModules();
            
            const fullChat = [...context.chat];
            if (textareaText.trim()) {
                fullChat.push({
                    name: context.name1 || 'User',
                    is_user: true,
                    send_date: Date.now(),
                    mes: textareaText
                });
            }

            let worldInfo = { worldInfoBefore: '', worldInfoAfter: '' };
            try {
                worldInfo = await modules.getWorldInfoPrompt(fullChat, context.maxContext || 4096);
            } catch (e) {}
            
            const extensionPrompts = [];
            const { extension_prompt_types } = modules;
            
            for (const type of [extension_prompt_types.BEFORE_PROMPT, extension_prompt_types.IN_PROMPT, extension_prompt_types.AFTER_PROMPT]) {
                try {
                    const prompt = await modules.getExtensionPrompt(type);
                    if (prompt) extensionPrompts.push({ role: 'system', content: prompt });
                } catch (e) {}
            }

            const [messages, counts] = await prepareOpenAIMessages({
                name2: character.name,
                charDescription: character.description || '',
                charPersonality: character.personality || '',
                scenario: character.scenario || '',
                worldInfoBefore: worldInfo.worldInfoBefore || '',
                worldInfoAfter: worldInfo.worldInfoAfter || '',
                extensionPrompts,
                personaDescription: modules.power_user?.persona_description || '',
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

async function captureRealMessageData() {
    return new Promise((resolve) => {
        const settings = getSettings();
        const interceptTimeout = settings.interceptTimeout || 5000;
        
        const textareaText = String($('#send_textarea').val()).trim();
        if (!textareaText) {
            resolve({ success: false, error: '请先在输入框中输入内容' });
            return;
        }
        
        const context = getContext();
        const originalChat = [...context.chat];
        let isPreviewMode = true;
        let requestCaptured = false;
        let capturedData = null;
        
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
        
        window.fetch = function(url, options) {
            const isLLMRequest = url && options?.body && options.method !== 'GET' && (
                url.includes('/v1') ||
                url.includes('chat/completions') ||
                url.includes('completions') ||
                url.includes('generate') ||
                url.includes('claude') ||
                url.includes('anthropic')
            ) && (
                (typeof options.body === 'string' && (
                    options.body.includes('"messages"') ||
                    options.body.includes("'messages'") ||
                    options.body.includes('"prompt"')
                ))
            );
            
            const isExcludedRequest = url && (
                url.includes('/api/chats/') || 
                url.includes('/api/characters') || 
                url.includes('/api/settings') || 
                url.includes('/api/images') || 
                url.includes('/api/files') ||
                url.includes('.png') || url.includes('.jpg') || url.includes('.css') || url.includes('.js') ||
                (url.includes('/models') && !options.body?.includes('"messages"'))
            );
            
            if (isLLMRequest && !isExcludedRequest && isPreviewMode) {
                requestCaptured = true;
                
                try {
                    const requestData = JSON.parse(options.body);
                    
                    if (requestData.messages && requestData.messages.length > 0) {
                        capturedData = {
                            url, 
                            messages: requestData.messages, 
                            model: requestData.model || 'Unknown',
                            timestamp: Date.now(), 
                            fullRequest: requestData,
                            isPreview: true,
                            endpoint: extractEndpointInfo(url)
                        };
                        
                        lastApiRequest = capturedData;
                        
                        return Promise.resolve(new Response(JSON.stringify({
                            choices: [{ 
                                message: { 
                                    content: "PREVIEW_MODE_INTERCEPTED",
                                    role: "assistant"
                                }
                            }]
                        }), { 
                            status: 200, 
                            headers: { 'Content-Type': 'application/json' } 
                        }));
                    } else {
                        capturedData = {
                            url,
                            messages: [],
                            model: requestData.model || 'Unknown',
                            timestamp: Date.now(),
                            fullRequest: requestData,
                            isPreview: true,
                            endpoint: extractEndpointInfo(url),
                            warning: 'No valid messages array found'
                        };
                    }
                } catch (e) {
                    capturedData = {
                        url,
                        messages: [],
                        model: 'Parse Failed',
                        timestamp: Date.now(),
                        rawBody: options.body,
                        parseError: e.message,
                        isPreview: true,
                        endpoint: extractEndpointInfo(url)
                    };
                }
            }
            
            return originalFetch.apply(this, arguments);
        };
        
        const fullRestore = () => {
            isPreviewMode = false;
            window.fetch = originalFetch;
            restoreMessageCreation();
            
            context.chat.length = originalChat.length;
            context.chat.splice(0, context.chat.length, ...originalChat);
        };
        
        const timeout = setTimeout(() => {
            fullRestore();
            resolve({ 
                success: requestCaptured, 
                data: capturedData, 
                userInput: textareaText,
                timeout: true,
                debug: {
                    interceptTimeout,
                    capturedData: capturedData ? 'yes' : 'no',
                    endpoint: capturedData?.endpoint?.full || 'none'
                }
            });
        }, interceptTimeout);
        
        try {
            $('#send_but').click();
            
            setTimeout(() => {
                clearTimeout(timeout);
                fullRestore();
                resolve({ 
                    success: requestCaptured, 
                    data: capturedData, 
                    userInput: textareaText,
                    completed: true,
                    debug: {
                        interceptTimeout,
                        capturedData: capturedData ? 'yes' : 'no',
                        endpoint: capturedData?.endpoint?.full || 'none'
                    }
                });
            }, 3000);
            
        } catch (error) {
            clearTimeout(timeout);
            fullRestore();
            resolve({ 
                success: false, 
                error: error.message, 
                userInput: textareaText 
            });
        }
    });
}

async function showMessagePreview() {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        toastr.info('正在捕获消息数据...', '', { timeOut: 5000 });
        
        const captureResult = await captureRealMessageData();
        let rawContent = '';

        if (captureResult.success && captureResult.data?.messages?.length > 0) {
            const { data } = captureResult;
            rawContent = `=== 捕获到的LLM API请求 ===\n`;
            rawContent += `URL: ${data.url}\n`;
            rawContent += `Model: ${data.model || 'Unknown'}\n`;
            rawContent += `Messages Count: ${data.messages.length}\n`;
            rawContent += `捕获时间: ${new Date(data.timestamp).toLocaleString()}\n`;
            if (captureResult.userInput) {
                rawContent += `📝 用户输入: "${captureResult.userInput}"\n`;
            }
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

function formatPreviewContent(messageData, isHistory) {
    let content = '';
    if (isHistory) {
        content += `=== 📚 消息历史预览 ===\n目标消息: 第 ${messageData.targetMessageId + 1} 条\n`;
        content += `历史记录数量: ${messageData.historyCount} 条消息\n\n`;
    }
    if (messageData.type === 'api_intercepted' && messageData.messages) {
        content += `=== 捕获到的LLM API请求${isHistory ? ' (历史记录)' : ''} ===\n`;
        
        if (messageData.endpoint) {
            content += `🌐 API端点: ${messageData.endpoint.full}\n`;
            content += `📡 服务器: ${messageData.endpoint.host}${messageData.endpoint.port ? ':' + messageData.endpoint.port : ''}\n`;
            content += `📍 路径: ${messageData.endpoint.pathname}\n`;
        }
        
        content += `🤖 模型: ${messageData.model || 'Unknown'}\n`;
        content += `📨 消息数量: ${messageData.messages.length}\n`;
        content += `⏰ 捕获时间: ${new Date(messageData.timestamp).toLocaleString()}\n`;
        
        if (messageData.userInput) {
            content += `📝 用户输入: "${messageData.userInput}"\n`;
        }
        
        if (messageData.warning) {
            content += `⚠️  警告: ${messageData.warning}\n`;
        }
        
        if (messageData.parseError) {
            content += `❌ 解析错误: ${messageData.parseError}\n`;
            if (messageData.rawBody) {
                content += `📄 原始请求体预览: ${messageData.rawBody.substring(0, 300)}...\n`;
            }
        }
        
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
        if (messageData.debug) {
            content += `\n=== 调试信息 ===\n`;
            content += `端点: ${messageData.debug.endpoint || 'none'}\n`;
            content += `超时时间: ${messageData.debug.interceptTimeout}ms\n`;
            content += `捕获数据: ${messageData.debug.capturedData}\n`;
        }
    }
    return content;
}

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

function extractEndpointInfo(url) {
    try {
        const urlObj = new URL(url);
        return {
            host: urlObj.host,
            port: urlObj.port,
            pathname: urlObj.pathname,
            full: url
        };
    } catch (e) {
        return {
            host: 'unknown',
            port: 'unknown', 
            pathname: 'unknown',
            full: url
        };
    }
}

function interceptApiRequests() {
    const originalFetch = window.fetch;
    
    window.fetch = function(...args) {
        const [url, options] = args;
        
        const isLLMRequest = url && options?.body && options.method !== 'GET' && (
            url.includes('/v1/') || 
            url.includes('/v1') ||
            url.includes('chat/completions') ||
            url.includes('completions') ||
            url.includes('generate') ||
            url.includes('claude') || 
            url.includes('anthropic')
        ) && (
            options.body.includes('"messages"') ||
            options.body.includes("'messages'") ||
            (options.method === 'POST' && (
                options.body.includes('"prompt"') ||
                options.body.includes('"text"')
            ))
        );
        
        const isExcludedRequest = url && (
            url.includes('/api/chats/') || 
            url.includes('/api/characters') || 
            url.includes('/api/settings') || 
            url.includes('/api/images') || 
            url.includes('/api/files') ||
            url.includes('/api/worldinfo') ||
            url.includes('/api/presets') ||
            url.includes('.png') || 
            url.includes('.jpg') || 
            url.includes('.gif') ||
            url.includes('.css') ||
            url.includes('.js') ||
            url.includes('/health') ||
            url.includes('/status') ||
            url.includes('/models') ||
            (url.includes('/models') && !options.body.includes('"messages"'))
        );
        
        if (isLLMRequest && !isExcludedRequest && options?.body) {
            try {
                const requestData = JSON.parse(options.body);
                
                if (requestData.messages && Array.isArray(requestData.messages) && requestData.messages.length > 0) {
                    const apiData = {
                        url, 
                        model: requestData.model || 'Unknown', 
                        timestamp: Date.now(),
                        messages: requestData.messages, 
                        fullRequest: requestData,
                        endpoint: extractEndpointInfo(url)
                    };
                    
                    if (!apiData.isPreview) {
                        lastApiRequest = apiData;
                        saveApiRequestToHistory(apiData);
                    }
                }
            } catch (e) {
                if (options.body.includes('messages')) {
                    lastApiRequest = {
                        url,
                        model: 'Unknown',
                        timestamp: Date.now(),
                        messages: [],
                        rawBody: options.body,
                        parseError: e.message,
                        endpoint: extractEndpointInfo(url)
                    };
                }
            }
        }
        
        return originalFetch.apply(this, args);
    };
}

function initMessagePreview() {
    try {
        interceptApiRequests();
        
        $("#send_but").before(createPreviewButton());
        
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
        
        setTimeout(() => {
            addHistoryButtonsToMessages();
        }, 500);
        
        if (eventSource) {
            const messageEvents = [
                event_types.CHARACTER_MESSAGE_RENDERED, 
                event_types.USER_MESSAGE_RENDERED, 
                event_types.MESSAGE_RECEIVED, 
                event_types.MESSAGE_SWIPED
            ];
            
            messageEvents.forEach(eventType => {
                eventSource.on(eventType, () => {
                    setTimeout(addHistoryButtonsToMessages, 200);
                });
            });
            
            eventSource.on(event_types.CHAT_CHANGED, () => {
                setTimeout(() => {
                    addHistoryButtonsToMessages();
                    apiRequestHistory = [];
                }, 300);
            });

            eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
                setTimeout(() => {
                    const recentRequest = apiRequestHistory.find(record =>
                        !record.associatedMessageId && (Date.now() - record.timestamp) < 30000
                    );
                    if (recentRequest) {
                        recentRequest.associatedMessageId = messageId;
                    }
                }, 200);
            });
        }
        
    } catch (error) {}
}

export { initMessagePreview };
