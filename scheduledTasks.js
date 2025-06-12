import { extension_settings, getContext, writeExtensionField, renderExtensionTemplateAsync } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid, chat } from "../../../../script.js";
import { executeSlashCommandsWithOptions } from "../../../slash-commands.js";
import { SlashCommandParser } from "../../../slash-commands/SlashCommandParser.js";
import { SlashCommand } from "../../../slash-commands/SlashCommand.js";
import { ARGUMENT_TYPE, SlashCommandArgument } from "../../../slash-commands/SlashCommandArgument.js";
import { callPopup } from "../../../../script.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { accountStorage } from "../../../util/AccountStorage.js";
import { download, getFileText, uuidv4 } from "../../../utils.js";
import { executeSlashCommand } from "./index.js";

const TASKS_MODULE_NAME = "xiaobaix-tasks";
const EXT_ID = "LittleWhiteBox";
const defaultSettings = { enabled: false, globalTasks: [], processedMessages: [], character_allowed_tasks: [] };

let currentEditingTask = null, currentEditingIndex = -1, lastChatId = null, chatJustChanged = false, isNewChat = false, lastTurnCount = 0;

let isExecutingTask = false;
let lastExecutionTime = 0;
const EXECUTION_COOLDOWN = 3000;
let isCommandGenerated = false;

// 获取并初始化设置
function getSettings() {
    if (!extension_settings[EXT_ID].tasks) extension_settings[EXT_ID].tasks = structuredClone(defaultSettings);
    
    const settings = extension_settings[EXT_ID].tasks;
    
    Object.keys(defaultSettings).forEach(key => {
        if (settings[key] === undefined) settings[key] = defaultSettings[key];
    });
    
    return settings;
}

// 管理消息处理状态
function isMessageProcessed(messageKey) { 
    return getSettings().processedMessages.includes(messageKey); 
}

function markMessageAsProcessed(messageKey) {
    const settings = getSettings();
    if (!settings.processedMessages.includes(messageKey)) {
        settings.processedMessages.push(messageKey);
        if (settings.processedMessages.length > 100) settings.processedMessages = settings.processedMessages.slice(-50);
        saveSettingsDebounced();
    }
}

// 获取角色任务
function getCharacterTasks() {
    if (!this_chid || !characters[this_chid]) return [];
    const character = characters[this_chid];
    if (!character.data?.extensions?.[TASKS_MODULE_NAME]) {
        if (!character.data) character.data = {};
        if (!character.data.extensions) character.data.extensions = {};
        character.data.extensions[TASKS_MODULE_NAME] = { tasks: [] };
    }
    return character.data.extensions[TASKS_MODULE_NAME].tasks || [];
}

// 保存角色任务
async function saveCharacterTasks(tasks) {
    if (!this_chid || !characters[this_chid]) return;
    await writeExtensionField(Number(this_chid), TASKS_MODULE_NAME, { tasks });
    const settings = getSettings();
    const avatar = characters[this_chid].avatar;
    if (avatar && !settings.character_allowed_tasks?.includes(avatar)) {
        if (!settings.character_allowed_tasks) settings.character_allowed_tasks = [];
        settings.character_allowed_tasks.push(avatar);
        saveSettingsDebounced();
    }
}

// executeCommands函数
async function executeCommands(commands) {
    if (!commands?.trim()) return null;
    
    isCommandGenerated = true;
    isExecutingTask = true;
    
    try {
        const result = await executeSlashCommand(commands);
        return result;
    } finally {

        setTimeout(() => {
            isCommandGenerated = false;
            isExecutingTask = false;
        }, 500);
    }
}

// 根据楼层类型计算当前楼层数
function calculateFloorByType(floorType) {
    if (!Array.isArray(chat) || chat.length === 0) return 0;
    
    let count = 0;
    switch (floorType) {
        case 'user':
            count = Math.max(0, chat.filter(msg => msg.is_user && !msg.is_system).length - 1);
            break;
        case 'llm':
            count = Math.max(0, chat.filter(msg => !msg.is_user && !msg.is_system).length - 1);
            break;
        default:
            count = Math.max(0, chat.length - 1);
            break;
    }
    
    console.debug(`[Tasks] 计算楼层 - 类型: ${floorType}, 楼层数: ${count}, 总消息数: ${chat.length}`);
    return count;
}

// 计算对话轮次
function calculateTurnCount() {
    if (!Array.isArray(chat) || chat.length === 0) return 0;
    const userMessages = chat.filter(msg => msg.is_user && !msg.is_system).length;
    const aiMessages = chat.filter(msg => !msg.is_user && !msg.is_system).length;
    return Math.min(userMessages, aiMessages);
}

// 改进的任务执行检查函数
async function checkAndExecuteTasks(triggerContext = 'after_ai', overrideChatChanged = null, overrideNewChat = null) {
    const settings = getSettings();
    if (!settings.enabled || (overrideChatChanged ?? chatJustChanged) || (overrideNewChat ?? isNewChat)) return;
    
    // 防止重复执行
    if (isExecutingTask) {
        console.debug('[Tasks] 任务正在执行中，跳过');
        return;
    }
    
    const allTasks = [...settings.globalTasks, ...getCharacterTasks()];
    
    for (const task of allTasks) {
        if (task.disabled || task.interval <= 0) continue;
        
        const taskTriggerTiming = task.triggerTiming || 'after_ai';

        if (taskTriggerTiming === 'per_turn') {
            if (triggerContext !== 'after_ai') continue;
            const currentTurnCount = calculateTurnCount();
            if (currentTurnCount > lastTurnCount && currentTurnCount % task.interval === 0) {
                console.debug(`[Tasks] 执行按轮次任务: ${task.name}`);
                await executeCommands(task.commands);
                break;
            }
        } else {
            if (taskTriggerTiming !== triggerContext) continue;
            const currentFloor = calculateFloorByType(task.floorType || 'all');
            if (currentFloor % task.interval === 0 && currentFloor > 0) { // 添加 > 0 检查
                console.debug(`[Tasks] 执行楼层任务: ${task.name}, 当前楼层: ${currentFloor}`);
                await executeCommands(task.commands);
                break;
            }
        }
    }

    if (triggerContext === 'after_ai') {
        lastTurnCount = calculateTurnCount();
    }
}

// 改进的消息接收处理函数
async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled || typeof messageId !== 'number' || messageId < 0 || messageId >= chat.length) return;
    
    const message = chat[messageId];
    if (!message || message.is_user || message.is_system || message.mes === '...') return;
    
    // 防止命令生成的消息触发任务
    if (isCommandGenerated || isExecutingTask) {
        console.debug('[Tasks] 跳过命令生成的消息');
        return;
    }
    
    // 添加冷却时间检查
    const now = Date.now();
    if (now - lastExecutionTime < EXECUTION_COOLDOWN) {
        console.debug('[Tasks] 冷却时间内，跳过执行');
        return;
    }
    
    const messageKey = `${getContext().chatId}_${messageId}`;
    if (isMessageProcessed(messageKey)) return;
    
    markMessageAsProcessed(messageKey);
    lastExecutionTime = now;
    
    await checkAndExecuteTasks('after_ai');
    chatJustChanged = isNewChat = false;
}

// 处理用户消息事件
async function onUserMessage() {
    const settings = getSettings();
    if (!settings.enabled) return;
    const messageKey = `${getContext().chatId}_user_${chat.length}`;
    if (isMessageProcessed(messageKey)) return;
    markMessageAsProcessed(messageKey);
    await checkAndExecuteTasks('before_user');
    chatJustChanged = isNewChat = false;
}

// 添加消息删除事件处理
function onMessageDeleted(data) {
    console.debug('[Tasks] 消息被删除，清理处理状态');
    
    // 清理processedMessages中相关的记录
    const settings = getSettings();
    const chatId = getContext().chatId;
    
    // 保留当前聊天的有效消息记录
    const validMessageKeys = [];
    for (let i = 0; i < chat.length; i++) {
        validMessageKeys.push(`${chatId}_${i}`);
        validMessageKeys.push(`${chatId}_user_${i}`);
    }
    
    // 过滤掉无效的消息记录
    settings.processedMessages = settings.processedMessages.filter(key => {
        if (key.startsWith(`${chatId}_`)) {
            return validMessageKeys.some(validKey => key.startsWith(validKey));
        }
        return true; // 保留其他聊天的记录
    });
    
    saveSettingsDebounced();
}

// 改进的聊天切换处理
function onChatChanged(chatId) {
    console.debug(`[Tasks] 聊天切换到: ${chatId}`);
    
    chatJustChanged = true;
    isNewChat = lastChatId !== chatId && chat.length <= 1;
    lastChatId = chatId;
    lastTurnCount = 0;
    
    // 重置执行状态
    isExecutingTask = false;
    isCommandGenerated = false;
    lastExecutionTime = 0;
    
    // 清理当前聊天的处理记录
    const settings = getSettings();
    settings.processedMessages = settings.processedMessages.filter(key => 
        !key.startsWith(`${chatId}_`)
    );
    saveSettingsDebounced();
    
    checkEmbeddedTasks();
    refreshTaskLists();
    
    setTimeout(() => { 
        chatJustChanged = isNewChat = false; 
    }, 2000);
}

// 创建任务UI项
function createTaskItem(task, index, isCharacterTask = false) {
    if (!task.id) task.id = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const taskType = isCharacterTask ? 'character' : 'global';
    const floorTypeText = { user: '用戶樓層', llm: 'LLM樓層' }[task.floorType] || '全部樓層';
    const triggerTimingText = { before_user: '用戶前', per_turn: '每輪' }[task.triggerTiming] || 'AI後';
    const displayName = task.interval === 0 ? `${task.name} (手動激活)` : `${task.name} (每${task.interval}${floorTypeText}·${triggerTimingText})`;

    const taskElement = $('#task_item_template').children().first().clone();
    taskElement.attr({ id: task.id, 'data-index': index, 'data-type': taskType });
    taskElement.find('.task_name').attr('title', task.commands).text(displayName);
    taskElement.find('.disable_task').attr('id', `task_disable_${task.id}`).prop('checked', task.disabled);
    taskElement.find('label.checkbox').attr('for', `task_disable_${task.id}`);

    taskElement.find('.disable_task').on('input', () => { task.disabled = taskElement.find('.disable_task').prop('checked'); saveTask(task, index, isCharacterTask); });
    taskElement.find('.test_task').on('click', () => testTask(index, taskType));
    taskElement.find('.edit_task').on('click', () => editTask(index, taskType));
    taskElement.find('.delete_task').on('click', () => deleteTask(index, taskType));
    return taskElement;
}

// 刷新任务列表显示
function refreshTaskLists() {
    $('#global_tasks_list, #character_tasks_list').empty();
    getSettings().globalTasks.forEach((task, i) => $('#global_tasks_list').append(createTaskItem(task, i, false)));
    getCharacterTasks().forEach((task, i) => $('#character_tasks_list').append(createTaskItem(task, i, true)));
}

// 显示任务编辑器
function showTaskEditor(task = null, isEdit = false, isCharacterTask = false) {
    currentEditingTask = task;
    currentEditingIndex = isEdit ? (isCharacterTask ? getCharacterTasks() : getSettings().globalTasks).indexOf(task) : -1;
    const editorTemplate = $('#task_editor_template').clone().removeAttr('id').show();
    editorTemplate.find('.task_name_edit').val(task?.name || '');
    editorTemplate.find('.task_commands_edit').val(task?.commands || '');
    editorTemplate.find('.task_interval_edit').val(task?.interval ?? 3);
    editorTemplate.find('.task_floor_type_edit').val(task?.floorType || 'all');
    editorTemplate.find('.task_trigger_timing_edit').val(task?.triggerTiming || 'after_ai');
    editorTemplate.find('.task_type_edit').val(isCharacterTask ? 'character' : 'global');
    editorTemplate.find('.task_enabled_edit').prop('checked', !task?.disabled);

    callPopup(editorTemplate, 'confirm', undefined, { okButton: '保存' }).then(result => {
        if (result) {
            const newTask = {
                id: task?.id || `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                name: editorTemplate.find('.task_name_edit').val().trim(),
                commands: editorTemplate.find('.task_commands_edit').val().trim(),
                interval: parseInt(editorTemplate.find('.task_interval_edit').val()) || 0,
                floorType: editorTemplate.find('.task_floor_type_edit').val() || 'all',
                triggerTiming: editorTemplate.find('.task_trigger_timing_edit').val() || 'after_ai',
                disabled: !editorTemplate.find('.task_enabled_edit').prop('checked'),
                createdAt: task?.createdAt || new Date().toISOString()
            };
            saveTaskFromEditor(newTask, editorTemplate.find('.task_type_edit').val() === 'character');
        }
    });
}

// 从编辑器保存任务
function saveTaskFromEditor(task, isCharacterTask) {
    if (!task.name || !task.commands) return;
    if (isCharacterTask) {
        const tasks = getCharacterTasks();
        if (currentEditingIndex >= 0) tasks[currentEditingIndex] = task;
        else tasks.push(task);
        saveCharacterTasks(tasks);
    } else {
        const settings = getSettings();
        if (currentEditingIndex >= 0) settings.globalTasks[currentEditingIndex] = task;
        else settings.globalTasks.push(task);
        saveSettingsDebounced();
    }
    refreshTaskLists();
}

// 保存任务更改
function saveTask(task, index, isCharacterTask) {
    const tasks = isCharacterTask ? getCharacterTasks() : getSettings().globalTasks;
    if (index >= 0 && index < tasks.length) tasks[index] = task;
    isCharacterTask ? saveCharacterTasks(tasks) : saveSettingsDebounced();
    refreshTaskLists();
}

// 测试执行指定任务
async function testTask(index, type) {
    const task = (type === 'character' ? getCharacterTasks() : getSettings().globalTasks)[index];
    if (task) await executeCommands(task.commands);
}

// 编辑指定任务
function editTask(index, type) {
    const task = (type === 'character' ? getCharacterTasks() : getSettings().globalTasks)[index];
    if (task) showTaskEditor(task, true, type === 'character');
}

// 删除指定任务
function deleteTask(index, type) {
    const task = (type === 'character' ? getCharacterTasks() : getSettings().globalTasks)[index];
    if (!task) return;
    
    const confirmText = `確定要刪除任務 "${task.name}" 嗎？`;
    $(document).off('keydown.confirmmodal');
    $('.xiaobaix-confirm-modal').remove();
    
    const dialogHtml = `
    <div class="xiaobaix-confirm-modal">
        <div class="xiaobaix-confirm-content">
            <div class="xiaobaix-confirm-message">${confirmText}</div>
            <div class="xiaobaix-confirm-buttons">
                <button class="xiaobaix-confirm-yes">确定</button>
                <button class="xiaobaix-confirm-no">取消</button>
            </div>
        </div>
    </div>
    `;
    
    $('body').append(dialogHtml);
    
    $('.xiaobaix-confirm-yes').on('click', function() {
        $('.xiaobaix-confirm-modal').remove();
        if (type === 'character') {
            const tasks = getCharacterTasks();
            tasks.splice(index, 1);
            saveCharacterTasks(tasks);
        } else {
            getSettings().globalTasks.splice(index, 1);
            saveSettingsDebounced();
        }
        refreshTaskLists();
    });
    
    $('.xiaobaix-confirm-no').on('click', function() {
        $('.xiaobaix-confirm-modal').remove();
    });
    
    $('.xiaobaix-confirm-modal').on('click', function(e) {
        if (e.target === this) {
            $(this).remove();
        }
    });
    
    $(document).on('keydown.confirmmodal', function(e) {
        if (e.key === 'Escape') {
            $('.xiaobaix-confirm-modal').remove();
            $(document).off('keydown.confirmmodal');
        }
    });
}

// 测试执行所有启用的任务
async function testAllTasks() {
    for (const task of [...getSettings().globalTasks, ...getCharacterTasks()]) {
        if (!task.disabled) await executeCommands(task.commands);
    }
}

// 获取所有任务名称列表
function getAllTaskNames() {
    return [...getSettings().globalTasks, ...getCharacterTasks()].filter(t => !t.disabled).map(t => t.name);
}

// 检查并处理角色嵌入任务
async function checkEmbeddedTasks() {
    if (!this_chid) return;
    const avatar = characters[this_chid]?.avatar;
    const tasks = characters[this_chid]?.data?.extensions?.[TASKS_MODULE_NAME]?.tasks;
  
    if (Array.isArray(tasks) && tasks.length > 0 && avatar) {
        const settings = getSettings();
        if (!settings.character_allowed_tasks) settings.character_allowed_tasks = [];
      
        if (!settings.character_allowed_tasks.includes(avatar)) {
            const checkKey = `AlertTasks_${avatar}`;
            if (!accountStorage.getItem(checkKey)) {
                accountStorage.setItem(checkKey, 'true');
                let result;
                try {
                    const templateFilePath = `scripts/extensions/third-party/LittleWhiteBox/embeddedTasks.html`;
                    const templateContent = await fetch(templateFilePath).then(r => r.text());
                    const templateElement = $(templateContent);
                    const taskListContainer = templateElement.find('#embedded-tasks-list');
                    tasks.forEach(task => {
                        const taskPreview = $('#task_preview_template').children().first().clone();
                        taskPreview.find('.task-preview-name').text(task.name);
                        taskPreview.find('.task-preview-interval').text(`(每${task.interval}回合)`);
                        taskPreview.find('.task-preview-commands').text(task.commands);
                        taskListContainer.append(taskPreview);
                    });
                    result = await callGenericPopup(templateElement, POPUP_TYPE.CONFIRM, '', { okButton: '允許' });
                } catch (error) {
                    console.error("Error loading template:", error);
                    result = await callGenericPopup(`此角色包含 ${tasks.length} 個定時任務。是否允許使用？`, POPUP_TYPE.CONFIRM, '', { okButton: '允許' });
                }
                if (result) {
                    settings.character_allowed_tasks.push(avatar);
                    saveSettingsDebounced();
                }
            }
        }
    }
    refreshTaskLists();
}

// 导出角色任务到文件
async function exportCharacterTasks() {
    if (!this_chid || !characters[this_chid]) return;
    const tasks = getCharacterTasks();
    if (tasks.length === 0) return;
    const characterName = characters[this_chid].name;
    const fileName = `${characterName.replace(/[\s.<>:"/\\|?*\x00-\x1F\x7F]/g, '_').toLowerCase()}_tasks.json`;
    const fileData = JSON.stringify({ character: characterName, exportDate: new Date().toISOString(), tasks }, null, 4);
    download(fileData, fileName, 'application/json');
}

// 从文件导入角色任务
async function importCharacterTasks(file) {
    if (!file || !this_chid || !characters[this_chid]) return;
    try {
        const fileText = await getFileText(file);
        const importData = JSON.parse(fileText);
        if (!Array.isArray(importData.tasks)) throw new Error('無效的任務文件格式');
        const tasksToImport = importData.tasks.map(task => ({ ...task, id: uuidv4(), importedAt: new Date().toISOString() }));
        await saveCharacterTasks([...getCharacterTasks(), ...tasksToImport]);
        refreshTaskLists();
    } catch (error) {
        console.error('任務導入失敗:', error);
    }
}

// 添加手动清理功能
function clearProcessedMessages() {
    const settings = getSettings();
    settings.processedMessages = [];
    saveSettingsDebounced();
    console.log('[Tasks] 已清理所有处理记录');
}

// 全局API - 根据名称执行任务
window.executeScheduledTaskByName = async (name) => {
    if (!name?.trim()) throw new Error('請提供任務名稱');
    const task = [...getSettings().globalTasks, ...getCharacterTasks()].find(t => t.name.toLowerCase() === name.toLowerCase());
    if (!task) throw new Error(`找不到名為 "${name}" 的任務`);
    if (task.disabled) throw new Error(`任務 "${name}" 已被禁用`);
    const result = await executeCommands(task.commands);
    return result || `已執行任務: ${task.name}`;
};

// 全局API - 根据名称设置任务间隔
window.setScheduledTaskInterval = async (name, interval) => {
    if (!name?.trim()) throw new Error('請提供任務名稱');
    const intervalNum = parseInt(interval);
    if (isNaN(intervalNum) || intervalNum < 0 || intervalNum > 99999) throw new Error('間隔必須是 0-99999 之間的數字');

    const settings = getSettings();
    const globalTaskIndex = settings.globalTasks.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
    if (globalTaskIndex !== -1) {
        settings.globalTasks[globalTaskIndex].interval = intervalNum;
        saveSettingsDebounced();
        refreshTaskLists();
        return `已設置全局任務 "${name}" 的間隔為 ${intervalNum === 0 ? '手動激活' : `每${intervalNum}樓層`}`;
    }

    const characterTasks = getCharacterTasks();
    const characterTaskIndex = characterTasks.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
    if (characterTaskIndex !== -1) {
        characterTasks[characterTaskIndex].interval = intervalNum;
        await saveCharacterTasks(characterTasks);
        refreshTaskLists();
        return `已設置角色任務 "${name}" 的間隔為 ${intervalNum === 0 ? '手動激活' : `每${intervalNum}樓層`}`;
    }
    throw new Error(`找不到名為 "${name}" 的任務`);
};

// 导出清理函数供调试使用
window.clearTasksProcessedMessages = clearProcessedMessages;

// 注册斜杠命令
function registerSlashCommands() {
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'xbqte',
            callback: async (args, value) => {
                if (!value) return '請提供任務名稱。用法: /xbqte 任務名稱';
                try {
                    return await window.executeScheduledTaskByName(value);
                } catch (error) {
                    return `錯誤: ${error.message}`;
                }
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({
                description: '要執行的任務名稱',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: getAllTaskNames
            })],
            helpString: '執行指定名稱的定時任務。例如: /xbqte 我的任務名稱'
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'xbset',
            callback: async (args, value) => {
                const valueStr = String(value || '').trim();
                const parts = valueStr.split(/\s+/);
                if (!parts || parts.length < 2) return '用法: /xbset 任務名稱 間隔數字\n例如: /xbset 我的任務 5\n設為0表示手動激活';
                const interval = parts.pop();
                const taskName = parts.join(' ');
                try {
                    return await window.setScheduledTaskInterval(taskName, interval);
                } catch (error) {
                    return `錯誤: ${error.message}`;
                }
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({
                description: '任務名稱 間隔數字',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true
            })],
            helpString: '設置定時任務的觸發間隔。用法: /xbset 任務名稱 間隔數字\n例如: /xbset 我的任務 5 (每5樓層觸發)\n設為0表示手動激活'
        }));
    } catch (error) {
        console.error("Error registering slash commands:", error);
    }
}

// 初始化模块
function initTasks() {
    // 初始化任务设置
    if (!extension_settings[EXT_ID].tasks) {
        extension_settings[EXT_ID].tasks = structuredClone(defaultSettings);
    }
    
    // 绑定UI事件
    $('#scheduled_tasks_enabled').on('input', e => { 
        getSettings().enabled = $(e.target).prop('checked'); 
        saveSettingsDebounced(); 
    });
    
    $('#add_global_task').on('click', () => showTaskEditor(null, false, false));
    $('#add_character_task').on('click', () => showTaskEditor(null, false, true));
    $('#test_all_tasks').on('click', testAllTasks);
    $('#export_character_tasks').on('click', exportCharacterTasks);
    $('#import_character_tasks').on('click', () => $('#import_tasks_file').trigger('click'));
    
    $('#import_tasks_file').on('change', function(e) {
        const file = e.target.files[0];
        if (file) { 
            importCharacterTasks(file); 
            $(this).val(''); 
        }
    });
    
    // 设置UI状态
    const settings = getSettings();
    $('#scheduled_tasks_enabled').prop('checked', settings.enabled);
    refreshTaskLists();
    
    // 注册事件监听
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessage);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    
    // 添加消息删除事件监听
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.MESSAGE_SWIPED, () => {
        // 消息滑动时也清理状态
        console.debug('[Tasks] 消息滑动，重置执行状态');
        isExecutingTask = false;
        isCommandGenerated = false;
    });
    
    // 处理角色删除事件
    eventSource.on(event_types.CHARACTER_DELETED, ({ character }) => {
        const avatar = character?.avatar;
        const settings = getSettings();
        if (avatar && settings.character_allowed_tasks?.includes(avatar)) {
            const index = settings.character_allowed_tasks.indexOf(avatar);
            if (index !== -1) {
                settings.character_allowed_tasks.splice(index, 1);
                saveSettingsDebounced();
            }
        }
    });
    
    // 注册斜杠命令
    registerSlashCommands();
    
    // 初始检查嵌入任务
    setTimeout(() => {
        checkEmbeddedTasks();
    }, 1000);
    
    console.log('[Tasks] 插件初始化完成');
}

export { initTasks };

