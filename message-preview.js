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

// 增强的模块动态导入函数
async function safeImportModules() {
    const modules = {};
    
    try {
        const worldInfoModule = await import('../../../world-info.js');
        modules.getWorldInfoPrompt = worldInfoModule.getWorldInfoPrompt;
    } catch (e) {
        console.warn('[预览] 世界信息模块导入失败:', e);
        modules.getWorldInfoPrompt = () => Promise.resolve({ worldInfoBefore: '', worldInfoAfter: '' });
    }
    
    try {
        const powerUserModule = await import('../../../power-user.js');
        modules.power_user = powerUserModule.power_user;
    } catch (e) {
        console.warn('[预览] 高级用户模块导入失败:', e);
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
        console.warn('[预览] 扩展模块导入失败:', e);
        modules.getExtensionPrompt = () => Promise.resolve(null);
        modules.extension_prompt_types = {
            BEFORE_PROMPT: 0,
            IN_PROMPT: 1,
            AFTER_PROMPT: 2
        };
    }
    
    return modules;
}

// 获取设置
function getSettings() {
    if (!extension_settings[EXT_ID].preview) {
        extension_settings[EXT_ID].preview = {
            enabled: true,
            maxPreviewLength: 300,
            interceptTimeout: 5000  // 延长到5秒
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
        console.error('[预览] 历史预览错误:', error);
        toastr.error('无法显示消息历史预览: ' + error.message);
    }
}

// 增强的阻止消息创建函数
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
    
    // 更彻底地阻止聊天数组修改
    context.chat.push = () => context.chat.length;
    context.chat.unshift = () => context.chat.length;
    context.chat.splice = (start, deleteCount, ...items) => {
        return items.length > 0 ? [] : originalChatMethods.splice(start, deleteCount);
    };
    
    // 阻止关键函数执行
    const originalFunctions = {};
    const functionsToBlock = ['Generate', 'addOneMessage', 'printMessages', 'finishGenerating', 'showSwipeButtons'];
    
    functionsToBlock.forEach(fn => {
        if (window[fn]) {
            originalFunctions[fn] = window[fn];
            if (fn === 'Generate') {
                window[fn] = () => {
                    console.log('[预览] 阻止Generate执行');
                    return Promise.resolve('PREVIEW_MODE');
                };
            } else {
                window[fn] = () => {
                    console.log(`[预览] 阻止${fn}执行`);
                };
            }
        }
    });
    
    // 阻止DOM消息元素创建
    const isMessageElement = (child) => {
        if (!child?.classList) return false;
        return child.classList.contains('mes') || 
               child.classList.contains('message') || 
               child.id?.includes('mes') ||
               child.querySelector?.('.mes') !== null;
    };
    
    Element.prototype.appendChild = function(child) { 
        if (isMessageElement(child)) {
            console.log('[预览] 阻止消息DOM创建');
            return child;
        }
        return originalMethods.appendChild.call(this, child); 
    };
    
    Element.prototype.insertBefore = function(newNode, referenceNode) { 
        if (isMessageElement(newNode)) {
            console.log('[预览] 阻止消息DOM插入');
            return newNode;
        }
        return originalMethods.insertBefore.call(this, newNode, referenceNode); 
    };
    
    return function restoreMessageCreation() {
        console.log('[预览] 恢复所有被阻止的函数');
        
        // 恢复聊天数组方法
        context.chat.push = originalChatMethods.push;
        context.chat.unshift = originalChatMethods.unshift;
        context.chat.splice = originalChatMethods.splice;
        
        // 恢复被阻止的函数
        Object.keys(originalFunctions).forEach(fn => {
            window[fn] = originalFunctions[fn];
        });
        
        // 恢复DOM方法
        Element.prototype.appendChild = originalMethods.appendChild;
        Element.prototype.insertBefore = originalMethods.insertBefore;
    };
}

// 获取当前消息内容 - 增强版
async function getCurrentMessageContent() {
    const context = getContext();
    const textareaText = String($('#send_textarea').val());
    const character = context.characters[context.characterId];
    
    if (!character) throw new Error('没有选择角色');

    // 检查最近的API请求
    if (lastApiRequest && (Date.now() - lastApiRequest.timestamp < 60000)) {
        console.log('[预览] 使用最近的API请求数据');
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
            console.log('[预览] 开始构建OpenAI消息');
            
            // 安全导入模块
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

            // 安全获取世界信息
            let worldInfo = { worldInfoBefore: '', worldInfoAfter: '' };
            try {
                worldInfo = await modules.getWorldInfoPrompt(fullChat, context.maxContext || 4096);
            } catch (e) {
                console.warn('[预览] 世界信息获取失败:', e);
            }
            
            // 安全获取扩展提示
            const extensionPrompts = [];
            const { extension_prompt_types } = modules;
            
            for (const type of [extension_prompt_types.BEFORE_PROMPT, extension_prompt_types.IN_PROMPT, extension_prompt_types.AFTER_PROMPT]) {
                try {
                    const prompt = await modules.getExtensionPrompt(type);
                    if (prompt) extensionPrompts.push({ role: 'system', content: prompt });
                } catch (e) {
                    console.warn('[预览] 扩展提示获取失败:', e);
                }
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

            console.log('[预览] OpenAI消息构建完成，消息数量:', messages.length);
            return { type: 'openai', messages, tokenCount: counts, userInput: textareaText };
            
        } catch (error) {
            console.error('[预览] OpenAI消息构建失败:', error);
            throw error;
        }
    }

    return { type: 'other', userInput: textareaText, character, chat: context.chat, api: main_api };
}

// 增强的捕获真实消息数据函数
async function captureRealMessageData() {
    return new Promise((resolve) => {
        const settings = getSettings();
        const interceptTimeout = settings.interceptTimeout || 5000; // 使用设置中的超时时间
        
        const textareaText = String($('#send_textarea').val()).trim();
        if (!textareaText) {
            resolve({ success: false, error: '请先在输入框中输入内容' });
            return;
        }
        
        console.log(`[预览] 开始捕获消息数据，超时时间: ${interceptTimeout}ms`);
        
        const context = getContext();
        const originalChat = [...context.chat];
        let isPreviewMode = true;
        let requestCaptured = false;
        let capturedData = null;
        
        // 添加临时消息到聊天
        const tempMessage = {
            name: context.name1 || 'User',
            is_user: true,
            send_date: Date.now(),
            mes: textareaText,
            extra: { isPreviewTemp: true }
        };
        context.chat.push(tempMessage);
        
        // 阻止消息创建
        const restoreMessageCreation = preventMessageCreation();
        
        // 拦截fetch请求
        const originalFetch = window.fetch;
        
        window.fetch = function(url, options) {
            console.log('[预览] 拦截到请求:', url);
            
            // 更精确的LLM请求识别
            const isLLMRequest = url && options?.body && (
                url.includes('/v1/chat/completions') || 
                url.includes('/api/openai') ||
                url.includes('/api/backends/chat-completions') ||
                url.includes('/chat/completions') ||
                (url.includes('/generate') && options.body.includes('messages')) ||
                (url.includes('claude') || url.includes('anthropic')) ||
                (options.method === 'POST' && options.body.includes('"messages"'))
            );
            
            // 排除非LLM请求
            const isExcludedRequest = url && (
                url.includes('/api/chats/') || 
                url.includes('/api/characters') || 
                url.includes('/api/settings') || 
                url.includes('/api/images') || 
                url.includes('/api/files') ||
                url.includes('/api/worldinfo') ||
                url.includes('.png') || url.includes('.jpg') || url.includes('.gif')
            );
            
            if (isLLMRequest && !isExcludedRequest && isPreviewMode) {
                console.log('[预览] 捕获到LLM请求');
                requestCaptured = true;
                
                try {
                    const requestData = JSON.parse(options.body);
                    console.log('[预览] 解析请求数据成功，消息数量:', requestData.messages?.length || 0);
                    
                    if (requestData.messages && requestData.messages.length > 0) {
                        capturedData = {
                            url, 
                            messages: requestData.messages, 
                            model: requestData.model || 'Unknown',
                            timestamp: Date.now(), 
                            fullRequest: requestData,
                            isPreview: true
                        };
                        
                        lastApiRequest = capturedData;
                        
                        // 返回模拟响应
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
                    }
                } catch (e) {
                    console.error('[预览] 解析请求数据失败:', e);
                }
            }
            
            return originalFetch.apply(this, arguments);
        };
        
        // 完整恢复函数
        const fullRestore = () => {
            console.log('[预览] 执行完整恢复');
            isPreviewMode = false;
            window.fetch = originalFetch;
            restoreMessageCreation();
            
            // 恢复聊天数组
            context.chat.length = originalChat.length;
            context.chat.splice(0, context.chat.length, ...originalChat);
        };
        
        // 设置超时 - 延长到5秒
        const timeout = setTimeout(() => {
            console.log(`[预览] ${interceptTimeout}ms超时，执行恢复`);
            fullRestore();
            resolve({ 
                success: requestCaptured, 
                data: capturedData, 
                userInput: textareaText,
                timeout: true
            });
        }, interceptTimeout);
        
        // 触发发送
        try {
            console.log('[预览] 触发发送按钮');
            $('#send_but').click();
            
            // 延长检查时间到3秒
            setTimeout(() => {
                console.log('[预览] 3秒检查，执行恢复');
                clearTimeout(timeout);
                fullRestore();
                resolve({ 
                    success: requestCaptured, 
                    data: capturedData, 
                    userInput: textareaText,
                    completed: true
                });
            }, 3000);
            
        } catch (error) {
            console.error('[预览] 发送过程出错:', error);
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

// 显示消息预览
async function showMessagePreview() {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        toastr.info('正在捕获消息数据...', '', { timeOut: 5000 });
        
        const captureResult = await captureRealMessageData();
        let rawContent = '';

        console.log('[预览] 捕获结果:', captureResult);

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
            console.log('[预览] 使用备用方案获取消息内容');
            const messageData = await getCurrentMessageContent();
            rawContent = formatPreviewContent(messageData, false);
        }

        const popupContent = `<div class="message-preview-container"><div class="message-preview-content-box">${rawContent}</div></div>`;
        await callGenericPopup(popupContent, POPUP_TYPE.TEXT, '消息预览 - 数据捕获', { wide: true, large: true });

    } catch (error) {
        console.error('[预览] 预览失败:', error);
        toastr.error('无法显示消息预览: ' + error.message);
    }
}

// 格式化消息数组
function formatMessagesArray(messages, userInput) {
    let content = `messages: [\n`;
    let processedMessages = [...messages];
    
    // 去重处理
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
    
    console.log('[预览] 保存API请求到历史, 当前历史数量:', apiRequestHistory.length);
}

// 增强的拦截API请求函数
function interceptApiRequests() {
    const originalFetch = window.fetch;
    
    window.fetch = function(...args) {
        const [url, options] = args;
        
        // 更精确的LLM请求识别
        const isLLMRequest = url && options?.body && (
            url.includes('/api/openai') || 
            url.includes('/v1/chat/completions') || 
            url.includes('/api/backends/chat-completions') || 
            url.includes('/generate') || 
            url.includes('/chat/completions') || 
            url.includes('claude') || 
            url.includes('anthropic') ||
            (options.method === 'POST' && typeof options.body === 'string' && options.body.includes('"messages"'))
        );
        
        // 排除非LLM请求
        const isExcludedRequest = url && (
            url.includes('/api/chats/') || 
            url.includes('/api/characters') || 
            url.includes('/api/settings') || 
            url.includes('/api/images') || 
            url.includes('/api/files') ||
            url.includes('/api/worldinfo') ||
            url.includes('.png') || url.includes('.jpg') || url.includes('.gif')
        );
        
        if (isLLMRequest && !isExcludedRequest && options?.body) {
            try {
                const requestData = JSON.parse(options.body);
                
                if (requestData.messages && requestData.messages.length > 0) {
                    const apiData = {
                        url, 
                        model: requestData.model || 'Unknown', 
                        timestamp: Date.now(),
                        messages: requestData.messages, 
                        fullRequest: requestData
                    };
                    
                    // 只有非预览模式的请求才保存到历史
                    if (!apiData.isPreview) {
                        lastApiRequest = apiData;
                        saveApiRequestToHistory(apiData);
                        console.log('[预览] 拦截到真实API请求，消息数量:', requestData.messages.length);
                    }
                }
            } catch (e) {
                console.warn('[预览] 解析API请求失败:', e);
            }
        }
        
        return originalFetch.apply(this, args);
    };
    
    console.log('[预览] API请求拦截器已安装');
}

// 模块初始化
function initMessagePreview() {
    try {
        console.log('[预览] 开始初始化消息预览模块');
        
        // 安装API请求拦截器
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
        setTimeout(() => {
            addHistoryButtonsToMessages();
        }, 500);
        
        // 设置事件监听器
        if (eventSource) {
            // 消息渲染事件
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
            
            // 聊天切换事件
            eventSource.on(event_types.CHAT_CHANGED, () => {
                setTimeout(() => {
                    addHistoryButtonsToMessages();
                    apiRequestHistory = [];
                    console.log('[预览] 聊天切换，清空API历史');
                }, 300);
            });
            
            // 消息接收事件 - 关联消息ID
            eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
                setTimeout(() => {
                    const recentRequest = apiRequestHistory.find(record =>
                        !record.associatedMessageId && (Date.now() - record.timestamp) < 30000
                    );
                    if (recentRequest) {
                        recentRequest.associatedMessageId = messageId;
                        console.log('[预览] 关联消息ID:', messageId);
                    }
                }, 200);
            });
        }
        
        console.log('[预览] 消息预览模块初始化完成');
        
    } catch (error) {
        console.error('[预览] 消息预览模块初始化失败:', error);
    }
}

// 导出函数
export { initMessagePreview };
