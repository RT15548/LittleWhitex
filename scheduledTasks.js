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
let isExecutingTask = false, isCommandGenerated = false;
const TASK_COOLDOWN = 3000;
const taskLastExecutionTime = new Map();

// 获取并初始化设置
function getSettings() {
    if (!extension_settings[EXT_ID].tasks) extension_settings[EXT_ID].tasks = structuredClone(defaultSettings);
    const settings = extension_settings[EXT_ID].tasks;
    Object.keys(defaultSettings).forEach(key => {
        if (settings[key] === undefined) settings[key] = defaultSettings[key];
    });
    return settings;
}

// 冷却管理
function isTaskInCooldown(taskName) {
    const lastExecution = taskLastExecutionTime.get(taskName);
    return lastExecution && (Date.now() - lastExecution) < TASK_COOLDOWN;
}

function setTaskCooldown(taskName) {
    taskLastExecutionTime.set(taskName, Date.now());
}

// 消息处理状态管理
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

// 角色任务管理
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

// 执行命令
async function executeCommands(commands, taskName) {
    if (!commands?.trim()) return null;
    isCommandGenerated = true;
    isExecutingTask = true;
    try {
        return await executeSlashCommand(commands);
    } finally {
        setTimeout(() => {
            isCommandGenerated = false;
            isExecutingTask = false;
        }, 500);
    }
}

// 计算楼层和轮次
function calculateFloorByType(floorType) {
    if (!Array.isArray(chat) || chat.length === 0) return 0;
    let count = 0;
    switch (floorType) {
        case 'user': count = Math.max(0, chat.filter(msg => msg.is_user && !msg.is_system).length - 1); break;
        case 'llm': count = Math.max(0, chat.filter(msg => !msg.is_user && !msg.is_system).length - 1); break;
        default: count = Math.max(0, chat.length - 1); break;
    }
    return count;
}

function calculateTurnCount() {
    if (!Array.isArray(chat) || chat.length === 0) return 0;
    const userMessages = chat.filter(msg => msg.is_user && !msg.is_system).length;
    const aiMessages = chat.filter(msg => !msg.is_user && !msg.is_system).length;
    return Math.min(userMessages, aiMessages);
}

// 任务执行检查
async function checkAndExecuteTasks(triggerContext = 'after_ai', overrideChatChanged = null, overrideNewChat = null) {
    const settings = getSettings();
    if (!settings.enabled || (overrideChatChanged ?? chatJustChanged) || (overrideNewChat ?? isNewChat) || isExecutingTask) return;
    
    const allTasks = [...settings.globalTasks, ...getCharacterTasks()];
    const executedTasksInThisCheck = [];
    
    for (const task of allTasks) {
        if (task.disabled || task.interval <= 0 || isTaskInCooldown(task.name) || executedTasksInThisCheck.includes(task.name)) continue;
        
        const taskTriggerTiming = task.triggerTiming || 'after_ai';
        let shouldExecute = false;

        if (taskTriggerTiming === 'per_turn') {
            if (triggerContext !== 'after_ai') continue;
            const currentTurnCount = calculateTurnCount();
            if (currentTurnCount > lastTurnCount && currentTurnCount % task.interval === 0) shouldExecute = true;
        } else {
            if (taskTriggerTiming !== triggerContext) continue;
            const currentFloor = calculateFloorByType(task.floorType || 'all');
            if (currentFloor % task.interval === 0 && currentFloor > 0) shouldExecute = true;
        }
        
        if (shouldExecute) {
            setTaskCooldown(task.name);
            executedTasksInThisCheck.push(task.name);
            await executeCommands(task.commands, task.name);
        }
    }

    if (triggerContext === 'after_ai') lastTurnCount = calculateTurnCount();
}

// 事件处理
// 在onMessageReceived函数中添加swipe检测
async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled || typeof messageId !== 'number' || messageId < 0 || messageId >= chat.length) return;
    
    const message = chat[messageId];
    if (!message || message.is_user || message.is_system || message.mes === '...' || isCommandGenerated || isExecutingTask) return;
    
    if (message.swipe_id !== undefined && message.swipe_id > 0) {
        console.debug('[Tasks] 跳过swipe消息，不触发任务');
        return;
    }
    
    const messageKey = `${getContext().chatId}_${messageId}`;
    if (isMessageProcessed(messageKey)) return;
    
    markMessageAsProcessed(messageKey);
    await checkAndExecuteTasks('after_ai');
    chatJustChanged = isNewChat = false;
}


async function onUserMessage() {
    const settings = getSettings();
    if (!settings.enabled) return;
    const messageKey = `${getContext().chatId}_user_${chat.length}`;
    if (isMessageProcessed(messageKey)) return;
    markMessageAsProcessed(messageKey);
    await checkAndExecuteTasks('before_user');
    chatJustChanged = isNewChat = false;
}

function onMessageDeleted(data) {
    const settings = getSettings();
    const chatId = getContext().chatId;
    const validMessageKeys = [];
    for (let i = 0; i < chat.length; i++) {
        validMessageKeys.push(`${chatId}_${i}`);
        validMessageKeys.push(`${chatId}_user_${i}`);
    }
    settings.processedMessages = settings.processedMessages.filter(key => {
        if (key.startsWith(`${chatId}_`)) return validMessageKeys.some(validKey => key.startsWith(validKey));
        return true;
    });
    saveSettingsDebounced();
}

function onChatChanged(chatId) {
    chatJustChanged = true;
    isNewChat = lastChatId !== chatId && chat.length <= 1;
    lastChatId = chatId;
    lastTurnCount = 0;
    isExecutingTask = false;
    isCommandGenerated = false;
    taskLastExecutionTime.clear();
    
    const settings = getSettings();
    settings.processedMessages = settings.processedMessages.filter(key => !key.startsWith(`${chatId}_`));
    saveSettingsDebounced();
    
    checkEmbeddedTasks();
    refreshTaskLists();
    setTimeout(() => { chatJustChanged = isNewChat = false; }, 2000);
}

// UI管理
function createTaskItem(task, index, isCharacterTask = false) {
    if (!task.id) task.id = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const taskType = isCharacterTask ? 'character' : 'global';
    const floorTypeText = { user: '用户楼层', llm: 'LLM楼层' }[task.floorType] || '全部楼层';
    const triggerTimingText = { before_user: '用户前', per_turn: '每轮' }[task.triggerTiming] || 'AI后';
    const displayName = task.interval === 0 ? `${task.name} (手动激活)` : `${task.name} (每${task.interval}${floorTypeText}·${triggerTimingText})`;

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

function refreshTaskLists() {
    $('#global_tasks_list, #character_tasks_list').empty();
    getSettings().globalTasks.forEach((task, i) => $('#global_tasks_list').append(createTaskItem(task, i, false)));
    getCharacterTasks().forEach((task, i) => $('#character_tasks_list').append(createTaskItem(task, i, true)));
}

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

function saveTask(task, index, isCharacterTask) {
    const tasks = isCharacterTask ? getCharacterTasks() : getSettings().globalTasks;
    if (index >= 0 && index < tasks.length) tasks[index] = task;
    isCharacterTask ? saveCharacterTasks(tasks) : saveSettingsDebounced();
    refreshTaskLists();
}

async function testTask(index, type) {
    const task = (type === 'character' ? getCharacterTasks() : getSettings().globalTasks)[index];
    if (task) await executeCommands(task.commands, task.name);
}

function editTask(index, type) {
    const task = (type === 'character' ? getCharacterTasks() : getSettings().globalTasks)[index];
    if (task) showTaskEditor(task, true, type === 'character');
}

function deleteTask(index, type) {
    const task = (type === 'character' ? getCharacterTasks() : getSettings().globalTasks)[index];
    if (!task) return;
    
    $(document).off('keydown.confirmmodal');
    $('.xiaobaix-confirm-modal').remove();
    
    const dialogHtml = `
    <div class="xiaobaix-confirm-modal">
        <div class="xiaobaix-confirm-content">
            <div class="xiaobaix-confirm-message">确定要删除任务 "${task.name}" 吗？</div>
            <div class="xiaobaix-confirm-buttons">
                <button class="xiaobaix-confirm-yes">确定</button>
                <button class="xiaobaix-confirm-no">取消</button>
            </div>
        </div>
    </div>`;
    
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
    
    $('.xiaobaix-confirm-no, .xiaobaix-confirm-modal').on('click', function(e) {
        if (e.target === this) $('.xiaobaix-confirm-modal').remove();
    });
    
    $(document).on('keydown.confirmmodal', function(e) {
        if (e.key === 'Escape') {
            $('.xiaobaix-confirm-modal').remove();
            $(document).off('keydown.confirmmodal');
        }
    });
}

async function testAllTasks() {
    for (const task of [...getSettings().globalTasks, ...getCharacterTasks()]) {
        if (!task.disabled) await executeCommands(task.commands, task.name);
    }
}

function getAllTaskNames() {
    return [...getSettings().globalTasks, ...getCharacterTasks()].filter(t => !t.disabled).map(t => t.name);
}

// 嵌入任务检查
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
                    result = await callGenericPopup(templateElement, POPUP_TYPE.CONFIRM, '', { okButton: '允许' });
                } catch (error) {
                    result = await callGenericPopup(`此角色包含 ${tasks.length} 个定时任务。是否允许使用？`, POPUP_TYPE.CONFIRM, '', { okButton: '允许' });
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

// 导入导出
async function exportCharacterTasks() {
    if (!this_chid || !characters[this_chid]) return;
    const tasks = getCharacterTasks();
    if (tasks.length === 0) return;
    const characterName = characters[this_chid].name;
    const fileName = `${characterName.replace(/[\s.<>:"/\\|?*\x00-\x1F\x7F]/g, '_').toLowerCase()}_tasks.json`;
    const fileData = JSON.stringify({ character: characterName, exportDate: new Date().toISOString(), tasks }, null, 4);
    download(fileData, fileName, 'application/json');
}

async function importCharacterTasks(file) {
    if (!file || !this_chid || !characters[this_chid]) return;
    try {
        const fileText = await getFileText(file);
        const importData = JSON.parse(fileText);
        if (!Array.isArray(importData.tasks)) throw new Error('无效的任务文件格式');
        const tasksToImport = importData.tasks.map(task => ({ ...task, id: uuidv4(), importedAt: new Date().toISOString() }));
        await saveCharacterTasks([...getCharacterTasks(), ...tasksToImport]);
        refreshTaskLists();
    } catch (error) {
        console.error('任务导入失败:', error);
    }
}

// 工具函数
function clearProcessedMessages() {
    getSettings().processedMessages = [];
    saveSettingsDebounced();
}

function clearTaskCooldown(taskName = null) {
    if (taskName) taskLastExecutionTime.delete(taskName);
    else taskLastExecutionTime.clear();
}

function getTaskCooldownStatus() {
    const status = {};
    for (const [taskName, lastTime] of taskLastExecutionTime.entries()) {
        const remaining = Math.max(0, TASK_COOLDOWN - (Date.now() - lastTime));
        status[taskName] = { lastExecutionTime: lastTime, remainingCooldown: remaining, isInCooldown: remaining > 0 };
    }
    return status;
}

// 全局API
window.executeScheduledTaskByName = async (name) => {
    if (!name?.trim()) throw new Error('请提供任务名称');
    const task = [...getSettings().globalTasks, ...getCharacterTasks()].find(t => t.name.toLowerCase() === name.toLowerCase());
    if (!task) throw new Error(`找不到名为 "${name}" 的任务`);
    if (task.disabled) throw new Error(`任务 "${name}" 已被禁用`);
    if (isTaskInCooldown(task.name)) {
        const cooldownStatus = getTaskCooldownStatus()[task.name];
        throw new Error(`任务 "${name}" 仍在冷却中，剩余 ${cooldownStatus.remainingCooldown}ms`);
    }
    setTaskCooldown(task.name);
    const result = await executeCommands(task.commands, task.name);
    return result || `已执行任务: ${task.name}`;
};

window.setScheduledTaskInterval = async (name, interval) => {
    if (!name?.trim()) throw new Error('请提供任务名称');
    const intervalNum = parseInt(interval);
    if (isNaN(intervalNum) || intervalNum < 0 || intervalNum > 99999) throw new Error('间隔必须是 0-99999 之间的数字');

    const settings = getSettings();
    const globalTaskIndex = settings.globalTasks.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
    if (globalTaskIndex !== -1) {
        settings.globalTasks[globalTaskIndex].interval = intervalNum;
        saveSettingsDebounced();
        refreshTaskLists();
        return `已设置全局任务 "${name}" 的间隔为 ${intervalNum === 0 ? '手动激活' : `每${intervalNum}楼层`}`;
    }

    const characterTasks = getCharacterTasks();
    const characterTaskIndex = characterTasks.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
    if (characterTaskIndex !== -1) {
        characterTasks[characterTaskIndex].interval = intervalNum;
        await saveCharacterTasks(characterTasks);
        refreshTaskLists();
        return `已设置角色任务 "${name}" 的间隔为 ${intervalNum === 0 ? '手动激活' : `每${intervalNum}楼层`}`;
    }
    throw new Error(`找不到名为 "${name}" 的任务`);
};

window.clearTasksProcessedMessages = clearProcessedMessages;
window.clearTaskCooldown = clearTaskCooldown;
window.getTaskCooldownStatus = getTaskCooldownStatus;

// 注册斜杠命令
function registerSlashCommands() {
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'xbqte',
            callback: async (args, value) => {
                if (!value) return '请提供任务名称。用法: /xbqte 任务名称';
                try {
                    return await window.executeScheduledTaskByName(value);
                } catch (error) {
                    return `错误: ${error.message}`;
                }
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({
                description: '要执行的任务名称',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: getAllTaskNames
            })],
            helpString: '执行指定名称的定时任务。例如: /xbqte 我的任务名称'
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'xbset',
            callback: async (args, value) => {
                const valueStr = String(value || '').trim();
                const parts = valueStr.split(/\s+/);
                if (!parts || parts.length < 2) return '用法: /xbset 任务名称 间隔数字\n例如: /xbset 我的任务 5\n设为0表示手动激活';
                const interval = parts.pop();
                const taskName = parts.join(' ');
                try {
                    return await window.setScheduledTaskInterval(taskName, interval);
                } catch (error) {
                    return `错误: ${error.message}`;
                }
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({
                description: '任务名称 间隔数字',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true
            })],
            helpString: '设置定时任务的触发间隔。用法: /xbset 任务名称 间隔数字\n例如: /xbset 我的任务 5 (每5楼层触发)\n设为0表示手动激活'
        }));
    } catch (error) {
        console.error("Error registering slash commands:", error);
    }
}

// 初始化模块
function initTasks() {
    if (!extension_settings[EXT_ID].tasks) extension_settings[EXT_ID].tasks = structuredClone(defaultSettings);
    
    $('#scheduled_tasks_enabled').on('input', e => { getSettings().enabled = $(e.target).prop('checked'); saveSettingsDebounced(); });
    $('#add_global_task').on('click', () => showTaskEditor(null, false, false));
    $('#add_character_task').on('click', () => showTaskEditor(null, false, true));
    $('#test_all_tasks').on('click', testAllTasks);
    $('#export_character_tasks').on('click', exportCharacterTasks);
    $('#import_character_tasks').on('click', () => $('#import_tasks_file').trigger('click'));
    $('#import_tasks_file').on('change', function(e) {
        const file = e.target.files[0];
        if (file) { importCharacterTasks(file); $(this).val(''); }
    });
    
    $('#scheduled_tasks_enabled').prop('checked', getSettings().enabled);
    refreshTaskLists();
    
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessage);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.MESSAGE_SWIPED, () => { isExecutingTask = false; isCommandGenerated = false; });
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
    
    registerSlashCommands();
    setTimeout(() => { checkEmbeddedTasks(); }, 1000);
}

export { initTasks };
