import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const EXT_ID = "LittleWhiteBox";
const EXT_NAME = "小白X";

extension_settings[EXT_ID] = extension_settings[EXT_ID] || {
    enabled: true,
    sandboxMode: false
};

const settings = extension_settings[EXT_ID];

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
        console.error('[小白X] 渲染失败:', err);
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

async function setupSettings() {
    try {
        const settingsContainer = await waitForElement("#extensions_settings");
        if (!settingsContainer) return;
        const settingsHtml = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>小白X</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="flex-container">
                    <input type="checkbox" id="xiaobaix_enabled" ${settings.enabled ? 'checked' : ''} />
                    <label for="xiaobaix_enabled">启用小白X</label>
                </div>
                
                <div class="flex-container">
                    <input type="checkbox" id="xiaobaix_sandbox" ${settings.sandboxMode ? 'checked' : ''} />
                    <label for="xiaobaix_sandbox">沙盒模式</label>
                </div>
                
                <hr class="sysHR" />
                
                <div style="font-size:0.9em; opacity:0.8; margin-top:10px;">
                    <p><b>功能说明：</b></p>
                    <p>1. 渲染被\`\`\`包裹的代码块内容为交互式界面</p>
                    <p>2. 提供<code>STscript(command)</code>函数执行酒馆命令</p>
                    <br>
                    <p><b>使用示例：</b></p>
                    <pre style="background: #2a2a2a; padding: 10px; border-radius: 4px;">
// 获取变量
const hp = await STscript('/getvar 生命值');
// 设置变量
await STscript('/setvar key=生命值 100');
// 发送消息
await STscript('/sendas name={{char}} 你好！');
// 显示提示
await STscript('/echo 操作完成！');</pre>
                </div>
            </div>
        </div>`;

        $(settingsContainer).append(settingsHtml);

        $("#xiaobaix_enabled").on("change", function() {
            settings.enabled = !!$(this).prop("checked");
            saveSettingsDebounced();
        });
        
        $("#xiaobaix_sandbox").on("change", function() {
            settings.sandboxMode = !!$(this).prop("checked");
            saveSettingsDebounced();
        });
    } catch (err) {}
}

function setupEventListeners() {
    const { eventSource, event_types } = getContext();
    
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    
    window.addEventListener('message', handleIframeMessage);
    
    function onMessageRendered(_, messageId) {
        if (!settings.enabled) return;
        
        setTimeout(() => {
            const messageElement = document.querySelector(`div.mes[mesid="${messageId}"] .mes_text`);
            if (messageElement) {
                processCodeBlocks(messageElement);
            }
        }, 50);
    }
}

function processExistingMessages() {
    if (!settings.enabled) return;
    
    const messages = document.querySelectorAll('.mes_text');
    messages.forEach(message => {
        processCodeBlocks(message);
    });
}

function addStyles() {
    const styleElement = document.createElement('style');
    styleElement.textContent = `
        .xiaobaix-iframe {
            transition: height 0.3s ease;
        }
        
        pre:has(+ .xiaobaix-iframe) {
            display: none;
        }
    `;
    document.head.appendChild(styleElement);
}

async function initExtension() {
    try {
        console.log('[小白X] 初始化中...');
        
        addStyles();
        await setupSettings();
        setupEventListeners();
        
        setTimeout(processExistingMessages, 1000);
        
        setInterval(processExistingMessages, 5000);
        
        console.log('[小白X] 初始化完成！');
    } catch (err) {
        console.error('[小白X] 初始化失败:', err);
    }
}

initExtension();
