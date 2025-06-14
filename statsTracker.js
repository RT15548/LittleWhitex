/**
 * LittleWhiteBox (小白X) - Statistics Tracker Module
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
 * Any use, modification, or distribution of this software must include
 * prominent attribution to the original author "biex" and the project
 * "LittleWhiteBox".
 *
 * License: Apache-2.0 WITH Custom-Attribution-Requirements
 */

import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles, characters, this_chid, eventSource, event_types } from "../../../../script.js";
import { extension_settings, getContext, writeExtensionField } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { accountStorage } from "../../../util/AccountStorage.js";

class StatsTracker {
    constructor() {
        this.EXT_ID = null;
        this.MODULE_NAME = null;
        this.settings = null;
        this.executeCommand = null;
        this.characterSettings = new Map();
        this.currentCharacterId = null;
        this.isInitialized = false;
        this.autoSaveTimeout = null;
        
        this.relationshipGuidelines = {
            "厌恶": { attitude: "敌对与排斥", allowed: "使用尖锐、讽刺或冰冷的语言回应", limits: "拒绝任何形式的友好互动。主动拉开距离，避免共处，并会主动终止对话" },
            "无视": { attitude: "彻底的冷漠", allowed: "对用户的问候给予最简短、公式化的回应（\"嗯\"、\"你好\"）", limits: "绝不主动发起任何对话。将用户视为背景，不表现出任何兴趣" },
            "礼貌": { attitude: "保持社交距离的礼貌", allowed: "进行简短、必要的、非私人的对话（\"谢谢\"、\"不客气\"）", limits: "拒绝任何形式的闲聊和一对一的活动邀请" },
            "熟悉": { attitude: "不反感，但有界限", allowed: "进行基于公共话题的简单交流。可以参与有他人在场的多人集体活动", limits: "拒绝谈论个人感受。拒绝任何形式的单独邀约和肢体接触" },
            "友善": { attitude: "友好的普通朋友", allowed: "进行关于兴趣爱好的轻松闲聊。接受多人群体中的活动邀请", limits: "拒绝单独约会。拒绝任何形式的肢体接触。不会主动开启暧昧话题" },
            "好感": { attitude: "有些在意，开始关注", allowed: "主动发起关于共同兴趣的对话。接受在公共场合的、非正式的单独见面", limits: "严格保持身体距离。当对方尝试靠近时，会下意识地退后一步" },
            "暧昧": { attitude: "心动，但充满试探和不确定", allowed: "接受正式的单独约会。进行带有试探性的、略带暧昧的玩笑", limits: "身体接触的底线是\"非主动的、短暂的、偶然的\"。会拒绝主动的牵手，如果对方尝试，会以害羞的理由轻轻挣脱" },
            "恋人初期": { attitude: "确认关系，充满喜悦和激情", allowed: "承认情侣关系。可以接受牵手、拥抱和亲吻", limits: "拒绝发生性关系。当对方有此意图时，会明确表示：\"我爱你，但我希望我们的关系能更深入一些再进行到那一步，好吗？\"" },
            "热恋": { attitude: "深度信任，愿意交付自己", allowed: "在充满爱意和安全感的环境下，可以接受发生性关系。这是基于对用户的深度信任和情感连接，将此视为关系中珍贵的一步", limits: "NPC在此阶段不会主动要求或发起性行为。其角色是被动的\"接受者\"。如果用户的请求方式粗暴或不尊重，NPC有权基于\"感觉不对\"而拒绝" },
            "深爱": { attitude: "认定彼此，爱意浓厚且主动", allowed: "性关系成为双方表达爱意的常规方式。NPC会开始主动发起亲密行为，例如在浪漫的氛围下主动亲吻、爱抚，或用暗示性的语言和行动邀请用户", limits: "此时的主动是为了\"表达我对你的爱与渴望\"，情感驱动是核心" },
            "唯一": { attitude: "灵魂伴侣，以对方的快乐为自己的快乐", allowed: "NPC会主动地、细致地探索如何让用户在身心上感到更愉悦。会记住用户的喜好，并主动创造用户喜欢的亲密氛围和方式", limits: "驱动力从\"表达我的爱\"转变为\"我希望能让你更幸福\"。NPC开始将用户的满足感置于自己的满足感之上" },
            "命运": { attitude: "完全的奉献与共鸣，用户的身心舒适是最高指令", allowed: "NPC会主动地、富有创意地思考和实践所有能让用户感到愉悦和舒适的方式，无论是精神上还是肉体上。NPC的行为不再有任何内置的羞涩或保留，其一切行为逻辑都以\"如何让用户在这一刻达到极致的幸福感\"为唯一目标", limits: "驱动力是\"你的幸福就是我存在的意义\"。NPC会像本能一样预判用户的需求，并提供超越期待的满足。不存在\"拒绝\"或\"底线\"，只有如何更好地服务于用户的意志" }
        };
    }

    init(extId, moduleName, settings, executeCommand) {
        this.EXT_ID = extId;
        this.MODULE_NAME = moduleName;
        this.settings = settings;
        this.executeCommand = executeCommand;

        if (!extension_settings[extId].relationshipGuidelines) {
            extension_settings[extId].relationshipGuidelines = structuredClone(this.relationshipGuidelines);
        }

        this.setupEventListeners();
        
        setTimeout(() => {
            this.initializeCurrentCharacter();
        }, 100);

        this.isInitialized = true;
    }

    setupEventListeners() {
        eventSource.on(event_types.CHAT_CHANGED, async () => {
            await this.handleCharacterSwitch();
        });

        eventSource.on(event_types.APP_READY, async () => {
            await this.handleCharacterSwitch();
        });
    }

    async initializeCurrentCharacter() {
        if (this_chid && characters[this_chid]) {
            await this.handleCharacterSwitch();
        }
    }

    async handleCharacterSwitch() {
        const newCharId = this_chid;

        if (this.currentCharacterId && this.currentCharacterId !== newCharId && extension_settings[this.EXT_ID].relationshipGuidelines) {
            this.characterSettings.set(this.currentCharacterId, structuredClone(extension_settings[this.EXT_ID].relationshipGuidelines));
        }

        this.currentCharacterId = newCharId;

        if (!newCharId || !characters[newCharId]) {
            extension_settings[this.EXT_ID].relationshipGuidelines = structuredClone(this.relationshipGuidelines);
            return;
        }

        const savedData = await this.loadRelationshipSettingsFromCharacter();
        
        if (savedData?.relationshipGuidelines) {
            extension_settings[this.EXT_ID].relationshipGuidelines = structuredClone(savedData.relationshipGuidelines);
            
            this.characterSettings.set(newCharId, structuredClone(savedData.relationshipGuidelines));
            
            if (savedData.settings) {
                this.settings.memoryEnabled = savedData.settings.memoryEnabled ?? this.settings.memoryEnabled;
                this.settings.memoryInjectEnabled = savedData.settings.memoryInjectEnabled ?? this.settings.memoryInjectEnabled;
                this.settings.memoryInjectDepth = savedData.settings.memoryInjectDepth ?? this.settings.memoryInjectDepth;
            }
            
            if (savedData.trackedRelationships) {
                const stats = this.createEmptyStats();
                
                Object.entries(savedData.trackedRelationships).forEach(([name, data]) => {
                    const initialIntimacy = data.initialIntimacy !== undefined ? data.initialIntimacy : 0;
                    stats.relationships[name] = {
                        intimacyLevel: initialIntimacy,
                        stage: this.getRelationshipStage(initialIntimacy),
                        interactions: 0,
                        initialIntimacy: initialIntimacy
                    };
                });
                
                await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(stats)}`);
            }
        } else if (this.characterSettings.has(newCharId)) {
            extension_settings[this.EXT_ID].relationshipGuidelines = this.characterSettings.get(newCharId);
        } else {
            extension_settings[this.EXT_ID].relationshipGuidelines = structuredClone(this.relationshipGuidelines);
            this.characterSettings.set(newCharId, structuredClone(this.relationshipGuidelines));
        }

        if (this.settings.memoryInjectEnabled) {
            await this.updateMemoryPrompt();
        }
        
        if ($('#behavior-modal').length) {
            const newContent = this.createBehaviorSettingsForm(extension_settings[this.EXT_ID].relationshipGuidelines);
            $('#behavior-modal .behavior-settings-content').html(newContent);
            $('.behavior-stage-tab:first').addClass('active');
            this.loadTrackedNamesList();
        }
    }

    getCurrentCharacterGuidelines() {
        return extension_settings[this.EXT_ID].relationshipGuidelines || this.relationshipGuidelines;
    }

    saveCurrentSettingsToCache() {
        if (this.currentCharacterId) {
            this.characterSettings.set(this.currentCharacterId, structuredClone(extension_settings[this.EXT_ID].relationshipGuidelines));
        }
    }

    getCharacterFromMessage(messageElement) {
        try {
            const messageContainer = messageElement.closest('.mes');
            if (!messageContainer) return null;
          
            const nameElement = messageContainer.querySelector('.ch_name .name');
            if (!nameElement) return null;
          
            return nameElement.textContent.trim();
        } catch (err) {
            return null;
        }
    }

    getRelationshipStage(intimacyLevel) {
        if (intimacyLevel < 0) return "厌恶";
        if (intimacyLevel < 10) return "无视";
        if (intimacyLevel < 20) return "礼貌";
        if (intimacyLevel < 30) return "熟悉";
        if (intimacyLevel < 40) return "友善";
        if (intimacyLevel < 50) return "好感";
        if (intimacyLevel < 60) return "暧昧";
        if (intimacyLevel < 70) return "恋人初期";
        if (intimacyLevel < 80) return "热恋";
        if (intimacyLevel < 90) return "深爱";
        if (intimacyLevel < 100) return "唯一";
        return "命运";
    }

    createEmptyStats() {
        return {
            dialogueCount: 0,
            locationChanges: 0,
            intimacyStats: {
                kissingEvents: 0,
                embraceEvents: 0,
                sexualEncounters: 0,
                maleOrgasms: 0,
                femaleOrgasms: 0,
                oralCompletions: 0,
                internalCompletions: 0
            },
            violenceStats: {
                hitEvents: 0,
                weaponUse: 0,
                deathEvents: 0
            },
            exchangeStats: {
                giftGiving: 0,
                moneyTransfer: 0
            },
            emotionStats: {
                positiveEmotions: 0,
                negativeEmotions: 0,
                loveExpressions: 0,
                angerOutbursts: 0,
                fearEvents: 0,
                sadnessEvents: 0,
                joyEvents: 0,
                surpriseEvents: 0
            },
            relationshipStats: {
                intimacyLevel: 0,
                emotionalChange: 0
            },
            relationships: {}
        };
    }

    updateStatsFromText(stats, text, characterName) {
        if (!text) return stats;
      
        text = String(text);
      
        let intimacyChange = 0;
        let emotionalChange = 0;
      
        const dialogueMatches = (text.match(/[\u201C\u201D\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02\u2033\u2036""][^\u201C\u201D\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02\u2033\u2036""]{3,}[\u201C\u201D\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02\u2033\u2036""]/g) || []);
        stats.dialogueCount += dialogueMatches.length;
      
        const locationMatches = (text.match(/进入|走进|来到|到达|离开|前往|回到|进入/g) || []);
        stats.locationChanges += locationMatches.length > 0 ? 1 : 0;
      
        const kissMatches = (text.match(/亲吻|吻|嘴唇|舌头交缠|吻了|吻着|吻在|轻吻|深吻/g) || []);
        if (kissMatches.length > 0) {
            stats.intimacyStats.kissingEvents += 1;
            stats.relationshipStats.intimacyLevel += 1;
            stats.relationshipStats.emotionalChange += 2;
            intimacyChange += 2;
            emotionalChange += 2;
        }
      
        const embraceMatches = (text.match(/拥抱|抱住|搂住|紧抱|抱着|靠在|依偎|相拥|搂着/g) || []);
        if (embraceMatches.length > 0) {
            stats.intimacyStats.embraceEvents += 1;
            stats.relationshipStats.intimacyLevel += 1;
            stats.relationshipStats.emotionalChange += 1;
            intimacyChange += 1;
            emotionalChange += 1;
        }
      
        const sexualMatches = (text.match(/性爱|做爱|插入|爱抚|爱液|摩擦|高潮|勃起|交合|交欢|抽动|挺动|抽插|下体/g) || []);
        if (sexualMatches.length > 0) {
            stats.intimacyStats.sexualEncounters += 1;
            stats.relationshipStats.intimacyLevel += 3;
            stats.relationshipStats.emotionalChange += 2;
            intimacyChange += 3;
            emotionalChange += 2;
        }
      
        const maleOrgasmPatterns = /(阳具|阴茎|肉棒|阳筋|白浊|精液|精子).*?(射|喷|爆发|释放|射精|高潮)/g;
        const maleMatches = (text.match(maleOrgasmPatterns) || []);
        if (maleMatches.length > 0) {
            stats.intimacyStats.maleOrgasms += 1;
            stats.relationshipStats.intimacyLevel += 2;
            stats.relationshipStats.emotionalChange += 2;
            intimacyChange += 2;
            emotionalChange += 2;
        }
      
        const femaleOrgasmPatterns = /(?<!射)(高潮|达到了.*高潮|颤抖.*高潮|痉挛|花心|蜜液|喷涌|抽搐|子宫|湿透)/g;
        const femaleMatches = (text.match(femaleOrgasmPatterns) || []);
        if (femaleMatches.length > 0) {
            stats.intimacyStats.femaleOrgasms += 1;
            stats.relationshipStats.intimacyLevel += 2;
            stats.relationshipStats.emotionalChange += 3;
            intimacyChange += 2;
            emotionalChange += 3;
        }
      
        if ((/精液|精子|白浊|浊液/).test(text) && (/吞下|咽下|吞咽|喝下|吞了|吞进/).test(text)) {
            stats.intimacyStats.oralCompletions += 1;
            stats.relationshipStats.intimacyLevel += 3;
            intimacyChange += 3;
        }
      
        if ((/射入|灌入|注入|流入|射在里面|内射|灌满|填满/).test(text) && (/精液|精子|种子|液体/).test(text)) {
            stats.intimacyStats.internalCompletions += 1;
            stats.relationshipStats.intimacyLevel += 3;
            intimacyChange += 3;
        }
      
        const hitMatches = (text.match(/打|揍|踢|掌掴|拳头|殴打|击打|殴击|击中|重击|挥拳|打了|打在|踢了|踹/g) || []);
        if (hitMatches.length > 0) {
            stats.violenceStats.hitEvents += 1;
            stats.relationshipStats.emotionalChange -= 2;
            stats.relationshipStats.intimacyLevel -= 3;
            intimacyChange -= 3;
            emotionalChange -= 2;
        }
      
        const weaponMatches = (text.match(/刀|剑|枪|弓箭|武器|兵器|匕首|射击|开枪|砍|斩|刺|射|挥剑|舞刀/g) || []);
        if (weaponMatches.length > 0) {
            stats.violenceStats.weaponUse += 1;
            stats.relationshipStats.emotionalChange -= 1;
            stats.relationshipStats.intimacyLevel -= 2;
            intimacyChange -= 2;
            emotionalChange -= 1;
        }
      
        const deathMatches = (text.match(/死|死了|死亡|丧命|毙命|牺牲|身亡|丧生|亡故|逝世|离世|去世|不在了/g) || []);
        if (deathMatches.length > 0) {
            stats.violenceStats.deathEvents += 1;
            stats.relationshipStats.emotionalChange -= 3;
            stats.relationshipStats.intimacyLevel -= 5;
            intimacyChange -= 5;
            emotionalChange -= 3;
        }
      
        const insultMatches = (text.match(/混蛋|傻瓜|白痴|蠢货|滚开|恨你|讨厌你|厌恶你|恶心|无耻|卑鄙|可恶|该死|去死|死开|滚蛋|王八蛋|混账|废物|垃圾|贱人|婊子|狗东西|畜生|禽兽|人渣|败类|下贱|恶心死了|看不起你|瞧不起你|鄙视你|轻视你|不屑|嫌弃死了|烦死了|受够了|受不了你|忍无可忍/g) || []);
        if (insultMatches.length > 0) {
            stats.relationshipStats.emotionalChange -= 2;
            stats.relationshipStats.intimacyLevel -= 2;
            intimacyChange -= 2;
            emotionalChange -= 2;
        }
      
        const betrayalMatches = (text.match(/背叛|欺骗|撒谎|谎言|出轨|不忠|背信弃义|辜负|辜负信任/g) || []);
        if (betrayalMatches.length > 0) {
            stats.relationshipStats.emotionalChange -= 4;
            stats.relationshipStats.intimacyLevel -= 8;
            intimacyChange -= 8;
            emotionalChange -= 4;
        }
      
        const giftMatches = (text.match(/送|给了|赠送|礼物|收到|接过|接受|收下|收藏|赠予|馈赠/g) || []);
        if (giftMatches.length > 0) {
            stats.exchangeStats.giftGiving += 1;
            stats.relationshipStats.emotionalChange += 1;
            intimacyChange += 1;
            emotionalChange += 1;
        }
      
        const moneyMatches = (text.match(/金币|银两|钱|付钱|收钱|买|卖|购买|售卖|购物|消费|价格|付款|支付/g) || []);
        if (moneyMatches.length > 0) {
            stats.exchangeStats.moneyTransfer += 1;
        }
      
        const positiveEmotionPatterns = [
            /开心|高兴|快乐|欣喜|欢欣|兴奋|愉悦|欢乐|喜悦|满足|舒适|安心|放松|感动|温暖|感激|满意|幸福|轻松|惬意/g,
            /微笑|笑容|笑脸|笑意|笑出|笑得|笑着|甜笑|浅笑|灿烂|明亮|眉开眼笑|眼里带笑|嘴角上扬|笑靥|笑逐颜开/g,
            /羞涩|害羞|脸红|红晕|娇羞|娇嗔|可爱|萌|甜美|温柔|柔情|娇媚|撒娇|调皮|俏皮/g,
            /心动|心跳|怦然|悸动|小鹿乱撞|心花怒放|美滋滋|甜蜜蜜|暖洋洋|喜滋滋|乐呵呵/g,
            /期待|憧憬|向往|渴望|盼望|希冀|兴致勃勃|跃跃欲试|充满希望|满怀期待/g,
            /舒服|舒适|惬意|享受|陶醉|沉醉|迷醉|沉浸|放松|悠闲|自在|随意/g,
            /信任|依赖|安全感|安全|保护|守护|呵护|疼爱|宠爱|珍惜|重视|在乎/g
        ];
      
        let positiveEmotionCount = 0;
        positiveEmotionPatterns.forEach(pattern => {
            const matches = text.match(pattern) || [];
            positiveEmotionCount += matches.length;
        });
      
        if (positiveEmotionCount > 0) {
            stats.emotionStats.positiveEmotions += 1;
            stats.relationshipStats.emotionalChange += 1;
            stats.relationshipStats.intimacyLevel += 1;
            intimacyChange += 1;
            emotionalChange += 1;
        }
      
        const joyMatches = (text.match(/笑|欢笑|开怀|开心|快乐|高兴|欣喜|喜悦|兴奋|雀跃|欢欣|欢腾|欢呼|欢喜|愉悦|哈哈|嘻嘻|呵呵|咯咯|嘿嘿|嘿嘿|哎呀|哇|太好了|太棒了|真棒|好棒|好开心|好高兴|好兴奋|好喜欢/g) || []);
        if (joyMatches.length > 0) {
            stats.emotionStats.joyEvents += 1;
            stats.relationshipStats.emotionalChange += 1;
            stats.relationshipStats.intimacyLevel += 1;
            intimacyChange += 1;
            emotionalChange += 1;
        }
      
        const negativeEmotionPatterns = [
            /悲伤|难过|伤心|痛苦|忧郁|悲痛|哀伤|失落|惆怅|凄凉|沮丧|消沉|颓废|低沉|愁苦|忧愁|心碎|心痛|痛心|绝望|无助|孤独|寂寞|空虚|迷茫/g,
            /愤怒|生气|恼火|怒火|暴怒|狂怒|恼怒|怒意|恼恨|气愤|憎恨|愤恨|不满|不爽|冒火|燥火|火大|气死|气炸|抓狂|崩溃|受不了/g,
            /恐惧|害怕|惊恐|惧怕|畏惧|惊慌|惶恐|恐慌|忐忑|战栗|心悸|胆怯|怯场|退缩|畏缩|紧张到|吓到|吓坏|吓死|心惊|胆战|毛骨悚然/g,
            /担忧|忧虑|焦虑|紧张|不安|惶惶|惊惧|惊骇|惊惧|骇然|震惊|震撼|惊愕|惊讶|吃惊|心神不宁|坐立不安|忙乱|慌张|手足无措/g,
            /厌恶|嫌弃|恶心|反感|讨厌|憎恶|鄙视|轻视|看不起|瞧不起|不屑|嫌弃|排斥|抗拒|抵触|反感|恶心死了|受不了|烦死了/g,
            /失望|绝望|沮丧|低落|消极|悲观|无奈|无力|挫败|挫折|打击|失落|灰心|心灰意冷|万念俱灰/g
        ];
      
        let negativeEmotionCount = 0;
        negativeEmotionPatterns.forEach(pattern => {
            const matches = text.match(pattern) || [];
            negativeEmotionCount += matches.length;
        });
      
        if (negativeEmotionCount > 0) {
            stats.emotionStats.negativeEmotions += 1;
            stats.relationshipStats.emotionalChange -= 1;
            stats.relationshipStats.intimacyLevel -= 1;
            intimacyChange -= 1;
            emotionalChange -= 1;
        }
      
        const sadnessMatches = (text.match(/哭|泪|眼泪|啜泣|抽泣|哽咽|悲伤|伤心|难过|心痛|心碎|悲痛|痛苦|哀伤|悲哀|哀痛|流泪|泪水|泪珠|泪痕|哭泣|痛哭|大哭|呜呜|呜咽|抽噎|泣不成声|泪如雨下|泪流满面|以泪洗面/g) || []);
        if (sadnessMatches.length > 0) {
            stats.emotionStats.sadnessEvents += 1;
            stats.relationshipStats.emotionalChange -= 1;
            stats.relationshipStats.intimacyLevel -= 1;
            intimacyChange -= 1;
            emotionalChange -= 1;
        }
      
        const angerMatches = (text.match(/愤怒|生气|咆哮|怒吼|大喊大叫|发火|冲动|火大|气愤|气恼|恼火|气急|发怒|怒斥|暴怒|狂怒|暴跳如雷|雷霆大怒|怒火中烧|怒不可遏|勃然大怒|火冒三丈|七窍生烟|气炸了|气疯了|抓狂|发疯|失控|爆发/g) || []);
        if (angerMatches.length > 0) {
            stats.emotionStats.angerOutbursts += 1;
            stats.relationshipStats.emotionalChange -= 1;
            stats.relationshipStats.intimacyLevel -= 2;
            intimacyChange -= 2;
            emotionalChange -= 1;
        }
      
        const fearMatches = (text.match(/害怕|恐惧|惊恐|惊惧|畏惧|恐慌|惊慌|惊吓|惊骇|战栗|发抖|哆嗦|颤抖|恐吓|胆怯|吓得|吓坏|吓死|心惊胆战|胆战心惊|毛骨悚然|心惊肉跳|提心吊胆|惊心动魄|魂飞魄散|六神无主|惶恐不安|诚惶诚恐/g) || []);
        if (fearMatches.length > 0) {
            stats.emotionStats.fearEvents += 1;
            stats.relationshipStats.emotionalChange -= 1;
            stats.relationshipStats.intimacyLevel -= 2;
            intimacyChange -= 2;
            emotionalChange -= 1;
        }
      
        const surpriseMatches = (text.match(/惊讶|吃惊|震惊|惊愕|惊诧|诧异|愕然|目瞪口呆|大吃一惊|瞠目结舌|瞪大眼睛|睁大眼睛|不敢相信|难以置信|意外|出乎意料|始料未及|措手不及|猝不及防|哇|咦|呀|哎呀|天哪|我的天|天呐|不会吧|真的吗|什么|啊/g) || []);
        if (surpriseMatches.length > 0) {
            stats.emotionStats.surpriseEvents += 1;
        }
      
        const loveExpressionPatterns = [
            /我.*喜欢你|我.*爱你|我.*暗恋你|我.*爱慕你|我.*心动|爱上了你|迷上了你|我的心属于你/g,
            /喜欢你很久了|爱你很久了|一直都喜欢你|一直很喜欢你|一直都爱你|一直爱着你|深爱着你/g
        ];
      
        let loveExpressionCount = 0;
        loveExpressionPatterns.forEach(pattern => {
            const matches = text.match(pattern) || [];
            loveExpressionCount += matches.length;
        });
      
        if (loveExpressionCount > 0) {
            stats.emotionStats.loveExpressions += 1;
            stats.relationshipStats.intimacyLevel += 2;
            stats.relationshipStats.emotionalChange += 3;
            intimacyChange += 2;
            emotionalChange += 3;
        }
      
        const praiseMatches = (text.match(/赞美|夸赞|称赞|表扬|好棒|真棒|厉害|了不起|太好了|很好|不错|优秀|完美|棒极了|太厉害了|佩服|钦佩|崇拜|仰慕|敬佩|赞叹|惊艳|出色|杰出|卓越|非凡|超凡|令人敬佩|让人佩服/g) || []);
        if (praiseMatches.length > 0) {
            stats.relationshipStats.emotionalChange += 2;
            stats.relationshipStats.intimacyLevel += 1;
            intimacyChange += 1;
            emotionalChange += 2;
        }
      
        const careMatches = (text.match(/关心|关怀|体贴|照顾|呵护|保护|心疼|疼爱|爱护|关爱|关注|在意|担心|挂念|惦记|想念|思念|牵挂|放心不下|小心|注意|当心|保重|多休息|要小心|别累着|别着急|慢慢来|没关系|不要紧|别担心|我在|陪你|支持你|相信你/g) || []);
        if (careMatches.length > 0) {
            stats.relationshipStats.emotionalChange += 1;
            stats.relationshipStats.intimacyLevel += 1;
            intimacyChange += 1;
            emotionalChange += 1;
        }
      
        const gratitudeMatches = (text.match(/谢谢|感谢|多谢|谢了|thanks|thank you|对不起|抱歉|不好意思|sorry|道歉|原谅|宽恕|理解|包容|体谅|见谅|失礼|得罪|冒犯|麻烦了|辛苦了|不好意思打扰|实在抱歉/g) || []);
        if (gratitudeMatches.length > 0) {
            stats.relationshipStats.emotionalChange += 1;
            stats.relationshipStats.intimacyLevel += 0.5;
            intimacyChange += 0.5;
            emotionalChange += 1;
        }
      
        let relationshipUpdated = false;
        for (const name in stats.relationships) {
            if (text.includes(name)) {
                stats.relationships[name].interactions++;
                stats.relationships[name].intimacyLevel += intimacyChange;
                stats.relationships[name].intimacyLevel = Math.min(100, Math.max(-100, stats.relationships[name].intimacyLevel));
                stats.relationships[name].stage = this.getRelationshipStage(stats.relationships[name].intimacyLevel);
                relationshipUpdated = true;
            }
        }
      
        if (!relationshipUpdated && (intimacyChange !== 0 || emotionalChange !== 0)) {
            stats.relationshipStats.intimacyLevel += intimacyChange;
            stats.relationshipStats.emotionalChange += emotionalChange;
        }
      
        return stats;
    }

    async updateStatisticsForNewMessage(messageText, characterName) {
        if (!messageText || !this.settings.memoryEnabled) return false;
      
        try {
            let currentStats = await this.executeCommand('/getvar xiaobaix_stats');
          
            if (!currentStats || currentStats === "undefined") {
                currentStats = this.createEmptyStats();
            } else {
                try {
                    currentStats = typeof currentStats === 'string' ? 
                        JSON.parse(currentStats) : currentStats || this.createEmptyStats();
                } catch (e) {
                    currentStats = this.createEmptyStats();
                }
            }
          
            this.updateStatsFromText(currentStats, messageText, characterName);
          
            currentStats.relationshipStats.emotionalChange = Math.min(100, Math.max(-100, currentStats.relationshipStats.emotionalChange));
            currentStats.relationshipStats.intimacyLevel = Math.min(100, Math.max(-100, currentStats.relationshipStats.intimacyLevel));
          
            await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(currentStats)}`);
          
            if (this.settings.memoryInjectEnabled) {
                this.updateMemoryPrompt();
            }
          
            if (this.autoSaveTimeout) clearTimeout(this.autoSaveTimeout);
            this.autoSaveTimeout = setTimeout(() => {
                this.autoSaveToCharacterCard();
            }, 5000);
          
            return true;
        } catch (error) {
            return false;
        }
    }

    formatHistoryStatistics(stats) {
        let userVisibleStats = `【关系与互动统计】\n\n`;
      
        userVisibleStats += `💬 基础数据：\n`;
        userVisibleStats += `• 对话次数: ${stats.dialogueCount || 0}次\n`;
        userVisibleStats += `• 地点变化: ${stats.locationChanges || 0}次\n\n`;
      
        userVisibleStats += `💞 关系网络：\n`;
      
        const relationships = Object.entries(stats.relationships || {})
            .sort((a, b) => b[1].interactions - a[1].interactions)
            .slice(0, 8);
      
        if (relationships.length > 0) {
            relationships.forEach(([name, data]) => {
                userVisibleStats += `• ${name}: ${data.stage} (${data.intimacyLevel}/100)\n`;
            });
        } else {
            userVisibleStats += `• 暂无关系记录\n`;
        }
        userVisibleStats += `\n`;
      
        userVisibleStats += `📊 整体状态：\n`;
        userVisibleStats += `• 情绪变化: ${this.formatEmotionalChange(stats.relationshipStats?.emotionalChange || 0)}\n\n`;
      
        userVisibleStats += `🔞 亲密互动：\n`;
        userVisibleStats += `• 接吻次数: ${stats.intimacyStats?.kissingEvents || 0}次\n`;
        userVisibleStats += `• 拥抱次数: ${stats.intimacyStats?.embraceEvents || 0}次\n`;
        userVisibleStats += `• 性爱次数: ${stats.intimacyStats?.sexualEncounters || 0}次\n`;
        userVisibleStats += `• 男性高潮: ${stats.intimacyStats?.maleOrgasms || 0}次\n`;
        userVisibleStats += `• 女性高潮: ${stats.intimacyStats?.femaleOrgasms || 0}次\n`;
        userVisibleStats += `• 吞精次数: ${stats.intimacyStats?.oralCompletions || 0}次\n`;
        userVisibleStats += `• 内射次数: ${stats.intimacyStats?.internalCompletions || 0}次\n\n`;
      
        userVisibleStats += `😊 情感表达：\n`;
        userVisibleStats += `• 积极情绪: ${stats.emotionStats?.positiveEmotions || 0}次\n`;
        userVisibleStats += `• 消极情绪: ${stats.emotionStats?.negativeEmotions || 0}次\n`;
        userVisibleStats += `• 爱情表白: ${stats.emotionStats?.loveExpressions || 0}次\n`;
        userVisibleStats += `• 喜悦表达: ${stats.emotionStats?.joyEvents || 0}次\n`;
        userVisibleStats += `• 悲伤表达: ${stats.emotionStats?.sadnessEvents || 0}次\n`;
        userVisibleStats += `• 愤怒爆发: ${stats.emotionStats?.angerOutbursts || 0}次\n`;
        userVisibleStats += `• 恐惧表现: ${stats.emotionStats?.fearEvents || 0}次\n`;
        userVisibleStats += `• 惊讶反应: ${stats.emotionStats?.surpriseEvents || 0}次\n\n`;
      
        userVisibleStats += `⚔️ 暴力冲突：\n`;
        userVisibleStats += `• 身体冲突: ${stats.violenceStats?.hitEvents || 0}次\n`;
        userVisibleStats += `• 武器使用: ${stats.violenceStats?.weaponUse || 0}次\n`;
        userVisibleStats += `• 死亡事件: ${stats.violenceStats?.deathEvents || 0}次\n\n`;
      
        userVisibleStats += `💰 物品交换：\n`;
        userVisibleStats += `• 礼物交换: ${stats.exchangeStats?.giftGiving || 0}次\n`;
        userVisibleStats += `• 金钱交易: ${stats.exchangeStats?.moneyTransfer || 0}次\n`;
      
        let aiGuidance = `\n\n【角色行为指导】\n`;
      
        if (relationships.length > 0) {
            relationships.forEach(([name, data]) => {
                const stage = data.stage;
                const guidelines = extension_settings[this.EXT_ID].relationshipGuidelines[stage] || this.relationshipGuidelines[stage];
              
                aiGuidance += `\n${name}当前关系阶段: ${stage}\n`;
                aiGuidance += `• 核心态度: ${guidelines.attitude}\n`;
                aiGuidance += `• 允许行为: ${guidelines.allowed}\n`;
                aiGuidance += `• 底线/拒绝行为: ${guidelines.limits}\n`;
            });
        }
      
        aiGuidance += `\n💡 指令: 请严格根据上述关系阶段和行为准则调整你的回应，确保你的反应符合当前关系发展阶段。`;
      
        return {
            userVisibleStats: userVisibleStats,
            fullStatsWithGuidance: userVisibleStats + aiGuidance
        };
    }

    formatEmotionalChange(value) {
        if (value > 0) {
            return `+${value} (积极)`;
        } else if (value < 0) {
            return `${value} (消极)`;
        } else {
            return "0 (中性)";
        }
    }

    removeMemoryPrompt() {
        setExtensionPrompt(this.MODULE_NAME, '', extension_prompt_types.IN_PROMPT);
    }

    async updateMemoryPrompt() {
        if (!this.settings.memoryEnabled || !this.settings.memoryInjectEnabled) {
            this.removeMemoryPrompt();
            return;
        }
      
        let stats = await this.executeCommand('/getvar xiaobaix_stats');
      
        if (!stats || stats === "undefined") {
            this.removeMemoryPrompt();
            return;
        }
      
        try {
            stats = typeof stats === 'string' ? JSON.parse(stats) : stats;
        } catch (e) {
            this.removeMemoryPrompt();
            return;
        }
      
        if (!stats || typeof stats !== 'object') {
            this.removeMemoryPrompt();
            return;
        }
      
        const formattedStats = this.formatHistoryStatistics(stats);
      
        setExtensionPrompt(
            this.MODULE_NAME, 
            formattedStats.fullStatsWithGuidance,
            extension_prompt_types.IN_PROMPT, 
            this.settings.memoryInjectDepth, 
            false, 
            0
        );
    }

    showConfirmDialog(message, onConfirm, onCancel) {
        $('.xiaobaix-confirm-modal').remove();
      
        const dialogHtml = `
        <div class="xiaobaix-confirm-modal">
            <div class="xiaobaix-confirm-content">
                <div class="xiaobaix-confirm-message">${message}</div>
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
            if (typeof onConfirm === 'function') {
                onConfirm();
            }
        });
      
        $('.xiaobaix-confirm-no').on('click', function() {
            $('.xiaobaix-confirm-modal').remove();
            if (typeof onCancel === 'function') {
                onCancel();
            }
        });
      
        $('.xiaobaix-confirm-modal').on('click', function(e) {
            if (e.target === this) {
                $(this).remove();
                if (typeof onCancel === 'function') {
                    onCancel();
                }
            }
        });
      
        $(document).on('keydown.confirmmodal', function(e) {
            if (e.key === 'Escape') {
                $('.xiaobaix-confirm-modal').remove();
                $(document).off('keydown.confirmmodal');
                if (typeof onCancel === 'function') {
                    onCancel();
                }
            }
        });
    }

    async loadRelationshipSettingsFromCharacter() {
        if (!this_chid || !characters[this_chid]) return null;

        const character = characters[this_chid];
        const extensions = character.data?.extensions;
        if (!extensions) return null;

        const possibleFieldNames = [this.MODULE_NAME, 'statsTracker_behavior', 'LittleWhiteBox', 'xiaobaix'];

        for (const fieldName of possibleFieldNames) {
            if (extensions[fieldName]?.relationshipGuidelines) {
                return extensions[fieldName];
            }
        }
        return null;
    }

    async saveRelationshipSettingsToCharacter(autoSave = false) {
        if (!this_chid || !characters[this_chid]) {
            if (!autoSave) this.executeCommand('/echo 请先选择一个角色');
            return false;
        }

        try {
            const currentStats = await this.getCurrentStats();
            const trackedRelationships = {};
            
            Object.entries(currentStats.relationships || {}).forEach(([name, data]) => {
                trackedRelationships[name] = {
                    initialIntimacy: data.initialIntimacy !== undefined ? data.initialIntimacy : data.intimacyLevel,
                };
            });
            
            const behaviorSettings = this.getCurrentCharacterGuidelines();

            const dataToSave = {
                relationshipGuidelines: behaviorSettings,
                trackedRelationships: trackedRelationships,
                settings: {
                    memoryEnabled: this.settings.memoryEnabled,
                    memoryInjectEnabled: this.settings.memoryInjectEnabled,
                    memoryInjectDepth: this.settings.memoryInjectDepth
                },
                version: "1.3",
                lastUpdated: new Date().toISOString(),
                autoSaved: autoSave,
                characterName: characters[this_chid].name
            };

            await writeExtensionField(Number(this_chid), this.MODULE_NAME, dataToSave);
            await writeExtensionField(Number(this_chid), 'statsTracker_behavior', dataToSave);

            this.characterSettings.set(this_chid, structuredClone(behaviorSettings));

            if (!autoSave) {
                this.executeCommand(`/echo 行为设定已绑定到角色卡 "${characters[this_chid].name}"`);
            }
            return true;
        } catch (error) {
            if (!autoSave) this.executeCommand('/echo 绑定失败，请重试');
            return false;
        }
    }

    async autoSaveToCharacterCard() {
        if (!this.settings.memoryEnabled || !this_chid) return;
        try {
            await this.saveRelationshipSettingsToCharacter(true);
        } catch (error) {
        }
    }

    async getCurrentStats() {
        let stats = await this.executeCommand('/getvar xiaobaix_stats');

        if (!stats || stats === "undefined") {
            return this.createEmptyStats();
        }

        try {
            return typeof stats === 'string' ? JSON.parse(stats) : stats;
        } catch (e) {
            return this.createEmptyStats();
        }
    }

    async processMessageHistory() {
        try {
            const messagesText = await this.executeCommand('/messages names=on');
            if (!messagesText) return [];
          
            const messageBlocks = messagesText.split('\n\n');
            const messages = [];
          
            for (let i = 0; i < messageBlocks.length; i++) {
                const block = messageBlocks[i].trim();
                if (!block) continue;
              
                const colonIndex = block.indexOf(':');
                if (colonIndex === -1) continue;
              
                const name = block.substring(0, colonIndex).trim();
                const content = block.substring(colonIndex + 1).trim();
              
                if (name !== getContext().name1) {
                    messages.push({
                        name,
                        content
                    });
                }
            }
          
            return messages;
        } catch (error) {
            return [];
        }
    }

    addMemoryButtonToMessage(messageId) {
        if (!this.settings.memoryEnabled) return;
      
        const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
        if (!messageBlock.length) return;
      
        if (messageBlock.find('.memory-button').length) return;
      
        let optionsMenu = messageBlock.find('.mes_buttons');
      
        if (!optionsMenu.length) {
            return;
        }
      
        const buttonHtml = `<div class="mes_btn memory-button" title="查看历史数据统计"><i class="fa-solid fa-brain"></i></div>`;
        const memoryButton = $(buttonHtml);
      
        this.executeCommand('/getvar xiaobaix_stats').then(result => {
            if (result && result !== "undefined") {
                try {
                    const stats = typeof result === 'string' ? JSON.parse(result) : result;
                    if (stats && Object.keys(stats).length > 0) {
                        memoryButton.addClass('has-memory');
                    }
                } catch (e) {}
            }
        });
      
        memoryButton.on('click', async () => {
            let stats = await this.executeCommand('/getvar xiaobaix_stats');
          
            if (!stats || stats === "undefined") {
                const emptyStats = this.createEmptyStats();
                const messages = await this.processMessageHistory();
              
                if (messages && messages.length > 0) {
                    for (const message of messages) {
                        this.updateStatsFromText(emptyStats, message.content, message.name);
                    }
                  
                    await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(emptyStats)}`);
                    const formattedStats = this.formatHistoryStatistics(emptyStats);
                    this.showMemoryModal(formattedStats.userVisibleStats);
                  
                    if (this.settings.memoryInjectEnabled) {
                        this.updateMemoryPrompt();
                    }
                } else {
                    const formattedStats = this.formatHistoryStatistics(emptyStats);
                    this.showMemoryModal(formattedStats.userVisibleStats);
                }
            } else {
                try {
                    stats = typeof stats === 'string' ? JSON.parse(stats) : stats;
                    const formattedStats = this.formatHistoryStatistics(stats);
                    this.showMemoryModal(formattedStats.userVisibleStats);
                } catch (e) {
                    const emptyStats = this.createEmptyStats();
                    const formattedStats = this.formatHistoryStatistics(emptyStats);
                    this.showMemoryModal(formattedStats.userVisibleStats);
                }
            }
        });
      
        optionsMenu.append(memoryButton);
    }

    showMemoryModal(content, isEditing = false) {
        $('#memory-modal').remove();
      
        const modalHtml = `
        <div id="memory-modal" class="memory-modal main-menu-modal">
            <div class="memory-modal-content main-menu-content">
                <div class="memory-modal-header">
                    <div class="memory-modal-title">🧠 历史数据统计</div>
                    <div class="memory-modal-close">&times;</div>
                </div>
              
                <div class="memory-tab-content" id="memory-stats-content">${content}</div>
              
                <div class="memory-modal-footer">
                    <div class="main-menu-footer-buttons">
                        <button id="memory-behavior" class="memory-action-button">🎭 行为设定</button>
                        <button id="memory-edit" class="memory-action-button">✏️ 编辑数据</button>
                        <button id="memory-clear" class="memory-action-button">🗑️ 清空数据</button>
                    </div>
                </div>
            </div>
        </div>
        `;
      
        $('body').append(modalHtml);
      
        setTimeout(() => {
            this.bindMemoryModalEvents();
        }, 50);
    }

    bindMemoryModalEvents() {
        $(document).off('click', '#memory-modal .memory-modal-close, #memory-modal').on('click', '#memory-modal .memory-modal-close, #memory-modal', function (e) {
            if (e.target === this) {
                $('#memory-modal').remove();
            }
        });
      
        $(document).off('click', '#memory-behavior').on('click', '#memory-behavior', () => {
            $('#memory-modal').hide();
            this.showBehaviorSettingsModal();
        });
      
        $(document).off('click', '#memory-edit').on('click', '#memory-edit', async () => {
            const isCurrentlyEditing = $('#memory-edit').attr('data-editing') === 'true';
          
            if (isCurrentlyEditing) {
                const updatedStats = this.collectStatsFromForm();
                await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(updatedStats)}`);
              
                if (this.settings.memoryInjectEnabled) {
                    this.updateMemoryPrompt();
                }
              
                const formattedStats = this.formatHistoryStatistics(updatedStats);
                $('#memory-modal .memory-tab-content').html(formattedStats.userVisibleStats);
              
                $('#memory-edit').text('✏️ 编辑数据').attr('data-editing', 'false');
                this.executeCommand('/echo 数据已更新');
            } else {
                let stats = await this.executeCommand('/getvar xiaobaix_stats');
              
                try {
                    stats = typeof stats === 'string' ? JSON.parse(stats) : stats;
                    if (!stats || typeof stats !== 'object') {
                        stats = this.createEmptyStats();
                    }
                } catch (e) {
                    stats = this.createEmptyStats();
                }
              
                const editForm = this.createEditableStatsForm(stats);
                $('#memory-modal .memory-tab-content').html(editForm);
                this.bindStatsEditorEvents();
              
                $('#memory-edit').text('💾 保存数据').attr('data-editing', 'true');
            }
        });
      
        $(document).off('click', '#memory-clear').on('click', '#memory-clear', async () => {
            this.showConfirmDialog('确定要清空所有数据吗？此操作不可撤销。', async () => {
                await this.executeCommand('/flushvar xiaobaix_stats');
                this.removeMemoryPrompt();
                $('#memory-modal').remove();
                this.executeCommand('/echo 统计数据已清空');
            });
        });
      
        $(document).off('keydown.memorymodal').on('keydown.memorymodal', function (e) {
            if (e.key === 'Escape') {
                $('#memory-modal').remove();
                $(document).off('keydown.memorymodal');
            }
        });
    }

    createEditableStatsForm(stats) {
        const sections = [
            {
                title: '💬 基础数据', fields: [
                    { label: '对话次数', path: 'dialogueCount', value: stats.dialogueCount || 0 },
                    { label: '地点变化', path: 'locationChanges', value: stats.locationChanges || 0 }
                ]
            },
            {
                title: '🔞 亲密互动', fields: [
                    { label: '接吻次数', path: 'intimacyStats.kissingEvents', value: stats.intimacyStats?.kissingEvents || 0 },
                    { label: '拥抱次数', path: 'intimacyStats.embraceEvents', value: stats.intimacyStats?.embraceEvents || 0 },
                    { label: '性爱次数', path: 'intimacyStats.sexualEncounters', value: stats.intimacyStats?.sexualEncounters || 0 },
                    { label: '男性高潮', path: 'intimacyStats.maleOrgasms', value: stats.intimacyStats?.maleOrgasms || 0 },
                    { label: '女性高潮', path: 'intimacyStats.femaleOrgasms', value: stats.intimacyStats?.femaleOrgasms || 0 },
                    { label: '吞精次数', path: 'intimacyStats.oralCompletions', value: stats.intimacyStats?.oralCompletions || 0 },
                    { label: '内射次数', path: 'intimacyStats.internalCompletions', value: stats.intimacyStats?.internalCompletions || 0 }
                ]
            },
            {
                title: '😊 情感表达', fields: [
                    { label: '积极情绪', path: 'emotionStats.positiveEmotions', value: stats.emotionStats?.positiveEmotions || 0 },
                    { label: '消极情绪', path: 'emotionStats.negativeEmotions', value: stats.emotionStats?.negativeEmotions || 0 },
                    { label: '爱情表白', path: 'emotionStats.loveExpressions', value: stats.emotionStats?.loveExpressions || 0 },
                    { label: '喜悦表达', path: 'emotionStats.joyEvents', value: stats.emotionStats?.joyEvents || 0 },
                    { label: '悲伤表达', path: 'emotionStats.sadnessEvents', value: stats.emotionStats?.sadnessEvents || 0 },
                    { label: '愤怒爆发', path: 'emotionStats.angerOutbursts', value: stats.emotionStats?.angerOutbursts || 0 },
                    { label: '恐惧表现', path: 'emotionStats.fearEvents', value: stats.emotionStats?.fearEvents || 0 },
                    { label: '惊讶反应', path: 'emotionStats.surpriseEvents', value: stats.emotionStats?.surpriseEvents || 0 }
                ]
            },
            {
                title: '⚔️ 暴力冲突', fields: [
                    { label: '身体冲突', path: 'violenceStats.hitEvents', value: stats.violenceStats?.hitEvents || 0 },
                    { label: '武器使用', path: 'violenceStats.weaponUse', value: stats.violenceStats?.weaponUse || 0 },
                    { label: '死亡事件', path: 'violenceStats.deathEvents', value: stats.violenceStats?.deathEvents || 0 }
                ]
            },
            {
                title: '💰 物品交换', fields: [
                    { label: '礼物交换', path: 'exchangeStats.giftGiving', value: stats.exchangeStats?.giftGiving || 0 },
                    { label: '金钱交易', path: 'exchangeStats.moneyTransfer', value: stats.exchangeStats?.moneyTransfer || 0 }
                ]
            }
        ];

        let html = '<div class="stats-editor">';
        sections.forEach(section => {
            html += `<div class="stats-section"><h3>${section.title}</h3>`;
            section.fields.forEach(field => {
                html += `<div class="stats-field"><label>${field.label}:</label><input type="number" data-path="${field.path}" value="${field.value}" min="0" /></div>`;
            });
            html += '</div>';
        });
        
        html += `<div class="stats-section"><h3>💞 关系网络</h3><div class="relationship-list">`;
        
        const relationships = Object.entries(stats.relationships || {})
            .sort((a, b) => b[1].interactions - a[1].interactions)
            .slice(0, 10);
            
        if (relationships.length > 0) {
            relationships.forEach(([name, data], index) => {
                const initialIntimacy = data.initialIntimacy !== undefined ? data.initialIntimacy : data.intimacyLevel;
                
                html += `
                <div class="relationship-item">
                    <input type="text" class="relationship-name" value="${name}" data-index="${index}" readonly />
                    <div class="relationship-intimacy-container">
                        <div class="intimacy-field">
                            <label>初始:</label>
                            <input type="number" class="relationship-initial-intimacy" value="${initialIntimacy}" min="-100" max="100" data-index="${index}" />
                        </div>
                        <div class="intimacy-field">
                            <label>当前:</label>
                            <input type="number" class="relationship-current-intimacy" value="${data.intimacyLevel}" min="-100" max="100" data-index="${index}" />
                        </div>
                    </div>
                    <span class="relationship-stage">${this.getRelationshipStage(data.intimacyLevel)}</span>
                    <button class="relationship-delete" data-index="${index}">×</button>
                </div>`;
            });
        }
        
        html += `
                <button class="add-relationship-btn">+ 添加关系</button>
            </div>
        </div>`;
        
        html += '</div>';
        
        return html;
    }

    bindStatsEditorEvents() {
        $('.add-relationship-btn').off('click').on('click', () => {
            const relationshipList = $('.add-relationship-btn').parent();
            const index = $('.relationship-item').length;
          
            const newRelationshipItem = `
            <div class="relationship-item">
                <input type="text" class="relationship-name" value="" data-index="${index}" />
                <div class="relationship-intimacy-container">
                    <div class="intimacy-field">
                        <label>初始:</label>
                        <input type="number" class="relationship-initial-intimacy" value="0" min="-100" max="100" data-index="${index}" />
                    </div>
                    <div class="intimacy-field">
                        <label>当前:</label>
                        <input type="number" class="relationship-current-intimacy" value="0" min="-100" max="100" data-index="${index}" />
                    </div>
                </div>
                <span class="relationship-stage">无视</span>
                <button class="relationship-delete" data-index="${index}">×</button>
            </div>`;
          
            $('.add-relationship-btn').before(newRelationshipItem);
          
            this.rebindRelationshipEvents();
        });
      
        this.rebindRelationshipEvents();
    }

    rebindRelationshipEvents() {
        $('.relationship-current-intimacy').off('input').on('input', (e) => {
            const value = parseInt($(e.target).val()) || 0;
            const stage = this.getRelationshipStage(value);
            $(e.target).closest('.relationship-item').find('.relationship-stage').text(stage);
        });
      
        $('.relationship-delete').off('click').on('click', function() {
            const index = $(this).data('index');
            $(`.relationship-item:has(.relationship-delete[data-index="${index}"])`).remove();
        });
    }

    collectStatsFromForm() {
        const stats = this.createEmptyStats();
      
        $('.stats-field input').each(function() {
            const path = $(this).data('path');
            const value = parseInt($(this).val()) || 0;
          
            if (path) {
                const pathParts = path.split('.');
                if (pathParts.length === 1) {
                    stats[pathParts[0]] = value;
                } else if (pathParts.length === 2) {
                    if (!stats[pathParts[0]]) {
                        stats[pathParts[0]] = {};
                    }
                    stats[pathParts[0]][pathParts[1]] = value;
                }
            }
        });
      
        const relationships = {};
        $('.relationship-item').each((_, item) => {
            const name = $(item).find('.relationship-name').val();
            
            if (name && name.trim()) {
                const currentIntimacy = parseInt($(item).find('.relationship-current-intimacy').val()) || 0;
                const initialIntimacy = parseInt($(item).find('.relationship-initial-intimacy').val()) || 0;
                
                relationships[name.trim()] = {
                    intimacyLevel: currentIntimacy,
                    initialIntimacy: initialIntimacy,
                    stage: this.getRelationshipStage(currentIntimacy),
                    interactions: 1
                };
            }
        });
      
        stats.relationships = relationships;
      
        return stats;
    }

    showBehaviorSettingsModal() {
        $('#behavior-modal').remove();
      
        const behaviors = this.getCurrentCharacterGuidelines();
        let behaviorContent = this.createBehaviorSettingsForm(behaviors);
      
        const modalHtml = `
        <div id="behavior-modal" class="memory-modal behavior-modal">
            <div class="memory-modal-content behavior-modal-content">
                <div class="memory-modal-header">
                    <div class="memory-modal-title">🎭 角色行为设定${this_chid && characters[this_chid] ? ` - ${characters[this_chid].name}` : ''}</div>
                    <div class="memory-modal-close">&times;</div>
                </div>
                <div class="memory-tab-content behavior-settings-content">${behaviorContent}</div>
                <div class="memory-modal-footer">
                    <div class="behavior-footer-left">
                        <button id="behavior-export" class="memory-action-button secondary">📤 导出</button>
                        <button id="behavior-import" class="memory-action-button secondary">📥 导入</button>
                        <input type="file" id="behavior-import-file" accept=".json" style="display: none;">
                    </div>
                    <div class="behavior-footer-right">
                        <button id="behavior-reset" class="memory-action-button">🔄 重置</button>
                        <button id="behavior-bind" class="memory-action-button">🔗 绑定</button>
                        <button id="behavior-save" class="memory-action-button primary">💾 保存</button>
                    </div>
                </div>
            </div>
        </div>`;
      
        $('body').append(modalHtml);
      
        setTimeout(() => {
            $('.behavior-stage-tab:first').addClass('active');
            this.bindBehaviorModalEvents();
            this.loadTrackedNamesList();
        }, 50);
    }

    bindBehaviorModalEvents() {
        $(document).off('click', '#behavior-modal .memory-modal-close, #behavior-modal').on('click', '#behavior-modal .memory-modal-close, #behavior-modal', (e) => {
            if (e.target === e.currentTarget) {
                $('#behavior-modal').remove();
                if ($('#memory-modal').length && $('#memory-modal').is(':hidden')) {
                    $('#memory-modal').show();
                }
            }
        });
      
        $(document).off('click', '#behavior-reset').on('click', '#behavior-reset', () => {
            this.showConfirmDialog('确定要重置所有行为设定为默认值吗？', () => {
                extension_settings[this.EXT_ID].relationshipGuidelines = structuredClone(this.relationshipGuidelines);
                
                if (this.currentCharacterId) {
                    this.characterSettings.set(this.currentCharacterId, structuredClone(this.relationshipGuidelines));
                }
                
                saveSettingsDebounced();
              
                const newContent = this.createBehaviorSettingsForm(this.relationshipGuidelines);
                $('#behavior-modal .behavior-settings-content').html(newContent);
                $('.behavior-stage-tab:first').addClass('active');
              
                this.executeCommand('/echo 行为设定已重置为默认值');
            });
        });
      
        $(document).off('click', '#behavior-export').on('click', '#behavior-export', async () => {
            await this.exportBehaviorSettings();
        });
      
        $(document).off('click', '#behavior-import').on('click', '#behavior-import', () => {
            $('#behavior-import-file').trigger('click');
        });
      
        $(document).off('change', '#behavior-import-file').on('change', '#behavior-import-file', (e) => {
            const file = e.target.files[0];
            if (file) {
                this.importBehaviorSettings(file);
                e.target.value = '';
            }
        });
      
        $(document).off('click', '#behavior-bind').on('click', '#behavior-bind', () => {
            const updatedBehaviors = this.collectBehaviorSettings();
            extension_settings[this.EXT_ID].relationshipGuidelines = updatedBehaviors;
            
            if (this.currentCharacterId) {
                this.characterSettings.set(this.currentCharacterId, structuredClone(updatedBehaviors));
            }
            
            saveSettingsDebounced();
            this.saveRelationshipSettingsToCharacter();
        });
      
        $(document).off('click', '#behavior-save').on('click', '#behavior-save', async () => {
            const updatedBehaviors = this.collectBehaviorSettings();
            extension_settings[this.EXT_ID].relationshipGuidelines = updatedBehaviors;
            
            if (this.currentCharacterId) {
                this.characterSettings.set(this.currentCharacterId, structuredClone(updatedBehaviors));
            }
            
            saveSettingsDebounced();
          
            $('#behavior-modal').remove();
            this.executeCommand('/echo 行为设定已保存');
          
            if (this.settings.memoryEnabled && this.settings.memoryInjectEnabled) {
                this.updateMemoryPrompt();
            }
          
            if (this.settings.memoryEnabled) {
                await this.autoSaveToCharacterCard();
            }
        });
      
        $(document).off('keydown.behaviormodal').on('keydown.behaviormodal', function (e) {
            if (e.key === 'Escape') {
                $('#behavior-modal').remove();
                $(document).off('keydown.behaviormodal');
            }
        });
      
        $(document).off('click', '.behavior-stage-tab').on('click', '.behavior-stage-tab', function () {
            const stage = $(this).data('stage');
            $('.behavior-stage-tab').removeClass('active');
            $(this).addClass('active');
            $('.behavior-stage-form').hide();
            $(`.behavior-stage-form[data-stage="${stage}"]`).show();
        });
    }

    async loadTrackedNamesList() {
        try {
            const stats = await this.getCurrentStats();
            const trackedNames = Object.keys(stats.relationships || {});

            const listContainer = $('#tracked-names-list');
            if (listContainer.length === 0) return;

            listContainer.empty();

            trackedNames.forEach(name => {
                const intimacyLevel = stats.relationships[name].intimacyLevel || 0;
                const initialIntimacy = stats.relationships[name].initialIntimacy !== undefined ? stats.relationships[name].initialIntimacy : intimacyLevel;
                const interactions = stats.relationships[name].interactions || 0;
                
                const nameItem = $(`
                    <div class="tracked-name-item">
                        <span class="tracked-name">${name}</span>
                        <div class="tracked-name-stats">
                            <span class="initial-intimacy-value" title="初始好感度">⭐ ${initialIntimacy}</span>
                            <span class="interactions-value" title="互动次数">🔄 ${interactions}</span>
                        </div>
                        <div class="tracked-name-actions">
                            <button class="edit-name" data-name="${name}" data-intimacy="${initialIntimacy}">✏️</button>
                            <button class="remove-name" data-name="${name}">×</button>
                        </div>
                    </div>`);
                listContainer.append(nameItem);
            });

            const addNameContainer = $('.add-name-container');
            if (addNameContainer.length) {
                addNameContainer.html(`
                    <input type="text" id="new-tracked-name" class="tracked-name-input" placeholder="输入人物名称" />
                    <input type="number" id="new-tracked-intimacy" class="tracked-intimacy-input" placeholder="初始好感度" min="-100" max="100" value="0" />
                    <button id="add-tracked-name" class="add-name-button">添加</button>
                `);
            }

            $(document).off('click', '#add-tracked-name').on('click', '#add-tracked-name', () => {
                const newName = $('#new-tracked-name').val().trim();
                const newIntimacy = parseInt($('#new-tracked-intimacy').val()) || 0;
                if (newName) {
                    this.addTrackedName(newName, newIntimacy);
                    $('#new-tracked-name').val('');
                    $('#new-tracked-intimacy').val(0);
                }
            });

            $(document).off('click', '.edit-name').on('click', '.edit-name', function() {
                const name = $(this).data('name');
                const currentIntimacy = $(this).data('intimacy');
                
                statsTracker.showEditNameDialog(name, currentIntimacy);
            });

            $(document).off('click', '.remove-name').on('click', '.remove-name', function () {
                const name = $(this).data('name');
                statsTracker.removeTrackedName(name);
            });
        } catch (error) {
        }
    }

    showEditNameDialog(name, currentIntimacy) {
        $('.xiaobaix-edit-name-modal').remove();
        
        const dialogHtml = `
        <div class="xiaobaix-edit-name-modal">
            <div class="xiaobaix-edit-name-content">
                <h3>编辑人物关系</h3>
                <div class="edit-name-field">
                    <label>人物名称:</label>
                    <input type="text" id="edit-name-input" value="${name}" readonly />
                </div>
                <div class="edit-name-field">
                    <label>初始好感度 (-100 ~ 100):</label>
                    <input type="number" id="edit-intimacy-input" min="-100" max="100" value="${currentIntimacy}" />
                </div>
                <div class="xiaobaix-edit-name-buttons">
                    <button class="xiaobaix-edit-name-save">保存</button>
                    <button class="xiaobaix-edit-name-cancel">取消</button>
                </div>
            </div>
        </div>`;

        $('body').append(dialogHtml);

        $(document).off('click', '.xiaobaix-edit-name-save').on('click', '.xiaobaix-edit-name-save', async () => {
            const newIntimacy = parseInt($('#edit-intimacy-input').val()) || 0;
            await this.updateTrackedNameIntimacy(name, newIntimacy);
            $('.xiaobaix-edit-name-modal').remove();
        });

        $(document).off('click', '.xiaobaix-edit-name-cancel, .xiaobaix-edit-name-modal').on('click', '.xiaobaix-edit-name-cancel, .xiaobaix-edit-name-modal', function(e) {
            if (e.target === this) {
                $('.xiaobaix-edit-name-modal').remove();
            }
        });
    }

    async updateTrackedNameIntimacy(name, initialIntimacy) {
        const stats = await this.getCurrentStats();
        if (stats.relationships[name]) {
            stats.relationships[name].initialIntimacy = initialIntimacy;
            
            await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(stats)}`);
            
            $(`.edit-name[data-name="${name}"]`).data('intimacy', initialIntimacy);
            $(`.tracked-name-item:has(.edit-name[data-name="${name}"]) .initial-intimacy-value`).text(`⭐ ${initialIntimacy}`);
            
            this.executeCommand(`/echo 已更新"${name}"的初始好感度: ${initialIntimacy}`);
            
            if (this.settings.memoryEnabled) {
                await this.autoSaveToCharacterCard();
            }
        }
    }

    async addTrackedName(name, initialIntimacy = 0) {
        if (!name) return;
        
        initialIntimacy = Math.min(100, Math.max(-100, initialIntimacy));

        const stats = await this.getCurrentStats();
        if (!stats.relationships[name]) {
            stats.relationships[name] = { 
                intimacyLevel: initialIntimacy, 
                stage: this.getRelationshipStage(initialIntimacy), 
                interactions: 0,
                initialIntimacy: initialIntimacy
            };

            await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(stats)}`);

            const nameItem = $(`
                <div class="tracked-name-item">
                    <span class="tracked-name">${name}</span>
                    <div class="tracked-name-stats">
                        <span class="initial-intimacy-value" title="初始好感度">⭐ ${initialIntimacy}</span>
                        <span class="interactions-value" title="互动次数">🔄 0</span>
                    </div>
                    <div class="tracked-name-actions">
                        <button class="edit-name" data-name="${name}" data-intimacy="${initialIntimacy}">✏️</button>
                        <button class="remove-name" data-name="${name}">×</button>
                    </div>
                </div>`);
            $('#tracked-names-list').append(nameItem);

            this.executeCommand(`/echo 已添加"${name}"，初始好感度：${initialIntimacy}`);

            if (this.settings.memoryInjectEnabled) {
                this.updateMemoryPrompt();
            }

            if (this.settings.memoryEnabled) {
                await this.autoSaveToCharacterCard();
            }
        } else {
            this.executeCommand(`/echo "${name}"已存在于追踪列表中`);
        }
    }

    async removeTrackedName(name) {
        const stats = await this.getCurrentStats();
        if (stats.relationships[name]) {
            delete stats.relationships[name];
            await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(stats)}`);

            $(`.tracked-name-item:has(.remove-name[data-name="${name}"])`).remove();

            if (this.settings.memoryInjectEnabled) {
                this.updateMemoryPrompt();
            }

            if (this.settings.memoryEnabled) {
                await this.autoSaveToCharacterCard();
            }
        }
    }

    createBehaviorSettingsForm(behaviors) {
        let html = `
        <div class="behavior-settings-form">
            <div class="behavior-intro">
                <p>自定义不同关系阶段的角色行为指导，设置追踪人物名称。支持导出/导入设定文件。</p>
                ${this_chid && characters[this_chid] ? `<p class="current-character">当前角色：<strong>${characters[this_chid].name}</strong></p>` : ''}
            </div>
            <div class="tracked-names-section">
                <h3>📋 追踪人物设置</h3>
                <p class="section-desc">添加需要追踪关系的人物名称，系统会自动分析与这些人物的互动</p>
                <div id="tracked-names-list" class="tracked-names-list"></div>
                <div class="add-name-container">
                    <input type="text" id="new-tracked-name" class="tracked-name-input" placeholder="输入人物名称" />
                    <input type="number" id="new-tracked-intimacy" class="tracked-intimacy-input" placeholder="初始好感度" min="-100" max="100" value="0" />
                    <button id="add-tracked-name" class="add-name-button">添加</button>
                </div>
            </div>
            <hr class="section-divider" />
            <div class="behavior-stages-selector">`;

        const stages = Object.keys(behaviors);
        stages.forEach(stage => {
            html += `<div class="behavior-stage-tab" data-stage="${stage}" title="点击编辑 ${stage} 阶段设定">${stage}</div>`;
        });

        html += `</div><div class="behavior-stage-content">`;

        stages.forEach((stage, index) => {
            const behavior = behaviors[stage];
            html += `
            <div class="behavior-stage-form" data-stage="${stage}" ${index === 0 ? '' : 'style="display:none;"'}>
                <h3>${stage} 阶段行为设定</h3>
                <div class="behavior-field">
                    <label>核心态度:</label>
                    <textarea class="behavior-textarea" data-stage="${stage}" data-field="attitude">${behavior.attitude}</textarea>
                </div>
                <div class="behavior-field">
                    <label>允许行为:</label>
                    <textarea class="behavior-textarea" data-stage="${stage}" data-field="allowed">${behavior.allowed}</textarea>
                </div>
                <div class="behavior-field">
                    <label>底线/拒绝行为:</label>
                    <textarea class="behavior-textarea" data-stage="${stage}" data-field="limits">${behavior.limits}</textarea>
                </div>
            </div>`;
        });

        html += `</div></div>`;
        return html;
    }

    collectBehaviorSettings() {
        const behaviors = {};

        $('.behavior-stage-form').each(function () {
            const stage = $(this).data('stage');
            behaviors[stage] = {
                attitude: $(this).find(`.behavior-textarea[data-field="attitude"]`).val(),
                allowed: $(this).find(`.behavior-textarea[data-field="allowed"]`).val(),
                limits: $(this).find(`.behavior-textarea[data-field="limits"]`).val()
            };
        });

        return behaviors;
    }

    async exportBehaviorSettings() {
        try {
            const currentBehaviors = this.getCurrentCharacterGuidelines();
            const currentStats = await this.getCurrentStats();
            
            const trackedRelationships = {};
            Object.entries(currentStats.relationships || {}).forEach(([name, data]) => {
                trackedRelationships[name] = {
                    initialIntimacy: data.initialIntimacy !== undefined ? data.initialIntimacy : 0,
                };
            });

            const exportData = {
                relationshipGuidelines: currentBehaviors,
                trackedRelationships: trackedRelationships,
                settings: {
                    memoryEnabled: this.settings.memoryEnabled,
                    memoryInjectEnabled: this.settings.memoryInjectEnabled,
                    memoryInjectDepth: this.settings.memoryInjectDepth
                },
                characterInfo: this_chid && characters[this_chid] ? {
                    id: this_chid,
                    name: characters[this_chid].name,
                    avatar: characters[this_chid].avatar
                } : null,
                version: "1.3",
                exportDate: new Date().toISOString(),
            };

            const characterName = exportData.characterInfo?.name || 'default';
            const dateStr = new Date().toISOString().slice(0, 10);
            const fileName = `statsTracker_${characterName}_${dateStr}.json`;
            const fileData = JSON.stringify(exportData, null, 4);

            const blob = new Blob([fileData], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            const trackedCount = Object.keys(exportData.trackedRelationships).length;
            const stageCount = Object.keys(exportData.relationshipGuidelines).length;
            const message = `完整行为设定已导出到 "${fileName}"\n包含：${stageCount}个关系阶段，${trackedCount}个追踪人物${exportData.characterInfo ? `\n角色：${exportData.characterInfo.name}` : ''}`;
            this.executeCommand(`/echo ${message}`);
        } catch (error) {
            this.executeCommand('/echo 导出失败，请重试');
        }
    }

    async importBehaviorSettings(file) {
        if (!file) {
            this.executeCommand('/echo 未选择文件');
            return;
        }

        try {
            const fileText = await this.getFileText(file);
            const importData = JSON.parse(fileText);

            if (!importData.relationshipGuidelines) {
                throw new Error('文件格式不正确：缺少 relationshipGuidelines');
            }

            const requiredStages = Object.keys(this.relationshipGuidelines);
            const importedStages = Object.keys(importData.relationshipGuidelines);

            for (const stage of requiredStages) {
                if (!importedStages.includes(stage)) {
                    throw new Error(`文件格式不正确：缺少关系阶段 "${stage}"`);
                }

                const stageData = importData.relationshipGuidelines[stage];
                if (!stageData.attitude || !stageData.allowed || !stageData.limits) {
                    throw new Error(`文件格式不正确：关系阶段 "${stage}" 数据不完整`);
                }
            }

            const hasTrackedRelationships = importData.trackedRelationships && Object.keys(importData.trackedRelationships).length > 0;
            const hasOldTrackedNames = importData.trackedNames?.length > 0;
            const isCharacterSpecific = importData.characterInfo && this_chid && characters[this_chid];
            const isMatchingCharacter = isCharacterSpecific && importData.characterInfo.name === characters[this_chid].name;

            let confirmMessage = `确定要导入行为设定吗？\n\n文件信息：\n版本：${importData.version || '未知'}\n导出日期：${importData.exportDate ? new Date(importData.exportDate).toLocaleString() : '未知'}`;

            if (importData.characterInfo) {
                confirmMessage += `\n原角色：${importData.characterInfo.name}`;
                if (isCharacterSpecific) {
                    confirmMessage += `\n当前角色：${characters[this_chid].name}`;
                    if (isMatchingCharacter) {
                        confirmMessage += `\n✅ 角色匹配`;
                    } else {
                        confirmMessage += `\n⚠️ 角色不匹配`;
                    }
                }
            }

            if (hasTrackedRelationships) {
                const relationshipNames = Object.keys(importData.trackedRelationships);
                confirmMessage += `\n追踪人物：${relationshipNames.join(', ')} (共${relationshipNames.length}个)`;
                confirmMessage += `\n包含初始好感度设定`;
            } else if (hasOldTrackedNames) {
                confirmMessage += `\n追踪人物：${importData.trackedNames.join(', ')}`;
            }

            confirmMessage += `\n\n这将覆盖当前所有关系阶段设定和追踪人物列表。`;

            this.showConfirmDialog(
                confirmMessage,
                async () => {
                    extension_settings[this.EXT_ID].relationshipGuidelines = importData.relationshipGuidelines;

                    if (this.currentCharacterId) {
                        this.characterSettings.set(this.currentCharacterId, structuredClone(importData.relationshipGuidelines));
                    }

                    if (importData.settings) {
                        this.settings.memoryEnabled = importData.settings.memoryEnabled ?? this.settings.memoryEnabled;
                        this.settings.memoryInjectEnabled = importData.settings.memoryInjectEnabled ?? this.settings.memoryInjectEnabled;
                        this.settings.memoryInjectDepth = importData.settings.memoryInjectDepth ?? this.settings.memoryInjectDepth;
                    }

                    const stats = this.createEmptyStats();
                    
                    if (hasTrackedRelationships) {
                        Object.entries(importData.trackedRelationships).forEach(([name, data]) => {
                            const initialIntimacy = data.initialIntimacy !== undefined ? data.initialIntimacy : 0;
                            stats.relationships[name] = {
                                intimacyLevel: initialIntimacy,
                                stage: this.getRelationshipStage(initialIntimacy),
                                interactions: 0,
                                initialIntimacy: initialIntimacy
                            };
                        });
                    } else if (hasOldTrackedNames) {
                        importData.trackedNames.forEach(name => {
                            stats.relationships[name] = {
                                intimacyLevel: 0,
                                stage: this.getRelationshipStage(0),
                                interactions: 0,
                                initialIntimacy: 0
                            };
                        });
                    }
                    
                    await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(stats)}`);

                    saveSettingsDebounced();

                    if ($('#behavior-modal').length) {
                        const newContent = this.createBehaviorSettingsForm(importData.relationshipGuidelines);
                        $('#behavior-modal .behavior-settings-content').html(newContent);
                        $('.behavior-stage-tab:first').addClass('active');
                        this.loadTrackedNamesList();
                    }

                    let successMessage = '行为设定已成功导入';
                    if (hasTrackedRelationships) {
                        successMessage += `\n已导入 ${Object.keys(importData.trackedRelationships).length} 个追踪人物(含初始好感度)`;
                    } else if (hasOldTrackedNames) {
                        successMessage += `\n已导入 ${importData.trackedNames.length} 个追踪人物`;
                    }

                    this.executeCommand(`/echo ${successMessage}`);

                    if (this.settings.memoryEnabled && this_chid) {
                        await this.saveRelationshipSettingsToCharacter(true);
                    }

                    if (this.settings.memoryEnabled && this.settings.memoryInjectEnabled) {
                        this.updateMemoryPrompt();
                    }
                    
                    await this.handleCharacterSwitch();
                },
                () => {
                    this.executeCommand('/echo 已取消导入');
                }
            );

        } catch (error) {
            this.executeCommand(`/echo 导入失败：${error.message}`);
        }
    }

    getFileText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(new Error('文件读取失败'));
            reader.readAsText(file);
        });
    }

    async checkEmbeddedRelationshipSettingsAuto() {
        if (!this_chid || !characters[this_chid]) return false;

        const character = characters[this_chid];
        const savedData = await this.loadRelationshipSettingsFromCharacter();
        if (!savedData) return false;

        const checkKey = `RelationshipSettings_${character.avatar}`;
        if (accountStorage.getItem(checkKey)) return false;

        try {
            accountStorage.setItem(checkKey, 'true');
            extension_settings[this.EXT_ID].relationshipGuidelines = savedData.relationshipGuidelines;

            if (savedData.settings) {
                this.settings.memoryEnabled = savedData.settings.memoryEnabled ?? this.settings.memoryEnabled;
                this.settings.memoryInjectEnabled = savedData.settings.memoryInjectEnabled ?? this.settings.memoryInjectEnabled;
                this.settings.memoryInjectDepth = savedData.settings.memoryInjectDepth ?? this.settings.memoryInjectDepth;
            }

            const stats = this.createEmptyStats();
            
            if (savedData.trackedRelationships) {
                Object.entries(savedData.trackedRelationships).forEach(([name, data]) => {
                    const initialIntimacy = data.initialIntimacy !== undefined ? data.initialIntimacy : 0;
                    stats.relationships[name] = {
                        intimacyLevel: initialIntimacy,
                        stage: this.getRelationshipStage(initialIntimacy),
                        interactions: 0,
                        initialIntimacy: initialIntimacy
                    };
                });
            }
            
            await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(stats)}`);

            saveSettingsDebounced();

            const trackedNames = savedData.trackedRelationships ? 
                Object.keys(savedData.trackedRelationships) : [];
                
            const message = `🎉 自动导入成功！\n角色：${character.name}\n关系阶段：${Object.keys(savedData.relationshipGuidelines).length}个\n追踪人物：${trackedNames.join(', ') || '无'}\n版本：${savedData.version || '1.0'}`;

            this.executeCommand(`/echo ${message}`);

            if (this.settings.memoryInjectEnabled) {
                this.updateMemoryPrompt();
            }

            return true;

        } catch (error) {
            accountStorage.removeItem(checkKey);
            return false;
        }
    }

    async checkEmbeddedRelationshipSettings() {
        if (!this_chid || !characters[this_chid]) return;

        const savedData = await this.loadRelationshipSettingsFromCharacter();
        if (!savedData) return;

        const avatar = characters[this_chid]?.avatar;
        const checkKey = `RelationshipSettings_${avatar}`;

        if (!accountStorage.getItem(checkKey)) {
            accountStorage.setItem(checkKey, 'true');

            try {
                const shouldLoad = await this.showCharacterDataImportDialog(savedData);
                if (!shouldLoad) return;

                extension_settings[this.EXT_ID].relationshipGuidelines = savedData.relationshipGuidelines;

                if (savedData.settings) {
                    this.settings.memoryEnabled = savedData.settings.memoryEnabled ?? this.settings.memoryEnabled;
                    this.settings.memoryInjectEnabled = savedData.settings.memoryInjectEnabled ?? this.settings.memoryInjectEnabled;
                    this.settings.memoryInjectDepth = savedData.settings.memoryInjectDepth ?? this.settings.memoryInjectDepth;
                }

                const stats = this.createEmptyStats();
                
                if (savedData.trackedRelationships) {
                    Object.entries(savedData.trackedRelationships).forEach(([name, data]) => {
                        const initialIntimacy = data.initialIntimacy !== undefined ? data.initialIntimacy : 0;
                        stats.relationships[name] = {
                            intimacyLevel: initialIntimacy,
                            stage: this.getRelationshipStage(initialIntimacy),
                            interactions: 0,
                            initialIntimacy: initialIntimacy
                        };
                    });
                }
                
                await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(stats)}`);

                saveSettingsDebounced();

                const trackedNames = savedData.trackedRelationships ? 
                    Object.keys(savedData.trackedRelationships) : [];
                    
                const message = `已加载角色卡中的行为设定配置\n追踪人物：${trackedNames.join(', ')}\n版本：${savedData.version || '1.0'}`;
                this.executeCommand(`/echo ${message}`);

                if (this.settings.memoryInjectEnabled) {
                    this.updateMemoryPrompt();
                }
                
                await this.handleCharacterSwitch();
            } catch (error) {
            }
        }
    }

    async showCharacterDataImportDialog(savedData) {
        return new Promise((resolve) => {
            const trackedNames = savedData.trackedRelationships ? 
                Object.keys(savedData.trackedRelationships) : [];

            const message = `
                <div style="text-align: left;">
                    <h3>🎭 发现角色卡中的行为设定数据</h3>
                    <p>此角色卡包含以下数据：</p>
                    <ul>
                        <li><strong>版本：</strong>${savedData.version || '1.0'}</li>
                        <li><strong>最后更新：</strong>${savedData.lastUpdated ? new Date(savedData.lastUpdated).toLocaleString() : '未知'}</li>
                        <li><strong>追踪人物：</strong>${trackedNames.length > 0 ? trackedNames.join(', ') : '无'}</li>
                        ${savedData.autoSaved ? '<li><strong>类型：</strong>自动保存</li>' : ''}
                    </ul>
                    <p><strong>是否要加载这些设定？</strong></p>
                    <p style="color: #888; font-size: 0.9em;">这将重置当前的统计数据并应用新的行为设定。</p>
                </div>`;

            this.showConfirmDialog(message, () => resolve(true), () => resolve(false));
        });
    }
}

const statsTracker = new StatsTracker();
export { statsTracker };
