import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { statsTracker } from "./statsTracker.js";
import { initTasks } from "./scheduledTasks.js";

const EXT_ID = "LittleWhiteBox";
const EXT_NAME = "小白X";
const MODULE_NAME = "xiaobaix-memory";
const extensionFolderPath = `scripts/extensions/third-party/${EXT_ID}`;

// 初始化插件设置
extension_settings[EXT_ID] = extension_settings[EXT_ID] || {
    enabled: true,
    sandboxMode: false,
    memoryEnabled: true,
    memoryInjectEnabled: true,
    memoryInjectDepth: 2
};

const settings = extension_settings[EXT_ID];

// 辅助函数
async function waitForElement(selector, root = document, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const element = root.querySelector(selector);
        if (element) return element;
        await new Promise(r => setTimeout(r, 100));
    }
    return null;
}

function generateUniqueId() {
    return `xiaobaix-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// 内容渲染逻辑
function shouldRenderContent(content, className) {
    if (!content || typeof content !== 'string') return false;
    
    const isHtmlLike = content.includes('<html') || 
                       content.includes('<!DOCTYPE') || 
                       content.includes('<body') || 
                       content.includes('<head') || 
                       content.includes('<script') || 
                       content.includes('<div') || 
                       content.includes('<style');
    
    const isJsLike = className && (
        className.includes('language-js') || 
        className.includes('language-javascript') || 
        className.includes('language-html')
    );
    
    return isHtmlLike || isJsLike;
}

function createIframeApi() {
    return `
    window.STBridge = {
        sendMessageToST: function(type, data = {}) {
            try {
                window.parent.postMessage({
                    source: 'xiaobaix-iframe',
                    type: type, 
                    ...data
                }, '*');
            } catch(e) {}
        },
        
        updateHeight: function() {
            try {
                const height = document.body.scrollHeight;
                if (height > 0) {
                    this.sendMessageToST('resize', { height });
                }
            } catch(e) {}
        }
    };
    
    window.STscript = async function(command) {
        return new Promise((resolve, reject) => {
            try {
                const id = Date.now().toString() + Math.random().toString(36).substring(2);
                
                window.STBridge.sendMessageToST('runCommand', { command, id });
                
                const listener = function(event) {
                    if (!event.data || event.data.source !== 'xiaobaix-host') return;
                    
                    const data = event.data;
                    if ((data.type === 'commandResult' || data.type === 'commandError') && data.id === id) {
                        window.removeEventListener('message', listener);
                        
                        if (data.type === 'commandResult') {
                            resolve(data.result);
                        } else {
                            reject(new Error(data.error));
                        }
                    }
                };
                
                window.addEventListener('message', listener);
                
                setTimeout(() => {
                    window.removeEventListener('message', listener);
                    reject(new Error('Command timeout'));
                }, 30000);
            } catch(e) {
                reject(e);
            }
        });
    };
    
    function setupAutoResize() {
        window.STBridge.updateHeight();
        
        window.addEventListener('resize', () => window.STBridge.updateHeight());
        window.addEventListener('load', () => window.STBridge.updateHeight());
        
        try {
            const observer = new MutationObserver(() => window.STBridge.updateHeight());
            observer.observe(document.body, {
                attributes: true,
                childList: true,
                subtree: true,
                characterData: true
            });
        } catch(e) {}
        
        setInterval(() => window.STBridge.updateHeight(), 1000);
        
        window.addEventListener('load', function() {
            Array.from(document.images).forEach(img => {
                if (!img.complete) {
                    img.addEventListener('load', () => window.STBridge.updateHeight());
                    img.addEventListener('error', () => window.STBridge.updateHeight());
                }
            });
        });
    }
    
    function setupSecurity() {
        document.addEventListener('click', function(e) {
            const link = e.target.closest('a');
            if (link && link.href && link.href.startsWith('http')) {
                if (link.target !== '_blank') {
                    e.preventDefault();
                    window.open(link.href, '_blank');
                }
            }
        });
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            setupAutoResize();
            setupSecurity();
        });
    } else {
        setupAutoResize();
        setupSecurity();
    }
    `;
}

// 斜杠命令执行
async function executeSlashCommand(command) {
    try {
        if (!command) return { error: "命令为空" };
        
        if (!command.startsWith('/')) {
            command = '/' + command;
        }
        
        const { executeSlashCommands, substituteParams } = getContext();
        
        if (typeof executeSlashCommands !== 'function') {
            throw new Error("executeSlashCommands 函数不可用");
        }
        
        command = substituteParams(command);
        
        const result = await executeSlashCommands(command, true);
        
        if (result && typeof result === 'object' && result.pipe !== undefined) {
            const pipeValue = result.pipe;
            
            if (typeof pipeValue === 'string') {
                try {
                    return JSON.parse(pipeValue);
                } catch {
                    return pipeValue;
                }
            }
            
            return pipeValue;
        }
        
        if (typeof result === 'string' && result.trim()) {
            try {
                return JSON.parse(result);
            } catch {
                return result;
            }
        }
        
        return result === undefined ? "" : result;
        
    } catch (err) {
        throw err;
    }
}

// iframe 通信处理
function handleIframeMessage(event) {
    if (!event.data || event.data.source !== 'xiaobaix-iframe') return;
    
    const data = event.data;
    
    switch (data.type) {
        case 'resize':
            handleResizeMessage(event.source, data);
            break;
        case 'runCommand':
            handleCommandMessage(event.source, data);
            break;
    }
}

function handleResizeMessage(source, data) {
    try {
        const iframes = document.querySelectorAll('iframe.xiaobaix-iframe');
        for (const iframe of iframes) {
            if (iframe.contentWindow === source) {
                iframe.style.height = `${data.height}px`;
                break;
            }
        }
    } catch (err) {}
}

async function handleCommandMessage(source, data) {
    try {
        const result = await executeSlashCommand(data.command);
        
        source.postMessage({
            source: 'xiaobaix-host',
            type: 'commandResult',
            id: data.id,
            result: result
        }, '*');
    } catch (err) {
        source.postMessage({
            source: 'xiaobaix-host',
            type: 'commandError',
            id: data.id,
            error: err.message || String(err)
        }, '*');
    }
}

// HTML 渲染
function renderHtmlInIframe(htmlContent, container, codeBlock) {
    try {
        const iframeId = generateUniqueId();
        
        const iframe = document.createElement('iframe');
        iframe.id = iframeId;
        iframe.className = 'xiaobaix-iframe';
        iframe.style.cssText = `
            width: 100%;
            border: none;
            background: transparent;
            overflow: hidden;
            height: 0;
            margin: 0;
            padding: 0;
            display: block;
        `;
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('scrolling', 'no');
        
        if (settings.sandboxMode) {
            iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
        }
        
        container.appendChild(iframe);
        
        let finalHtml = prepareHtmlContent(htmlContent);
        
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        iframeDoc.open();
        iframeDoc.write(finalHtml);
        iframeDoc.close();
        
        if (codeBlock) {
            codeBlock.style.display = 'none';
        }
        
        return iframe;
    } catch (err) {
        return null;
    }
}

function prepareHtmlContent(htmlContent) {
    if (htmlContent.includes('<html') && htmlContent.includes('</html>')) {
        return htmlContent.replace('</head>', `<script>${createIframeApi()}</script></head>`);
    }
    
    if (htmlContent.includes('<body') && htmlContent.includes('</body>')) {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            margin: 0;
            padding: 10px;
            font-family: inherit;
            color: inherit;
            background: transparent;
        }
    </style>
    <script>${createIframeApi()}</script>
</head>
${htmlContent}
</html>`;
    }
    
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            margin: 0;
            padding: 10px;
            font-family: inherit;
            color: inherit;
            background: transparent;
        }
    </style>
    <script>${createIframeApi()}</script>
</head>
<body>
${htmlContent}
</body>
</html>`;
}

// 代码块处理
function processCodeBlocks(messageElement) {
    if (!settings.enabled) return;
    
    try {
        const codeBlocks = messageElement.querySelectorAll('pre > code');
        
        codeBlocks.forEach(codeBlock => {
            const preElement = codeBlock.parentElement;
            
            if (preElement.dataset.xiaobaixBound === 'true') return;
            preElement.dataset.xiaobaixBound = 'true';
            
            const codeContent = codeBlock.textContent || '';
            const codeClass = codeBlock.className || '';
            
            if (shouldRenderContent(codeContent, codeClass)) {
                renderHtmlInIframe(codeContent, preElement.parentNode, preElement);
            }
        });
    } catch (err) {}
}

// 设置面板
async function setupSettings() {
    try {
        const settingsContainer = await waitForElement("#extensions_settings");
        if (!settingsContainer) return;
        
        const response = await fetch(`${extensionFolderPath}/settings.html`);
        const settingsHtml = await response.text();
        
        $(settingsContainer).append(settingsHtml);

        $("#xiaobaix_enabled").prop("checked", settings.enabled).on("change", function() {
            settings.enabled = !!$(this).prop("checked");
            saveSettingsDebounced();
        });
        
        $("#xiaobaix_sandbox").prop("checked", settings.sandboxMode).on("change", function() {
            settings.sandboxMode = !!$(this).prop("checked");
            saveSettingsDebounced();
        });

        $("#xiaobaix_memory_enabled").prop("checked", settings.memoryEnabled).on("change", function() {
            settings.memoryEnabled = !!$(this).prop("checked");
            saveSettingsDebounced();
            
            if (settings.memoryEnabled && settings.memoryInjectEnabled) {
                statsTracker.updateMemoryPrompt();
            } else if (!settings.memoryEnabled) {
                statsTracker.removeMemoryPrompt();
            }
        });
        
        $("#xiaobaix_memory_inject").prop("checked", settings.memoryInjectEnabled).on("change", function() {
            settings.memoryInjectEnabled = !!$(this).prop("checked");
            saveSettingsDebounced();
            
            if (settings.memoryEnabled && settings.memoryInjectEnabled) {
                statsTracker.updateMemoryPrompt();
            } else {
                statsTracker.removeMemoryPrompt();
            }
        });
        
        $("#xiaobaix_memory_depth").val(settings.memoryInjectDepth).on("change", function() {
            settings.memoryInjectDepth = parseInt($(this).val()) || 2;
            saveSettingsDebounced();

            if (settings.memoryEnabled && settings.memoryInjectEnabled) {
                statsTracker.updateMemoryPrompt();
            }
        });
    } catch (err) {}
}

// 设置菜单标籤切换功能
function setupMenuTabs() {
    console.log('Setting up menu tabs...');

    // 为菜单标籤添加点击事件
    $(document).on('click', '.menu-tab', function() {
        console.log('Menu tab clicked:', $(this).attr('data-target'));
        const targetId = $(this).attr('data-target');

        // 移除所有活动状态
        $('.menu-tab').removeClass('active');

        // 隐藏所有设置区域
        $('.settings-section').hide();

        // 激活当前标籤
        $(this).addClass('active');

        // 显示对应的设置区域
        $('.' + targetId).show();
    });

    // 设置默认状态：显示小白X区域，隐藏其他区域
    setTimeout(() => {
        console.log('Setting default tab state...');
        const jsMemorySection = $('.js-memory');
        const taskSection = $('.task');
        const instructionsSection = $('.instructions');
        const jsMemoryTab = $('.menu-tab[data-target="js-memory"]');
        const taskTab = $('.menu-tab[data-target="task"]');
        const instructionsTab = $('.menu-tab[data-target="instructions"]');

        console.log('Found elements:', {
            jsMemorySection: jsMemorySection.length,
            taskSection: taskSection.length,
            instructionsSection: instructionsSection.length,
            jsMemoryTab: jsMemoryTab.length,
            taskTab: taskTab.length,
            instructionsTab: instructionsTab.length
        });

        if (jsMemorySection.length && taskSection.length && instructionsSection.length) {
            // 显示小白X，隐藏其他
            jsMemorySection.show();
            taskSection.hide();
            instructionsSection.hide();

            // 设置活动标籤
            jsMemoryTab.addClass('active');
            taskTab.removeClass('active');
            instructionsTab.removeClass('active');
            console.log('Default state set successfully');
        } else {
            console.log('Some elements not found, retrying...');
            // 如果元素还没有准备好，再试一次
            setTimeout(() => {
                $('.js-memory').show();
                $('.task').hide();
                $('.instructions').hide();
                $('.menu-tab[data-target="js-memory"]').addClass('active');
                $('.menu-tab[data-target="task"]').removeClass('active');
                $('.menu-tab[data-target="instructions"]').removeClass('active');
            }, 500);
        }
    }, 300);
}

// 事件监听
function setupEventListeners() {
    const { eventSource, event_types } = getContext();
    
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageComplete);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    
    window.addEventListener('message', handleIframeMessage);
    
    async function onMessageComplete(data) {
        if (!settings.enabled || !settings.memoryEnabled) return;
        
        setTimeout(async () => {
            const messageId = typeof data === 'object' ? data.messageId : data;
            
            if (!messageId) return;
            
            const messageElement = document.querySelector(`div.mes[mesid="${messageId}"] .mes_text`);
            if (messageElement) {
                const messageText = messageElement.textContent || '';
                const characterName = statsTracker.getCharacterFromMessage(messageElement);
                await statsTracker.updateStatisticsForNewMessage(messageText, characterName);
                
                const memoryButton = $(`.mes[mesid="${messageId}"] .memory-button`);
                if (memoryButton.length) {
                    memoryButton.addClass('has-memory');
                }
            }
        }, 300);
    }
    
    async function onMessageRendered(data) {
        if (!settings.enabled) return;
        
        setTimeout(async () => {
            const messageId = data.messageId;
            const messageElement = document.querySelector(`div.mes[mesid="${messageId}"] .mes_text`);
            if (messageElement) {
                processCodeBlocks(messageElement);
                
                if (settings.memoryEnabled) {
                    statsTracker.addMemoryButtonToMessage(messageId);
                }
            }
        }, 100);
    }
    
    async function onChatChanged() {
        if (!settings.memoryEnabled) return;
        
        try {
            setTimeout(async () => {
                let stats = await executeSlashCommand('/getvar xiaobaix_stats');
                
                if (!stats || stats === "undefined") {
                    const messages = await statsTracker.processMessageHistory();
                    if (messages && messages.length > 0) {
                        const newStats = statsTracker.createEmptyStats();
                        
                        for (const message of messages) {
                            statsTracker.updateStatsFromText(newStats, message.content, message.name);
                        }
                        
                        await executeSlashCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(newStats)}`);
                        
                        if (settings.memoryInjectEnabled) {
                            statsTracker.updateMemoryPrompt();
                        }
                    }
                } else if (settings.memoryInjectEnabled) {
                    statsTracker.updateMemoryPrompt();
                }
            }, 500);
        } catch (error) {}
    }
}

function processExistingMessages() {
    if (!settings.enabled) return;
    
    const messages = document.querySelectorAll('.mes_text');
    messages.forEach(message => {
        processCodeBlocks(message);
    });

    if (settings.memoryEnabled) {
        $('#chat .mes').each(function() {
            const messageId = $(this).attr('mesid');
            if (messageId) {
                statsTracker.addMemoryButtonToMessage(messageId);
            }
        });
    }
}

async function initExtension() {
    try {
        const response = await fetch(`${extensionFolderPath}/style.css`);
        const styleText = await response.text();
        
        const styleElement = document.createElement('style');
        styleElement.textContent = styleText;
        document.head.appendChild(styleElement);
        
        // 初始化统计追踪器
        statsTracker.init(EXT_ID, MODULE_NAME, settings, executeSlashCommand);
        
        await setupSettings();
        setupEventListeners();
        initTasks();

        // 确保菜单切换在所有初始化完成后设置
        setTimeout(() => {
            setupMenuTabs();
        }, 500);
        
        setTimeout(async () => {
            processExistingMessages();
            
            if (settings.memoryEnabled) {
                const messages = await statsTracker.processMessageHistory();
                if (messages && messages.length > 0) {
                    const stats = statsTracker.createEmptyStats();
                    
                    for (const message of messages) {
                        statsTracker.updateStatsFromText(stats, message.content, message.name);
                    }
                    
                    await executeSlashCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(stats)}`);
                    
                    if (settings.memoryInjectEnabled) {
                        statsTracker.updateMemoryPrompt();
                    }
                }
            }
        }, 1000);
        
        setInterval(processExistingMessages, 5000);
    } catch (err) {}
}

// 导出执行命令函数给其他模块使用
export { executeSlashCommand };

// 初始化插件
initExtension();
