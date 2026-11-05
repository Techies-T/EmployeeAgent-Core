import React, { useState, useEffect } from 'react';
import GeneralTab from './SystemSettings/tabs/GeneralTab';
import SkillsTab from './SystemSettings/tabs/SkillsTab';
import SystemTab from './SystemSettings/tabs/SystemTab';
import PersonalRagTab from './SystemSettings/tabs/PersonalRagTab';
import DeepResearchTab from './SystemSettings/tabs/DeepResearchTab';
import McpConnectionsTab from './SystemSettings/tabs/McpConnectionsTab';
import ChatConfigTab from './SystemSettings/tabs/ChatConfigTab';
import UsersTab from './SystemSettings/tabs/UsersTab';
import RolesTab from './SystemSettings/tabs/RolesTab';
import SecurityLogsTab from './SystemSettings/tabs/SecurityLogsTab';
import PodsTab from './SystemSettings/tabs/PodsTab';
import WorkPolicyTab from './SystemSettings/tabs/WorkPolicyTab';
import FinderTab from './SystemSettings/tabs/FinderTab';
import AntigravityAgentTab from './SystemSettings/tabs/AntigravityAgentTab';
import LiveConciergeTab from './SystemSettings/tabs/LiveConciergeTab';
import AiHubTab from './SystemSettings/tabs/AiHubTab';
import WidgetStoreTab from './SystemSettings/tabs/WidgetStoreTab';
import ZtaPolicyMatrixTab from './SystemSettings/tabs/ZtaPolicyMatrixTab';
import pkg from '../../package.json';

const SystemSettings = ({ user }) => {
    const hasAction = (action) => {
        const allowed = user?.allowed_actions || [];
        return allowed.includes('*') || allowed.includes(action);
    };

    const hasWidget = (widget) => {
        const allowed = user?.allowed_widgets || [];
        return allowed.includes('*') || allowed.includes(widget);
    };

    const canManageSettings = hasAction('action:manage_system_settings');
    const canSelectModel = canManageSettings || hasAction('action:edit_workflow_model') || hasWidget('app:gemini');

    // 初期タブ: 全ユーザー共通で 'General' を初期選択
    const [activeTab, setActiveTab] = useState('General');
    const [models, setModels] = useState([]);
    const [claudeModels, setClaudeModels] = useState([]);
    const [aiProvider, setAiProvider] = useState('gemini');
    const [currentModel, setCurrentModel] = useState('');
    const [currentClaudeModel, setCurrentClaudeModel] = useState('claude-sonnet-4-6');
    const [currentNanoBananaModel, setCurrentNanoBananaModel] = useState('');
    const [currentResearchModel, setCurrentResearchModel] = useState('');
    const [currentHtmlSvgModel, setCurrentHtmlSvgModel] = useState('');
    const [companyWorkPolicy, setCompanyWorkPolicy] = useState('');
    
    // Antigravity Agent Settings States
    const [antigravityAgentModel, setAntigravityAgentModel] = useState('gemini-3.5-flash');
    const [antigravityAgentInstructions, setAntigravityAgentInstructions] = useState('');
    const [antigravityAgentSafetyPolicy, setAntigravityAgentSafetyPolicy] = useState('confirm_run_command');
    const [antigravityAgentExternalPolicyEnabled, setAntigravityAgentExternalPolicyEnabled] = useState(true);
    const [antigravityAgentMcpServers, setAntigravityAgentMcpServers] = useState('[]');
    const [driveRootId, setDriveRootId] = useState('');
    const [ragFolders, setRagFolders] = useState([]);
    const [newRagFolderId, setNewRagFolderId] = useState('');
    const [newRagFolderName, setNewRagFolderName] = useState('');
    const [researchFolderId, setResearchFolderId] = useState(''); // New state
    const [geminiApiKey, setGeminiApiKey] = useState('');
    const [claudeApiKey, setClaudeApiKey] = useState('');
    const [googleClientId, setGoogleClientId] = useState('');
    const [googleClientSecret, setGoogleClientSecret] = useState('');
    const [isConfigured, setIsConfigured] = useState(false);
    const [isGeminiConfigured, setIsGeminiConfigured] = useState(false);
    const [isClaudeConfigured, setIsClaudeConfigured] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncTarget, setSyncTarget] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [lastRagSyncTime, setLastRagSyncTime] = useState(null);
    const [lastRagSyncTimeGemini, setLastRagSyncTimeGemini] = useState(null);
    const [lastRagSyncTimeClaude, setLastRagSyncTimeClaude] = useState(null);
    const [nanoBananaPrompt, setNanoBananaPrompt] = useState(''); // New state for Nano Banana 2 prompt
    const [deepResearchPrompt, setDeepResearchPrompt] = useState('');
    const [htmlSvgPrompt, setHtmlSvgPrompt] = useState('');
    const [mcpServerEndpoint, setMcpServerEndpoint] = useState('');
    const [mcpTokenUrl, setMcpTokenUrl] = useState('');
    const [mcpClientId, setMcpClientId] = useState('');
    const [mcpClientSecret, setMcpClientSecret] = useState('');
    const [isMcpSecretConfigured, setIsMcpSecretConfigured] = useState(false);
    const [mcpQuickPrompts, setMcpQuickPrompts] = useState([]);
    const [currentMcpChatModel, setCurrentMcpChatModel] = useState('');
    const [mcpChatSystemInstruction, setMcpChatSystemInstruction] = useState('');
    const [mcpChatMaxTurns, setMcpChatMaxTurns] = useState(15);
    const [defaultMcpChatSystemInstruction, setDefaultMcpChatSystemInstruction] = useState('');
    
    // Local AI (Gemma 4) States
    const [localAiEnabled, setLocalAiEnabled] = useState(true);
    const [localAiHost, setLocalAiHost] = useState('http://localhost:11434');
    const [localAiModel, setLocalAiModel] = useState('gemma4:26b-mlx');
    const [localAiTemperature, setLocalAiTemperature] = useState('0.7');
    const [sessionLockMaxCount, setSessionLockMaxCount] = useState(6);

    // Live Concierge States
    const [geminiLiveAvailableModels, setGeminiLiveAvailableModels] = useState([]);
    const [geminiLiveDefaultModel, setGeminiLiveDefaultModel] = useState('gemini-3.8-live');

    // RBAC Policies & Installed Plugins State
    const [rbacPolicies, setRbacPolicies] = useState({});
    const [installedWidgets, setInstalledWidgets] = useState([]);
    const [coreAdminSubTab, setCoreAdminSubTab] = useState('oauth');
    const [orgSubTab, setOrgSubTab] = useState('users');
    
    // User Invitation State
    const [usersList, setUsersList] = useState([]);
    const [invitations, setInvitations] = useState([]);
    const [inviteEmail, setInviteEmail] = useState('');

    // Deep Research Internal Tabs
    const [activeDrTab, setActiveDrTab] = useState('folders');

    // Chat Presets & FAQ
    const [chatPresets, setChatPresets] = useState({});
    const [chatPresetContext, setChatPresetContext] = useState('normal');
    const [presetLabel, setPresetLabel] = useState('');
    const [presetPrompt, setPresetPrompt] = useState('');
    const [ragFaqs, setRagFaqs] = useState([]);


    const refreshModelsList = async () => {
        if (!canSelectModel) return;
        try {
            const [gemRes, claudeRes] = await Promise.all([
                fetch('/api/gemini/models').then(r => r.json()).catch(() => ({})),
                fetch('/api/claude/models').then(r => r.json()).catch(() => ({}))
            ]);
            if (Array.isArray(gemRes.models)) setModels(gemRes.models);
            
            const cList = Array.isArray(claudeRes.models)
                ? claudeRes.models
                : (Array.isArray(claudeRes)
                    ? claudeRes
                    : (Array.isArray(gemRes.claudeModels) ? gemRes.claudeModels : []));
            if (cList.length > 0) {
                setClaudeModels(cList);
            }
        } catch (err) {
            console.error("Failed to refresh models", err);
        }
    };

    useEffect(() => {
        
        // Fetch Chat Presets
        fetch('/api/chat/presets')
            .then(res => res.json())
            .then(data => setChatPresets(data))
            .catch(err => console.error("Failed to fetch presets", err));

        // Fetch FAQ (Admins get all FAQs, general users get popular FAQs)
        fetch(canManageSettings ? '/api/rag/popular-queries/all' : '/api/rag/popular-queries')
            .then(res => res.json())
            .then(data => setRagFaqs(Array.isArray(data) ? data : []))
            .catch(err => console.error("Failed to fetch FAQs", err));

        // Fetch models (Only for users with permission to choose/manage models, preventing 403 audit logs)
        if (canSelectModel) {
            refreshModelsList();
        }

        // Fetch current config
        fetch('/api/config')
            .then(res => res.json())
            .then(data => {
                if (data.aiProvider) {
                    setAiProvider(data.aiProvider);
                }
                if (data.geminiModel) {
                    setCurrentModel(data.geminiModel);
                } else {
                    setCurrentModel('gemini-3.1-flash-lite-preview');
                }
                if (data.claudeModel) {
                    setCurrentClaudeModel(data.claudeModel);
                } else {
                    setCurrentClaudeModel('claude-sonnet-4-6');
                }
                if (data.googleDriveRootId) {
                    setDriveRootId(data.googleDriveRootId);
                }
                if (data.googleDriveRagFolders) {
                    setRagFolders(data.googleDriveRagFolders);
                }
                if (data.isConfigured) {
                    setIsConfigured(data.isConfigured);
                }
                if (data.clientId) {
                    setGoogleClientId(data.clientId);
                }
                if (data.isGeminiConfigured !== undefined) {
                    setIsGeminiConfigured(data.isGeminiConfigured);
                }
                if (data.isClaudeConfigured !== undefined) {
                    setIsClaudeConfigured(data.isClaudeConfigured);
                }
                if (data.lastRagSyncTime) {
                    setLastRagSyncTime(data.lastRagSyncTime);
                }
                if (data.lastRagSyncTimeGemini) {
                    setLastRagSyncTimeGemini(data.lastRagSyncTimeGemini);
                }
                if (data.lastRagSyncTimeClaude) {
                    setLastRagSyncTimeClaude(data.lastRagSyncTimeClaude);
                }
                if (data.geminiResearchFolderId) {
                    setResearchFolderId(data.geminiResearchFolderId);
                }
                const globalGeminiModel = data.geminiModel || 'gemini-3.6-flash';
                if (data.nanoBananaModel) {
                    setCurrentNanoBananaModel(data.nanoBananaModel);
                } else {
                    setCurrentNanoBananaModel('imagen-3.0-generate-002');
                }
                if (data.geminiResearchModel) {
                    setCurrentResearchModel(data.geminiResearchModel);
                } else {
                    setCurrentResearchModel(globalGeminiModel);
                }
                if (data.geminiHtmlSvgModel) {
                    setCurrentHtmlSvgModel(data.geminiHtmlSvgModel);
                } else {
                    setCurrentHtmlSvgModel(globalGeminiModel);
                }
                if (data.nanoBananaPrompt) {
                    setNanoBananaPrompt(data.nanoBananaPrompt);
                }
                if (data.deepResearchPrompt) {
                    setDeepResearchPrompt(data.deepResearchPrompt);
                }
                if (data.htmlSvgPrompt) {
                    setHtmlSvgPrompt(data.htmlSvgPrompt);
                }
                if (data.mcpServerEndpoint) {
                    setMcpServerEndpoint(data.mcpServerEndpoint);
                }
                if (data.mcpTokenUrl) {
                    setMcpTokenUrl(data.mcpTokenUrl);
                }
                if (data.mcpClientId) {
                    setMcpClientId(data.mcpClientId);
                }
                if (data.isMcpSecretConfigured !== undefined) {
                    setIsMcpSecretConfigured(data.isMcpSecretConfigured);
                }
                if (data.mcpQuickPrompts) {
                    setMcpQuickPrompts(data.mcpQuickPrompts);
                }
                if (data.aiProvider === 'claude' && data.claudeMcpChatModel) {
                    setCurrentMcpChatModel(data.claudeMcpChatModel);
                } else if (data.geminiMcpChatModel) {
                    setCurrentMcpChatModel(data.geminiMcpChatModel);
                } else {
                    setCurrentMcpChatModel(data.aiProvider === 'claude' ? (data.claudeModel || 'claude-sonnet-4-6') : globalGeminiModel);
                }
                if (data.rbacPolicies) {
                    setRbacPolicies(data.rbacPolicies);
                }
                if (data.companyWorkPolicy) {
                    setCompanyWorkPolicy(data.companyWorkPolicy);
                }
                if (data.antigravityAgentModel) {
                    setAntigravityAgentModel(data.antigravityAgentModel);
                }
                if (data.antigravityAgentInstructions !== undefined) {
                    setAntigravityAgentInstructions(data.antigravityAgentInstructions);
                }
                if (data.antigravityAgentSafetyPolicy) {
                    setAntigravityAgentSafetyPolicy(data.antigravityAgentSafetyPolicy);
                }
                if (data.antigravityAgentExternalPolicyEnabled !== undefined) {
                    setAntigravityAgentExternalPolicyEnabled(data.antigravityAgentExternalPolicyEnabled);
                }
                if (data.antigravityAgentMcpServers) {
                    setAntigravityAgentMcpServers(data.antigravityAgentMcpServers);
                }
                if (data.localAiEnabled !== undefined) {
                    setLocalAiEnabled(data.localAiEnabled === 'true' || data.localAiEnabled === true);
                }
                if (data.localAiHost) {
                    setLocalAiHost(data.localAiHost);
                }
                if (data.localAiModel) {
                    setLocalAiModel(data.localAiModel);
                }
                if (data.localAiTemperature) {
                    setLocalAiTemperature(data.localAiTemperature.toString());
                }
                if (data.geminiLiveAvailableModels && Array.isArray(data.geminiLiveAvailableModels)) {
                    setGeminiLiveAvailableModels(data.geminiLiveAvailableModels);
                }
                if (data.geminiLiveDefaultModel) {
                    setGeminiLiveDefaultModel(data.geminiLiveDefaultModel);
                }
                if (data.mcpChatSystemInstruction !== undefined) {
                    setMcpChatSystemInstruction(data.mcpChatSystemInstruction);
                }
                if (data.mcpChatMaxTurns !== undefined) {
                    setMcpChatMaxTurns(data.mcpChatMaxTurns);
                }
                if (data.defaultMcpChatSystemInstruction !== undefined) {
                    setDefaultMcpChatSystemInstruction(data.defaultMcpChatSystemInstruction);
                }
                if (data.sessionLockMaxCount !== undefined) {
                    setSessionLockMaxCount(Number(data.sessionLockMaxCount) || 6);
                }
                if (Array.isArray(data.installedWidgets)) {
                    setInstalledWidgets(data.installedWidgets);
                }
            })
            .catch(err => console.error("Failed to fetch config", err));
    }, []);

    const handleSaveRbacPolicies = async (updatedPolicies) => {
        const prevPolicies = rbacPolicies;
        setRbacPolicies(updatedPolicies);
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rbacPolicies: updatedPolicies })
            });
            if (!res.ok) {
                setRbacPolicies(prevPolicies);
                const errData = await res.json().catch(() => ({}));
                alert(`権限設定の保存に失敗しました: ${errData.error || 'セッションが切れているか権限がありません'}`);
            }
        } catch (err) {
            setRbacPolicies(prevPolicies);
            console.error("Failed to save RBAC config", err);
            alert('権限設定の保存に失敗しました。再度ログインしてください。');
        }
    };

    const handleSaveWorkPolicy = async (newPolicy) => {
        const prevPolicy = companyWorkPolicy;
        setCompanyWorkPolicy(newPolicy);
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ companyWorkPolicy: newPolicy })
            });
            if (res.ok) {
                alert('Work Policy saved successfully!');
            } else {
                setCompanyWorkPolicy(prevPolicy);
                alert('Failed to save Work Policy.');
            }
        } catch (err) {
            setCompanyWorkPolicy(prevPolicy);
            console.error("Failed to save Work Policy", err);
            alert('Failed to save.');
        }
    };

    const handleSaveAntigravityAgentSettings = async (updatedConfig) => {
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updatedConfig)
            });
            if (res.ok) {
                alert('Antigravity Agent settings saved successfully!');
                setAntigravityAgentModel(updatedConfig.antigravityAgentModel);
                setAntigravityAgentInstructions(updatedConfig.antigravityAgentInstructions);
                setAntigravityAgentSafetyPolicy(updatedConfig.antigravityAgentSafetyPolicy);
                setAntigravityAgentExternalPolicyEnabled(updatedConfig.antigravityAgentExternalPolicyEnabled);
                setAntigravityAgentMcpServers(updatedConfig.antigravityAgentMcpServers);
            } else {
                const data = await res.json();
                alert('Failed to save: ' + (data.error || 'Unknown error'));
            }
        } catch (err) {
            console.error("Failed to save Antigravity Agent settings", err);
            alert('Failed to save.');
        }
    };

    const handleSaveSettings = async () => {
        try {
            const allowedWidgets = user?.allowed_widgets || [];
            const hasWidget = (widgetId) => allowedWidgets.includes('*') || allowedWidgets.includes(widgetId);
            const allowedActions = user?.allowed_actions || [];
            const hasAction = (actionId) => allowedActions.includes('*') || allowedActions.includes(actionId);

            const isManager = hasAction('action:edit_workflow_model') || hasAction('action:manage_system_settings');
            const canSeeBase = isManager || hasWidget('workflow:deepresearch_html') || hasWidget('workflow:deepresearch_infographic') || hasWidget('workflow:deepresearch_full');
            const canSeeHtml = isManager || hasWidget('workflow:deepresearch_html') || hasWidget('workflow:deepresearch_full');
            const canSeeInfo = isManager || hasWidget('workflow:deepresearch_infographic') || hasWidget('workflow:deepresearch_full');
            const hasSysSettings = isManager || hasAction('action:manage_system_settings');

            const payload = {};
            
            if (hasSysSettings) {
                payload.googleClientId = googleClientId;
                payload.mcpServerEndpoint = mcpServerEndpoint;
                payload.mcpTokenUrl = mcpTokenUrl;
                payload.mcpClientId = mcpClientId;
                payload.mcpQuickPrompts = mcpQuickPrompts;
                payload.aiProvider = aiProvider;
                if (geminiApiKey) payload.geminiApiKey = geminiApiKey;
                if (claudeApiKey) payload.claudeApiKey = claudeApiKey;
                if (googleClientSecret) payload.googleClientSecret = googleClientSecret;
                if (mcpClientSecret) payload.mcpClientSecret = mcpClientSecret;
                payload.localAiEnabled = localAiEnabled;
                payload.localAiHost = localAiHost;
                payload.localAiModel = localAiModel;
                payload.localAiTemperature = localAiTemperature;
                payload.mcpChatSystemInstruction = mcpChatSystemInstruction;
                payload.mcpChatMaxTurns = mcpChatMaxTurns;
                payload.sessionLockMaxCount = Math.max(1, Math.min(48, Number(sessionLockMaxCount) || 6));
            }

            if (canSeeBase) {
                payload.deepResearchPrompt = deepResearchPrompt;
                payload.researchFolderId = researchFolderId;
            }
            if (canSeeHtml) {
                payload.htmlSvgPrompt = htmlSvgPrompt;
            }
            if (canSeeInfo) {
                payload.nanoBananaPrompt = nanoBananaPrompt;
            }

            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                alert('Settings saved successfully!');
                if (geminiApiKey) {
                    setIsGeminiConfigured(true);
                    setGeminiApiKey('');
                }
                if (claudeApiKey) {
                    setIsClaudeConfigured(true);
                    setClaudeApiKey('');
                }
                await refreshModelsList();
            } else {
                const errData = await res.json().catch(() => ({}));
                alert(`Failed to save settings: ${errData.error || 'Server error'}`);
            }
        } catch (err) {
            console.error(err);
            alert(`Failed to save settings: ${err.message || 'Network error'}`);
        }
    };

    const handleModelChange = async (modelName) => {
        const prev = currentModel;
        setCurrentModel(modelName);
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geminiModel: modelName })
            });
            if (!res.ok) setCurrentModel(prev);
        } catch (err) {
            setCurrentModel(prev);
            console.error("Failed to save model selection", err);
        }
    };

    const handleClaudeModelChange = async (modelName) => {
        const prev = currentClaudeModel;
        setCurrentClaudeModel(modelName);
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ claudeModel: modelName })
            });
            if (!res.ok) setCurrentClaudeModel(prev);
        } catch (err) {
            setCurrentClaudeModel(prev);
            console.error("Failed to save Claude model selection", err);
        }
    };

    const handleAiProviderChange = async (provider) => {
        const prev = aiProvider;
        setAiProvider(provider);
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ aiProvider: provider })
            });
            if (!res.ok) setAiProvider(prev);
        } catch (err) {
            setAiProvider(prev);
            console.error("Failed to save AI provider selection", err);
        }
    };

    const handleNanoBananaModelChange = async (modelName) => {
        const prev = currentNanoBananaModel;
        setCurrentNanoBananaModel(modelName);
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nanoBananaModel: modelName })
            });
            if (!res.ok) setCurrentNanoBananaModel(prev);
        } catch (err) {
            setCurrentNanoBananaModel(prev);
            console.error("Failed to save nano banana model selection", err);
        }
    };

    const handleResearchModelChange = async (modelName) => {
        const prev = currentResearchModel;
        setCurrentResearchModel(modelName);
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geminiResearchModel: modelName })
            });
            if (!res.ok) setCurrentResearchModel(prev);
        } catch (err) {
            setCurrentResearchModel(prev);
            console.error("Failed to save research model selection", err);
        }
    };

    const handleHtmlSvgModelChange = async (modelName) => {
        const prev = currentHtmlSvgModel;
        setCurrentHtmlSvgModel(modelName);
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geminiHtmlSvgModel: modelName })
            });
            if (!res.ok) setCurrentHtmlSvgModel(prev);
        } catch (err) {
            setCurrentHtmlSvgModel(prev);
            console.error("Failed to save html/svg model selection", err);
        }
    };

    const handleMcpChatModelChange = async (modelName) => {
        const prev = currentMcpChatModel;
        setCurrentMcpChatModel(modelName);
        try {
            const isClaude = (modelName || '').startsWith('claude-');
            const payload = isClaude 
                ? { claudeMcpChatModel: modelName, geminiMcpChatModel: modelName }
                : { geminiMcpChatModel: modelName };
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) setCurrentMcpChatModel(prev);
        } catch (err) {
            setCurrentMcpChatModel(prev);
            console.error("Failed to save mcp chat model selection", err);
        }
    };

    const handleSaveDriveRoot = async () => {
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ googleDriveRootId: driveRootId })
            });
            if (res.ok) {
                alert('Drive Root ID saved!');
            } else {
                alert('Failed to save Drive Root ID.');
            }
        } catch (err) {
            console.error("Failed to save drive root", err);
            alert('Failed to save.');
        }
    };


    const [ragSyncErrors, setRagSyncErrors] = useState([]);

    const saveRagFoldersToApi = async (folders) => {
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ googleDriveRagFolders: folders })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${res.status}: Failed to save`);
            }
            return true;
        } catch (err) {
            console.error("Failed to save RAG folders", err);
            alert('Failed to save RAG folder: ' + err.message);
            return false;
        }
    };

    const handleAddRagFolder = async () => {
        if (!newRagFolderId || !newRagFolderName) {
            alert('Please provide both folder name and Google Drive Folder ID.');
            return;
        }
        
        // Prevent duplicate folder IDs
        if (ragFolders.some(f => f.id === newRagFolderId.trim())) {
            alert('This Folder ID is already added.');
            return;
        }

        const newFolderObj = { id: newRagFolderId.trim(), name: newRagFolderName.trim() };
        const newFolders = [...ragFolders, newFolderObj];
        
        const success = await saveRagFoldersToApi(newFolders);
        if (success) {
            setRagFolders(newFolders);
            setNewRagFolderId('');
            setNewRagFolderName('');
            alert(`Folder "${newFolderObj.name}" added successfully!`);
        }
    };

    const handleRemoveRagFolder = async (id) => {
        const newFolders = ragFolders.filter(f => f.id !== id);
        const success = await saveRagFoldersToApi(newFolders);
        if (success) {
            setRagFolders(newFolders);
        }
    };

    const handleSaveResearchFolder = async () => {
        try {
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geminiResearchFolderId: researchFolderId })
            });
            alert('Research Folder ID saved!');
        } catch (err) {
            console.error("Failed to save Research folder", err);
            alert('Failed to save.');
        }
    };

    const handleSyncRag = async (target = 'all') => {
        setIsSyncing(true);
        setSyncTarget(target);
        setRagSyncErrors([]);
        try {
            // Trigger sync
            const res = await fetch('/api/rag/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target })
            });
            const data = await res.json();

            if (!res.ok) {
                alert('Sync Failed to Start: ' + (data.error || 'Unknown error'));
                setIsSyncing(false);
                setSyncTarget(null);
                return;
            }

            // Start polling
            const pollInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch('/api/rag/status');
                    const statusData = await statusRes.json();

                    if (statusData.state === 'completed') {
                        clearInterval(pollInterval);
                        setIsSyncing(false);
                        setSyncTarget(null);
                        const newSyncTime = new Date().toISOString();
                        if (target === 'gemini' || target === 'all') setLastRagSyncTimeGemini(newSyncTime);
                        if (target === 'claude' || target === 'all') setLastRagSyncTimeClaude(newSyncTime);
                        setLastRagSyncTime(newSyncTime);
                        if (statusData.errors && statusData.errors.length > 0) {
                            setRagSyncErrors(statusData.errors);
                        }
                        window.dispatchEvent(new CustomEvent('rag-synced', { detail: { lastRagSyncTime: newSyncTime, target } }));
                        const targetLabel = target === 'gemini' ? 'Geminiへの同期' : target === 'claude' ? 'Claudeへの同期' : '全モデル同期';
                        const alertMsg = statusData.syncedCount !== undefined 
                            ? (statusData.syncedCount > 0 ? `${targetLabel}が完了しました (${statusData.syncedCount} 件のファイル)` : `${targetLabel}完了 (※ フォルダ内に対象ファイルが 0 件でした)`)
                            : (statusData.currentFile || 'Sync Complete!');
                        alert(alertMsg);
                    } else if (statusData.state === 'error') {
                        clearInterval(pollInterval);
                        setIsSyncing(false);
                        setSyncTarget(null);
                        alert('Sync Failed: ' + statusData.error);
                    } else if (statusData.state === 'syncing') {
                        // Keep syncing
                    }
                } catch (err) {
                    console.error("Polling Error", err);
                    clearInterval(pollInterval);
                    setIsSyncing(false);
                    setSyncTarget(null);
                }
            }, 2000); // Poll every 2 seconds

        } catch (err) {
            console.error("Sync Trigger Error", err);
            alert('Failed to trigger sync: ' + err.message);
            setIsSyncing(false);
            setSyncTarget(null);
        }
    };

    const handleSaveGeminiKey = async () => {
        try {
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geminiApiKey })
            });
            alert('Gemini API Key saved!');
            setGeminiApiKey('');
        } catch (err) {
            console.error("Failed to save Gemini API Key", err);
            alert('Failed to save.');
        }
    };


    const handleSaveNanoBananaPrompt = async () => {
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nanoBananaPrompt })
            });
            if (res.ok) alert('Nano Banana 2 Prompt saved!');
        } catch (err) { console.error('Failed to save prompt', err); }
    };

    const handleSaveDeepResearchPrompt = async () => {
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deepResearchPrompt })
            });
            if (res.ok) alert('Deep Research System Prompt saved!');
        } catch (err) { console.error('Failed to save prompt', err); }
    };

    const handleSaveHtmlSvgPrompt = async () => {
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ htmlSvgPrompt })
            });
            if (res.ok) alert('HTML & SVG Graph Prompt saved!');
        } catch (err) { console.error('Failed to save prompt', err); }
    };

    const handleSaveMcpConfig = async () => {
        try {
            const payload = { mcpServerEndpoint, mcpTokenUrl, mcpClientId };
            if (mcpClientSecret) {
                payload.mcpClientSecret = mcpClientSecret;
            }
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            alert('MCP Configuration saved!');
            setMcpClientSecret(''); // Clear the field after secure save
            setGoogleClientSecret(''); // Clear client secret as well
            setIsMcpSecretConfigured(true);
        } catch (err) {
            console.error("Failed to save MCP config", err);
            alert('Failed to save.');
        }
    };

    const isSystemAdmin = canManageSettings || hasAction('action:manage_roles') || hasAction('action:manage_users');

    const personalItems = [
        {
            id: 'General',
            section: 'personal',
            icon: '👤',
            label: 'マイ設定・プロフィール'
        },
        {
            id: 'Appearance',
            section: 'personal',
            icon: '🎨',
            label: '表示・外観テーマ'
        }
    ];

    const adminItems = isSystemAdmin ? [
        {
            id: 'AI Hub',
            section: 'admin',
            icon: '🤖',
            label: 'AI プロバイダー & モデル割当'
        },
        {
            id: 'Widget Store',
            section: 'admin',
            icon: '🧩',
            label: 'ウィジェット管理 & ストア'
        },
        {
            id: 'MCP Gateway',
            section: 'admin',
            icon: '🔌',
            label: 'MCP サーバー & Gateway 管理'
        },
        ...(hasAction('action:manage_roles') || canManageSettings ? [{
            id: 'ZTA PDP',
            section: 'admin',
            icon: '🛡️',
            label: 'ZTA ロール & 権限ビルダー'
        }] : []),
        {
            id: 'Organization',
            section: 'admin',
            icon: '👥',
            label: '組織 (ユーザー & Pod 管理)'
        },
        ...(canManageSettings ? [{
            id: 'Core & Audit',
            section: 'admin',
            icon: '⚙️',
            label: 'コアシステム & ZTA 監査'
        }] : [])
    ] : [];

    const sidebarItems = [...personalItems, ...adminItems];

    useEffect(() => {
        if (sidebarItems.length > 0 && !sidebarItems.find(item => item.id === activeTab)) {
            setActiveTab(sidebarItems[0].id);
        }
    }, [rbacPolicies, user]);

    const filteredModels = models.filter(model =>
        model.displayName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        model.name.toLowerCase().includes(searchTerm.toLowerCase())
    ).sort((a, b) => {
        if (a.name === currentModel) return -1;
        if (b.name === currentModel) return 1;
        return 0;
    });

    const activeItemMeta = sidebarItems.find(item => item.id === activeTab);

    return (
        <div className="flex h-full w-full overflow-hidden bg-[#f5f5f7] text-black font-sans text-sm select-none">
            {/* Sidebar */}
            <div className="w-60 flex-shrink-0 bg-[#e8e8ed]/70 border-r border-gray-300/60 pt-4 pb-4 px-2.5 flex flex-col gap-1 backdrop-blur-xl overflow-y-auto overscroll-contain min-h-0">
                <div className="px-2.5 mb-2 flex-shrink-0">
                    <div className="flex items-center gap-2.5 mb-3">
                        <div className="w-9 h-9 bg-gray-300 rounded-full overflow-hidden flex items-center justify-center font-bold text-gray-700 shadow-inner">
                            {user?.avatar_url || user?.avatarUrl ? (
                                <img src={user?.avatar_url || user?.avatarUrl} alt="User" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                                <span>{user?.name?.charAt(0) || user?.email?.charAt(0) || '?'}</span>
                            )}
                        </div>
                        <div className="flex flex-col min-w-0">
                            <span className="font-bold text-xs truncate">{user?.name || 'User'}</span>
                            <span className="text-[10px] text-gray-500 truncate">{user?.role || 'member'} · v{pkg.version}</span>
                        </div>
                    </div>
                </div>

                {/* Personal Section */}
                <div className="px-2.5 pt-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                    👤 マイ設定 (個人用)
                </div>
                {personalItems.map((item) => (
                    <button
                        key={item.id}
                        onClick={() => setActiveTab(item.id)}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors flex-shrink-0 cursor-pointer ${
                            activeTab === item.id
                                ? 'bg-blue-600 text-white shadow-xs'
                                : 'hover:bg-black/5 text-gray-700'
                        }`}
                    >
                        <span className="text-base leading-none">{item.icon}</span>
                        <span className="font-semibold text-xs truncate">{item.label}</span>
                    </button>
                ))}

                {/* System Admin Console Section */}
                {adminItems.length > 0 && (
                    <>
                        <div className="px-2.5 pt-4 pb-1 text-[10px] font-bold uppercase tracking-wider text-indigo-600">
                            🛠️ システム管理コンソール
                        </div>
                        {adminItems.map((item) => (
                            <button
                                key={item.id}
                                onClick={() => setActiveTab(item.id)}
                                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors flex-shrink-0 cursor-pointer ${
                                    activeTab === item.id
                                        ? 'bg-indigo-600 text-white shadow-xs'
                                        : 'hover:bg-black/5 text-gray-800'
                                }`}
                            >
                                <span className="text-base leading-none">{item.icon}</span>
                                <span className="font-semibold text-xs truncate">{item.label}</span>
                            </button>
                        ))}
                    </>
                )}
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto overscroll-contain p-7 min-h-0 bg-[#f5f5f7]">
                <div className="flex items-center justify-between mb-5">
                    <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                        <span>{activeItemMeta?.icon}</span>
                        <span>{activeItemMeta?.label || activeTab}</span>
                    </h1>
                </div>

                {/* Personal Tabs */}
                {activeTab === 'General' && (
                    <div className="space-y-6">
                        <GeneralTab />
                        {!isSystemAdmin && (
                            <UsersTab user={user} rbacPolicies={rbacPolicies} hasAction={hasAction} />
                        )}
                    </div>
                )}

                {activeTab === 'Appearance' && (
                    <div className="space-y-4">
                        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                            <h2 className="font-bold text-sm mb-3">デスクトップ外観モード</h2>
                            <div className="flex gap-4">
                                <div className="flex flex-col items-center gap-2 cursor-pointer">
                                    <div className="w-20 h-12 bg-gray-100 rounded-lg border border-gray-300"></div>
                                    <span className="text-xs font-medium">ライト</span>
                                </div>
                                <div className="flex flex-col items-center gap-2 cursor-pointer">
                                    <div className="w-20 h-12 bg-gray-800 rounded-lg border border-gray-600"></div>
                                    <span className="text-xs font-medium">ダーク</span>
                                </div>
                                <div className="flex flex-col items-center gap-2 cursor-pointer">
                                    <div className="w-20 h-12 bg-gradient-to-r from-gray-200 to-gray-800 rounded-lg border border-gray-400 ring-2 ring-blue-500 ring-offset-2"></div>
                                    <span className="text-xs font-medium">自動 (Auto)</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Category 1: AI Hub (Unified API Keys + Per-Widget Model Routing Matrix) */}
                {activeTab === 'AI Hub' && isSystemAdmin && (
                    <AiHubTab
                        geminiApiKey={geminiApiKey}
                        setGeminiApiKey={setGeminiApiKey}
                        claudeApiKey={claudeApiKey}
                        setClaudeApiKey={setClaudeApiKey}
                        aiProvider={aiProvider}
                        handleAiProviderChange={handleAiProviderChange}
                        isGeminiConfigured={isGeminiConfigured}
                        isClaudeConfigured={isClaudeConfigured}
                        handleSaveSettings={handleSaveSettings}
                        filteredModels={filteredModels}
                        claudeModels={claudeModels}
                        currentModel={currentModel}
                        handleModelChange={handleModelChange}
                        currentClaudeModel={currentClaudeModel}
                        handleClaudeModelChange={handleClaudeModelChange}
                        currentMcpChatModel={currentMcpChatModel}
                        handleMcpChatModelChange={handleMcpChatModelChange}
                        currentResearchModel={currentResearchModel}
                        handleResearchModelChange={handleResearchModelChange}
                        currentHtmlSvgModel={currentHtmlSvgModel}
                        handleHtmlSvgModelChange={handleHtmlSvgModelChange}
                        currentNanoBananaModel={currentNanoBananaModel}
                        handleNanoBananaModelChange={handleNanoBananaModelChange}
                        geminiLiveDefaultModel={geminiLiveDefaultModel}
                        refreshModelsList={refreshModelsList}
                        localAiEnabled={localAiEnabled}
                        setLocalAiEnabled={setLocalAiEnabled}
                        localAiHost={localAiHost}
                        setLocalAiHost={setLocalAiHost}
                        localAiModel={localAiModel}
                        setLocalAiModel={setLocalAiModel}
                        localAiTemperature={localAiTemperature}
                        setLocalAiTemperature={setLocalAiTemperature}
                        installedWidgets={installedWidgets}
                    />
                )}

                {/* Category 2: Widget Store & Encapsulated Widget Configs */}
                {activeTab === 'Widget Store' && isSystemAdmin && (
                    <WidgetStoreTab
                        user={user}
                        canManageSettings={canManageSettings}
                        hasWidget={hasWidget}
                        hasAction={hasAction}
                        mcpQuickPrompts={mcpQuickPrompts}
                        setMcpQuickPrompts={setMcpQuickPrompts}
                        handleSaveSettings={handleSaveSettings}
                        models={models}
                        claudeModels={claudeModels}
                        currentMcpChatModel={currentMcpChatModel}
                        handleMcpChatModelChange={handleMcpChatModelChange}
                        mcpChatSystemInstruction={mcpChatSystemInstruction}
                        setMcpChatSystemInstruction={setMcpChatSystemInstruction}
                        mcpChatMaxTurns={mcpChatMaxTurns}
                        setMcpChatMaxTurns={setMcpChatMaxTurns}
                        defaultMcpChatSystemInstruction={defaultMcpChatSystemInstruction}
                        chatPresets={chatPresets}
                        setChatPresets={setChatPresets}
                        chatPresetContext={chatPresetContext}
                        setChatPresetContext={setChatPresetContext}
                        presetLabel={presetLabel}
                        setPresetLabel={setPresetLabel}
                        presetPrompt={presetPrompt}
                        setPresetPrompt={setPresetPrompt}
                        ragFaqs={ragFaqs}
                        setRagFaqs={setRagFaqs}
                        ragFolders={ragFolders}
                        newRagFolderName={newRagFolderName}
                        setNewRagFolderName={setNewRagFolderName}
                        newRagFolderId={newRagFolderId}
                        setNewRagFolderId={setNewRagFolderId}
                        handleAddRagFolder={handleAddRagFolder}
                        handleRemoveRagFolder={handleRemoveRagFolder}
                        handleSyncRag={handleSyncRag}
                        isSyncing={isSyncing}
                        syncTarget={syncTarget}
                        lastRagSyncTime={lastRagSyncTime}
                        lastRagSyncTimeGemini={lastRagSyncTimeGemini}
                        lastRagSyncTimeClaude={lastRagSyncTimeClaude}
                        ragSyncErrors={ragSyncErrors}
                        isGeminiConfigured={isGeminiConfigured}
                        isClaudeConfigured={isClaudeConfigured}
                        aiProvider={aiProvider}
                        driveRootId={driveRootId}
                        setDriveRootId={setDriveRootId}
                        handleSaveDriveRoot={handleSaveDriveRoot}
                        geminiLiveAvailableModels={geminiLiveAvailableModels}
                        setGeminiLiveAvailableModels={setGeminiLiveAvailableModels}
                        geminiLiveDefaultModel={geminiLiveDefaultModel}
                        setGeminiLiveDefaultModel={setGeminiLiveDefaultModel}
                        onPluginsChanged={(pluginData) => {
                            if (pluginData?.installedWidgets || pluginData?.installed) {
                                setInstalledWidgets(pluginData.installedWidgets || pluginData.installed);
                            }
                        }}
                    />
                )}

                {/* Category 2.5: Independent MCP Server & ZTA Gateway Management */}
                {activeTab === 'MCP Gateway' && isSystemAdmin && (
                    <McpConnectionsTab
                        mcpQuickPrompts={mcpQuickPrompts}
                        setMcpQuickPrompts={setMcpQuickPrompts}
                        handleSaveSettings={handleSaveSettings}
                        models={models}
                        claudeModels={claudeModels}
                        currentMcpChatModel={currentMcpChatModel}
                        handleMcpChatModelChange={handleMcpChatModelChange}
                        mcpChatSystemInstruction={mcpChatSystemInstruction}
                        setMcpChatSystemInstruction={setMcpChatSystemInstruction}
                        mcpChatMaxTurns={mcpChatMaxTurns}
                        setMcpChatMaxTurns={setMcpChatMaxTurns}
                        defaultMcpChatSystemInstruction={defaultMcpChatSystemInstruction}
                        canManageSettings={canManageSettings}
                        user={user}
                        onPoliciesUpdated={(updatedRbac) => setRbacPolicies(updatedRbac)}
                        onNavigateTab={(tabId) => setActiveTab(tabId)}
                    />
                )}

                {/* Category 3: ZTA PDP 2-Tier Policy Matrix */}
                {activeTab === 'ZTA PDP' && isSystemAdmin && (
                    <ZtaPolicyMatrixTab
                        installedWidgets={installedWidgets}
                        ragFolders={ragFolders}
                        onPoliciesUpdated={(updatedRbac) => setRbacPolicies(updatedRbac)}
                        onNavigateTab={(tabId) => setActiveTab(tabId)}
                    />
                )}

                {/* Category 4: Organization (Users & Pods) */}
                {activeTab === 'Organization' && isSystemAdmin && (
                    <div className="space-y-5">
                        <div className="inline-flex rounded-xl bg-gray-200/80 p-1 gap-1">
                            <button
                                type="button"
                                onClick={() => setOrgSubTab('users')}
                                className={`px-4 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition ${
                                    orgSubTab === 'users' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-600 hover:text-gray-900'
                                }`}
                            >
                                👥 ユーザー管理・招待
                            </button>
                            <button
                                type="button"
                                onClick={() => setOrgSubTab('pods')}
                                className={`px-4 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition ${
                                    orgSubTab === 'pods' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-600 hover:text-gray-900'
                                }`}
                            >
                                🏢 ビジネスドメイン / Pod 編成
                            </button>
                        </div>

                        {orgSubTab === 'users' ? (
                            <UsersTab user={user} rbacPolicies={rbacPolicies} hasAction={hasAction} />
                        ) : (
                            <PodsTab user={user} hasAction={hasAction} />
                        )}
                    </div>
                )}

                {/* Category 5: Core System & ZTA Security Audit Logs */}
                {activeTab === 'Core & Audit' && canManageSettings && (
                    <div className="space-y-5">
                        <div className="inline-flex flex-wrap rounded-xl bg-gray-200/80 p-1 gap-1">
                            {[
                                { id: 'oauth', label: '🔐 Google OAuth & セッション保護' },
                                { id: 'audit', label: '🛡️ ZTA セキュリティ監査ログ' },
                                { id: 'policy', label: '📜 全社 AI ワークポリシー' },
                                { id: 'skills', label: '🧩 外部カスタムスキル登録' },
                                { id: 'legacy-roles', label: '⚙️ レガシー RBAC 詳細' }
                            ].map(t => (
                                <button
                                    key={t.id}
                                    type="button"
                                    onClick={() => setCoreAdminSubTab(t.id)}
                                    className={`px-3.5 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition ${
                                        coreAdminSubTab === t.id ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-600 hover:text-gray-900'
                                    }`}
                                >
                                    {t.label}
                                </button>
                            ))}
                        </div>

                        {coreAdminSubTab === 'oauth' && (
                            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
                                <h2 className="font-bold text-sm text-gray-900">Google OAuth 認証 & ZTA セッションロック設定</h2>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-medium text-gray-600 mb-1">Google OAuth Client ID</label>
                                        <input
                                            type="text"
                                            value={googleClientId}
                                            onChange={(e) => setGoogleClientId(e.target.value)}
                                            placeholder="Enter OAuth Client ID"
                                            className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white text-xs"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-medium text-gray-600 mb-1">Google OAuth Client Secret</label>
                                        <input
                                            type="password"
                                            value={googleClientSecret}
                                            onChange={(e) => setGoogleClientSecret(e.target.value)}
                                            placeholder={isConfigured ? '•••••••••••••••• (設定済)' : 'Enter OAuth Client Secret'}
                                            className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white text-xs"
                                        />
                                    </div>
                                </div>

                                <div className="pt-3 border-t border-gray-100">
                                    <div className="flex justify-between items-center mb-1">
                                        <label className="text-xs font-semibold text-gray-800">
                                            🔒 ZTA セッションロック最大反復回数 (30分無操作 × N回で強制ログアウト)
                                        </label>
                                        <span className="text-xs font-mono text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                                            30分 × {sessionLockMaxCount || 6}回 = 計 {(Number(sessionLockMaxCount) || 6) * 30}分
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        min="1"
                                        max="24"
                                        value={sessionLockMaxCount || 6}
                                        onChange={(e) => setSessionLockMaxCount(Number(e.target.value))}
                                        className="w-full accent-indigo-600 cursor-pointer"
                                    />
                                </div>

                                <div className="pt-2 flex justify-end">
                                    <button
                                        type="button"
                                        onClick={handleSaveSettings}
                                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold cursor-pointer"
                                    >
                                        💾 コア認証設定を保存
                                    </button>
                                </div>
                            </div>
                        )}

                        {coreAdminSubTab === 'audit' && <SecurityLogsTab />}

                        {coreAdminSubTab === 'policy' && (
                            <WorkPolicyTab
                                initialPolicy={companyWorkPolicy}
                                onSave={handleSaveWorkPolicy}
                            />
                        )}

                        {coreAdminSubTab === 'skills' && <SkillsTab />}

                        {coreAdminSubTab === 'legacy-roles' && (
                            <ZtaPolicyMatrixTab
                                installedWidgets={installedWidgets}
                                ragFolders={ragFolders}
                                onPoliciesUpdated={(updatedRbac) => setRbacPolicies(updatedRbac)}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default SystemSettings;
