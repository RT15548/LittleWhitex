/**
 * LittleWhiteBox (小白X) - Advanced Browser Extension
 *
 * Copyright (C) 2025 biex
 * All rights reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * ADDITIONAL ATTRIBUTION REQUIREMENTS:
 * Any use, modification, or distribution of this software must include
 * prominent attribution to the original author "biex" and the project
 * "LittleWhiteBox". See LICENSE.md for complete terms.
 *
 * Project: https://github.com/RT15548/LittleWhiteBox
 * Author: biex
 * License: AGPL-3.0-or-later WITH Custom-Attribution-Requirements
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { setExtensionPrompt, extension_prompt_types } from "../../../../script.js";
import { eventSource, event_types } from "../../../../script.js";

const EXT_ID = "LittleWhiteBox";
const SCRIPT_MODULE_NAME = "xiaobaix-script";
const extensionFolderPath = `scripts/extensions/third-party/${EXT_ID}`;

function initScriptAssistant() {
    if (!extension_settings[EXT_ID].scriptAssistant) {
        extension_settings[EXT_ID].scriptAssistant = { enabled: false };
    }
    
    $('#xiaobaix_script_assistant').on('change', function() {
        const enabled = $(this).prop('checked');
        extension_settings[EXT_ID].scriptAssistant.enabled = enabled;
        saveSettingsDebounced();
        
        if (enabled) {
            injectScriptDocs();
        } else {
            removeScriptDocs();
        }
    });
    
    $('#xiaobaix_script_assistant').prop('checked', extension_settings[EXT_ID].scriptAssistant.enabled);
    
    setupEventListeners();
    
    if (extension_settings[EXT_ID].scriptAssistant.enabled) {
        setTimeout(() => injectScriptDocs(), 1000);
    }
}

function setupEventListeners() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => checkAndInjectDocs(), 500);
    });
    
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        checkAndInjectDocs();
    });
    
    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
        checkAndInjectDocs();
    });
    
    eventSource.on(event_types.SETTINGS_LOADED_AFTER, () => {
        setTimeout(() => checkAndInjectDocs(), 1000);
    });
    
    eventSource.on(event_types.APP_READY, () => {
        setTimeout(() => checkAndInjectDocs(), 1500);
    });
}

function checkAndInjectDocs() {
    if (extension_settings[EXT_ID].scriptAssistant?.enabled) {
        injectScriptDocs();
    } else {
        removeScriptDocs();
    }
}

async function injectScriptDocs() {
    try {
        let docsContent = '';
        
        try {
            const response = await fetch(`${extensionFolderPath}/scriptDocs.md`);
            if (response.ok) {
                docsContent = await response.text();
            }
        } catch (error) {
            docsContent = "无法加载scriptDocs.md文件";
        }
        
        const formattedPrompt = `
【小白X插件 - 写卡助手】
你是小白X插件的内置助手，专门帮助用户创建STscript脚本和交互式界面的角色卡。

关于小白X插件核心功能:

1. 代码块渲染功能:
   - SillyTavern原生只支持显示静态代码块，无法执行JavaScript或渲染HTML
   - 小白X将聊天中被\`\`\`包裹的html标签自动转换为iframe
   - 代码块内的HTML/CSS/JavaScript将被完整执行，形成真正的交互式界面，为了代码完整和可维护，最好使用html标签渲染
   - 提供STscript()函数作为特殊API，让iframe能执行SillyTavern的STscript斜杠命令:
 
   正确用法示例:
   \`\`\`javascript
   // 直接调用STscript函数执行斜杠命令
   await STscript('/echo 你好世界！');
 
   // 获取变量值
   const 天气 = await STscript('/getvar 天气');
 
   // 在界面中显示结果
   document.getElementById('display').innerHTML = 天气;
   \`\`\`
 
   注意: STscript是小白X注入到iframe中的桥接函数，它通过安全的消息传递机制与SillyTavern通信。不要尝试通过window.parent直接访问SillyTavern的函数，这样不会工作。

2. 定时任务模块:
   - 拓展菜单中允许设置"在对话中自动执行"的斜杠命令
   - 可以设置触发频率(每几楼层)、触发条件(AI消息后/用户消息前/每轮对话)
   - 每个任务包含:名称、要执行的命令、触发间隔、触发类型
   - 注册了/xbqte命令手动触发任务: \`/xbqte 任务名称\`
   - 注册了/xbset命令调整任务间隔: \`/xbset 任务名称 间隔数字\`
   - 任务命令可以使用所有标准STscript斜杠命令

以下是SillyTavern命令STscript的完整文档，请基于这些内容和小白X插件功能回答用户问题:

${docsContent}
`;
        
        setExtensionPrompt(
            SCRIPT_MODULE_NAME, 
            formattedPrompt, 
            extension_prompt_types.IN_PROMPT, 
            2,
            false, 
            0
        );
    } catch (error) {}
}

function removeScriptDocs() {
    setExtensionPrompt(SCRIPT_MODULE_NAME, '', extension_prompt_types.IN_PROMPT);
}

export { initScriptAssistant };