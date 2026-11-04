const db = require('../db.cjs');
const { WIDGET_CATALOG } = require('./pluginManager.cjs');

const LEVEL_RANK = {
    none: 0,
    read: 1,
    execute: 2,
    manage: 3
};

const OP_LEVEL_RANK = {
    none: 0,
    read_only: 1,
    execute: 2,
    read_write: 3,
    admin: 4
};

const WRITE_TOOL_PATTERNS = [
    /^write_query$/i,
    /^drop_table$/i,
    /^create_table$/i,
    /^alter_table$/i,
    /^(insert|update|delete|drop|alter|truncate|create|upsert|modify|remove)_/i,
    /_(insert|update|delete|drop|write|create|remove)$/i
];

const MUTATING_SQL_REGEX = /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|DATABASE|INDEX|VIEW)|ALTER\s+TABLE|TRUNCATE\s+TABLE|REPLACE\s+INTO|CREATE\s+(TABLE|DATABASE|INDEX|VIEW))\b/i;

function isWriteToolName(toolName = '') {
    const clean = String(toolName).replace(/^mcp_\d+_/, '');
    return WRITE_TOOL_PATTERNS.some(rx => rx.test(clean));
}

function mapOpLevelToWidgetLevel(opLevel) {
    if (opLevel === 'admin') return 'manage';
    if (opLevel === 'read_write' || opLevel === 'execute') return 'execute';
    if (opLevel === 'read_only') return 'read';
    return 'none';
}

function mapWidgetLevelToOpLevel(widgetLevel, canPublishKnowledge = false) {
    if (widgetLevel === 'manage') return 'admin';
    if (widgetLevel === 'execute') return canPublishKnowledge ? 'read_write' : 'execute';
    if (widgetLevel === 'read') return 'read_only';
    return 'none';
}

function normalizeIdentifiers(val) {
    if (!val) return [];
    if (Array.isArray(val)) {
        return val.map(s => String(s).trim()).filter(Boolean);
    }
    return String(val)
        .split(/[,\n]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

function normalizeGrant(g, idx = 0) {
    const resourceType = g.resource_type || 'widget';
    const resourceId = String(g.resource_id ?? '*');
    const operationLevel = g.operation_level || 'read_only';
    const dataScope = g.data_scope || 'all_company';
    const constraints = g.constraints || {};
    return {
        id: g.id || `grant_${resourceType}_${resourceId}_${idx}`,
        resource_type: resourceType,
        resource_id: resourceId,
        resource_label: g.resource_label || '',
        operation_level: operationLevel,
        data_scope: dataScope,
        constraints: {
            restricted_identifiers: normalizeIdentifiers(constraints.restricted_identifiers),
            blocked_tools: normalizeIdentifiers(constraints.blocked_tools),
            scope_prompt_guard: constraints.scope_prompt_guard ? String(constraints.scope_prompt_guard).trim() : '',
            allowed_tasks: Array.isArray(constraints.allowed_tasks) ? constraints.allowed_tasks : []
        }
    };
}

/**
 * Synthesize Universal Permission Grants from legacy/v2 fields when a role doesn't yet have explicit `grants`
 */
function synthesizeGrantsFromRole(roleKey, roleData = {}) {
    if (roleKey === 'admin') {
        return [
            normalizeGrant({
                id: 'grant_admin_mcp_all',
                resource_type: 'mcp_server',
                resource_id: '*',
                resource_label: '全 MCP サーバー (Wildcard)',
                operation_level: 'admin',
                data_scope: 'all_company',
                constraints: {}
            }),
            normalizeGrant({
                id: 'grant_admin_widget_all',
                resource_type: 'widget',
                resource_id: '*',
                resource_label: '全 AI ウィジェット & プラグイン',
                operation_level: 'admin',
                data_scope: 'all_company',
                constraints: {}
            }),
            normalizeGrant({
                id: 'grant_admin_pod_all',
                resource_type: 'organization_pod',
                resource_id: '*',
                resource_label: '全社・全部門 Pod',
                operation_level: 'admin',
                data_scope: 'all_company',
                constraints: {}
            }),
            normalizeGrant({
                id: 'grant_admin_sys_all',
                resource_type: 'system_governance',
                resource_id: '*',
                resource_label: 'システム設定・ZTAガバナンス全体',
                operation_level: 'admin',
                data_scope: 'all_company',
                constraints: {}
            })
        ];
    }

    const grants = [];
    const matrix = roleData.v2_matrix || {};
    const mcpScopes = roleData.mcp_scopes || [];
    const mcpRules = roleData.mcp_rules || {};
    const podScopes = roleData.pod_scopes || {};
    const ragScopes = roleData.rag_folder_scopes || [];
    const sysAdmin = roleData.system_admin || {};

    // 1. Widget grants
    for (const w of WIDGET_CATALOG) {
        const entry = matrix[w.id];
        if (!entry || !entry.level || entry.level === 'none') continue;
        const opLevel = mapWidgetLevelToOpLevel(entry.level, entry.canPublishKnowledge);
        grants.push(normalizeGrant({
            id: `grant_widget_${w.id}`,
            resource_type: 'widget',
            resource_id: w.id,
            resource_label: w.name,
            operation_level: opLevel,
            data_scope: 'all_company',
            constraints: {
                allowed_tasks: entry.canPublishKnowledge ? ['publish_knowledge'] : []
            }
        }, grants.length));
    }

    // 2. MCP Server grants
    for (const sId of mcpScopes) {
        const rule = mcpRules[sId] || {};
        const defaultOp = matrix['mcp-chat']?.level === 'manage'
            ? 'admin'
            : matrix['mcp-chat']?.level === 'read'
                ? 'read_only'
                : 'execute';
        grants.push(normalizeGrant({
            id: `grant_mcp_${sId}`,
            resource_type: 'mcp_server',
            resource_id: String(sId),
            resource_label: sId === '*' ? '全 MCP サーバー (*)' : `MCP Server #${sId}`,
            operation_level: rule.operation_level || defaultOp,
            data_scope: rule.data_scope || 'all_company',
            constraints: {
                restricted_identifiers: rule.restricted_identifiers || [],
                blocked_tools: rule.blocked_tools || [],
                scope_prompt_guard: rule.scope_prompt_guard || ''
            }
        }, grants.length));
    }

    // 3. Organization Pod grants
    for (const [podId, perm] of Object.entries(podScopes)) {
        if (!perm || perm === 'none') continue;
        grants.push(normalizeGrant({
            id: `grant_pod_${podId}`,
            resource_type: 'organization_pod',
            resource_id: podId,
            resource_label: podId === '*' ? '全組織 Pod (*)' : `Pod: ${podId}`,
            operation_level: perm === 'manage' ? 'admin' : perm === 'write' ? 'read_write' : 'read_only',
            data_scope: podId === '*' ? 'all_company' : 'department_pod',
            constraints: {}
        }, grants.length));
    }

    // 4. Knowledge / RAG Folder grants
    for (const fId of ragScopes) {
        grants.push(normalizeGrant({
            id: `grant_rag_${fId}`,
            resource_type: 'knowledge_space',
            resource_id: String(fId),
            resource_label: fId === '*' ? '全 RAG フォルダ (*)' : `RAG フォルダ #${fId}`,
            operation_level: sysAdmin.manage_rag_folders ? 'admin' : 'read_only',
            data_scope: 'all_company',
            constraints: {}
        }, grants.length));
    }

    // 5. System Governance grants
    const sysKeys = [
        { key: 'manage_settings', label: 'システム基本設定・MCP管理' },
        { key: 'manage_roles', label: 'ZTA ロール・権限ポリシー管理' },
        { key: 'manage_users', label: 'ユーザー・ロール割当管理' },
        { key: 'invite_users', label: '新規ユーザー招待' },
        { key: 'manage_rag_folders', label: 'RAG ナレッジフォルダ管理' }
    ];
    for (const sk of sysKeys) {
        if (sysAdmin[sk.key]) {
            grants.push(normalizeGrant({
                id: `grant_sys_${sk.key}`,
                resource_type: 'system_governance',
                resource_id: sk.key,
                resource_label: sk.label,
                operation_level: 'admin',
                data_scope: 'all_company',
                constraints: {}
            }, grants.length));
        }
    }

    return grants;
}

/**
 * Hydrate legacy RBAC_POLICIES into the ZTA PDP Universal Permission Grant & 3D Matrix structure
 * while preserving 100% backward compatibility with legacy allowed_widgets / allowed_actions / allowed_models / allowed_pods.
 */
function hydrateRolePolicy(roleKey, roleData = {}) {
    if (roleKey === 'admin') {
        const adminMatrix = {};
        const adminLevels = {};
        for (const w of WIDGET_CATALOG) {
            adminMatrix[w.id] = {
                level: 'manage',
                canPublishKnowledge: true
            };
            adminLevels[w.id] = 'manage';
        }
        const label = roleData.label || roleData.displayName || 'システム管理者 (Admin)';
        const grants = Array.isArray(roleData.grants) && roleData.grants.length > 0
            ? roleData.grants.map((g, i) => normalizeGrant(g, i))
            : synthesizeGrantsFromRole('admin', roleData);
        return {
            ...roleData,
            roleCategory: roleData.roleCategory || 'system',
            label,
            displayName: label,
            description: roleData.description || '全ウィジェット・全MCPサーバー・ZTA PDPに対する完全な管理権限',
            allowed_widgets: ['*'],
            allowed_actions: ['*'],
            allowed_models: ['*'],
            allowed_pods: ['*'],
            grants,
            mcp_rules: {
                '*': {
                    operation_level: 'admin',
                    data_scope: 'all_company',
                    restricted_identifiers: [],
                    blocked_tools: [],
                    scope_prompt_guard: ''
                }
            },
            v2_matrix: adminMatrix,
            widget_levels: adminLevels,
            pod_scopes: { '*': 'manage' },
            mcp_scopes: ['*'],
            rag_folder_scopes: ['*'],
            system_admin: {
                manage_settings: true,
                manage_roles: true,
                manage_users: true,
                invite_users: true,
                manage_rag_folders: true
            }
        };
    }

    const legacyWidgets = roleData.allowed_widgets || [];
    const legacyActions = roleData.allowed_actions || [];
    const legacyModels = roleData.allowed_models || ['model:gemini-flash'];
    const legacyPods = roleData.allowed_pods || [];

    const existingMatrix = roleData.v2_matrix || {};
    const existingLevels = roleData.widget_levels || {};
    const hydratedMatrix = {};
    const hydratedLevels = {};

    for (const w of WIDGET_CATALOG) {
        const explicitLevel = existingLevels[w.id] || existingMatrix[w.id]?.level;
        if (explicitLevel) {
            hydratedMatrix[w.id] = {
                level: explicitLevel,
                canPublishKnowledge: existingMatrix[w.id]?.canPublishKnowledge !== undefined
                    ? existingMatrix[w.id].canPublishKnowledge
                    : ['execute', 'manage'].includes(explicitLevel)
            };
            hydratedLevels[w.id] = explicitLevel;
            continue;
        }

        const legacyId = w.permissionsSchema?.legacyWidgetId || `app:${w.id}`;
        const hasWidget = legacyWidgets.includes('*') || legacyWidgets.includes(legacyId);

        let inferredLevel = 'none';
        if (hasWidget) {
            const manageActions = w.permissionsSchema?.manageActions || [];
            const hasManage = manageActions.length > 0 && manageActions.some(a => legacyActions.includes('*') || legacyActions.includes(a));
            if (hasManage) {
                inferredLevel = 'manage';
            } else if (w.id === 'mcp-chat') {
                inferredLevel = (legacyActions.includes('*') || legacyActions.includes('action:use_mcp_tools')) ? 'execute' : 'read';
            } else {
                inferredLevel = 'execute';
            }
        }

        hydratedMatrix[w.id] = {
            level: inferredLevel,
            canPublishKnowledge: ['execute', 'manage'].includes(inferredLevel)
        };
        hydratedLevels[w.id] = inferredLevel;
    }

    const existingPodScopes = roleData.pod_scopes || {};
    const podScopes = { ...existingPodScopes };
    if (Object.keys(podScopes).length === 0) {
        for (const p of legacyPods) {
            podScopes[p] = hydratedMatrix['knowledge-base']?.level === 'read' ? 'read' : 'write';
        }
    }

    const mcpScopes = roleData.mcp_scopes || legacyWidgets
        .filter(id => id.startsWith('mcp:'))
        .map(id => id.replace(/^mcp:/, ''));

    const ragFolderScopes = roleData.rag_folder_scopes || legacyWidgets
        .filter(id => id.startsWith('rag:'))
        .map(id => id.replace(/^rag:/, ''));

    const systemAdmin = roleData.system_admin || {
        manage_settings: legacyActions.includes('*') || legacyActions.includes('action:manage_system_settings'),
        manage_roles: legacyActions.includes('*') || legacyActions.includes('action:manage_roles'),
        manage_users: legacyActions.includes('*') || legacyActions.includes('action:manage_users'),
        invite_users: legacyActions.includes('*') || legacyActions.includes('action:invite_users'),
        manage_rag_folders: legacyActions.includes('*') || legacyActions.includes('action:manage_rag_folders')
    };

    return compileRolePolicy(roleKey, {
        ...roleData,
        allowed_models: legacyModels,
        v2_matrix: hydratedMatrix,
        pod_scopes: podScopes,
        mcp_scopes: mcpScopes,
        mcp_rules: roleData.mcp_rules || {},
        rag_folder_scopes: ragFolderScopes,
        system_admin: systemAdmin,
        custom_skills: roleData.custom_skills || legacyWidgets.filter(id => id.startsWith('skill:'))
    });
}

/**
 * Compile Universal Permission Grants (`grants`) + `v2_matrix` + scopes into all runtime PEP structures
 */
function compileRolePolicy(roleKey, roleData) {
    if (roleKey === 'admin') {
        const adminLevels = {};
        const adminMatrix = {};
        for (const w of WIDGET_CATALOG) {
            adminLevels[w.id] = 'manage';
            adminMatrix[w.id] = { level: 'manage', canPublishKnowledge: true };
        }
        const label = roleData.label || roleData.displayName || 'システム管理者 (Admin)';
        const grants = Array.isArray(roleData.grants) && roleData.grants.length > 0
            ? roleData.grants.map((g, i) => normalizeGrant(g, i))
            : synthesizeGrantsFromRole('admin', roleData);
        return {
            ...roleData,
            roleCategory: roleData.roleCategory || 'system',
            label,
            displayName: label,
            grants,
            mcp_rules: {
                '*': {
                    operation_level: 'admin',
                    data_scope: 'all_company',
                    restricted_identifiers: [],
                    blocked_tools: [],
                    scope_prompt_guard: ''
                }
            },
            allowed_widgets: ['*'],
            allowed_actions: ['*'],
            allowed_models: ['*'],
            allowed_pods: ['*'],
            widget_levels: adminLevels,
            v2_matrix: adminMatrix
        };
    }

    const rawMatrix = roleData.v2_matrix || {};
    const rawLevels = roleData.widget_levels || {};
    const matrix = {};
    const widgetLevels = {};
    for (const w of WIDGET_CATALOG) {
        const lvl = rawLevels[w.id] || rawMatrix[w.id]?.level || 'none';
        widgetLevels[w.id] = lvl;
        matrix[w.id] = {
            level: lvl,
            canPublishKnowledge: rawMatrix[w.id]?.canPublishKnowledge !== undefined
                ? rawMatrix[w.id].canPublishKnowledge
                : ['execute', 'manage'].includes(lvl)
        };
    }

    const podScopes = { ...(roleData.pod_scopes || {}) };
    const mcpScopesSet = new Set((roleData.mcp_scopes || []).map(String));
    const mcpRules = { ...(roleData.mcp_rules || {}) };
    const ragFolderScopesSet = new Set((roleData.rag_folder_scopes || []).map(String));
    const sysAdmin = {
        manage_settings: Boolean(roleData.system_admin?.manage_settings),
        manage_roles: Boolean(roleData.system_admin?.manage_roles),
        manage_users: Boolean(roleData.system_admin?.manage_users),
        invite_users: Boolean(roleData.system_admin?.invite_users),
        manage_rag_folders: Boolean(roleData.system_admin?.manage_rag_folders)
    };
    const customSkills = roleData.custom_skills || [];

    // If explicit `grants` array is provided, fold it into matrix, mcpScopes, mcpRules, podScopes, ragScopes, sysAdmin
    let grants = [];
    if (Array.isArray(roleData.grants)) {
        grants = roleData.grants.map((g, i) => normalizeGrant(g, i));

        // If grants was explicitly edited in the Universal Role Builder, let grants drive the resource scopes cleanly
        if (roleData._grantsAuthoritative) {
            mcpScopesSet.clear();
            for (const k of Object.keys(mcpRules)) delete mcpRules[k];
            for (const k of Object.keys(podScopes)) delete podScopes[k];
            ragFolderScopesSet.clear();
            sysAdmin.manage_settings = false;
            sysAdmin.manage_roles = false;
            sysAdmin.manage_users = false;
            sysAdmin.invite_users = false;
            sysAdmin.manage_rag_folders = false;
            for (const w of WIDGET_CATALOG) {
                if (!rawLevels[w.id] && !rawMatrix[w.id]?.level) {
                    widgetLevels[w.id] = 'none';
                    matrix[w.id] = { level: 'none', canPublishKnowledge: false };
                }
            }
        }

        for (const g of grants) {
            if (g.resource_type === 'mcp_server') {
                const sId = String(g.resource_id || '*');
                mcpScopesSet.add(sId);
                mcpRules[sId] = {
                    operation_level: g.operation_level || 'read_only',
                    data_scope: g.data_scope || 'all_company',
                    restricted_identifiers: g.constraints?.restricted_identifiers || [],
                    blocked_tools: g.constraints?.blocked_tools || [],
                    scope_prompt_guard: g.constraints?.scope_prompt_guard || ''
                };
                // Automatically ensure mcp-chat widget is enabled when at least one MCP server grant exists
                const targetWidgetLvl = g.operation_level === 'admin'
                    ? 'manage'
                    : (g.operation_level === 'read_write' || g.operation_level === 'execute' || g.operation_level === 'read_only')
                        ? 'execute'
                        : 'read';
                if ((LEVEL_RANK[targetWidgetLvl] || 0) > (LEVEL_RANK[matrix['mcp-chat']?.level] || 0)) {
                    matrix['mcp-chat'] = {
                        level: targetWidgetLvl,
                        canPublishKnowledge: ['read_write', 'admin'].includes(g.operation_level)
                    };
                    widgetLevels['mcp-chat'] = targetWidgetLvl;
                }
            } else if (g.resource_type === 'widget') {
                const wIds = g.resource_id === '*' ? WIDGET_CATALOG.map(w => w.id) : [g.resource_id];
                const wLevel = mapOpLevelToWidgetLevel(g.operation_level);
                const canPub = g.operation_level === 'read_write' || g.operation_level === 'admin' ||
                    (g.constraints?.allowed_tasks || []).includes('publish_knowledge');
                for (const wId of wIds) {
                    if (matrix[wId]) {
                        matrix[wId] = {
                            level: wLevel,
                            canPublishKnowledge: canPub
                        };
                        widgetLevels[wId] = wLevel;
                    }
                }
            } else if (g.resource_type === 'organization_pod') {
                const pId = String(g.resource_id || '*');
                podScopes[pId] = g.operation_level === 'admin'
                    ? 'manage'
                    : (g.operation_level === 'read_write' || g.operation_level === 'execute')
                        ? 'write'
                        : 'read';
            } else if (g.resource_type === 'knowledge_space') {
                const fId = String(g.resource_id || '*');
                ragFolderScopesSet.add(fId);
                if (g.operation_level === 'admin' || g.operation_level === 'read_write') {
                    sysAdmin.manage_rag_folders = true;
                }
                if ((LEVEL_RANK[matrix['knowledge-base']?.level] || 0) < LEVEL_RANK.read) {
                    const kbLvl = mapOpLevelToWidgetLevel(g.operation_level);
                    matrix['knowledge-base'] = {
                        level: kbLvl,
                        canPublishKnowledge: ['read_write', 'admin'].includes(g.operation_level)
                    };
                    widgetLevels['knowledge-base'] = kbLvl;
                }
            } else if (g.resource_type === 'system_governance') {
                if (g.resource_id === '*') {
                    sysAdmin.manage_settings = true;
                    sysAdmin.manage_roles = true;
                    sysAdmin.manage_users = true;
                    sysAdmin.invite_users = true;
                    sysAdmin.manage_rag_folders = true;
                } else if (g.resource_id in sysAdmin) {
                    sysAdmin[g.resource_id] = g.operation_level !== 'none';
                }
            }
        }
    } else {
        grants = synthesizeGrantsFromRole(roleKey, {
            ...roleData,
            v2_matrix: matrix,
            mcp_scopes: Array.from(mcpScopesSet),
            mcp_rules: mcpRules,
            pod_scopes: podScopes,
            rag_folder_scopes: Array.from(ragFolderScopesSet),
            system_admin: sysAdmin
        });
    }

    const mcpScopes = Array.from(mcpScopesSet);
    const ragFolderScopes = Array.from(ragFolderScopesSet);

    const allowedWidgets = new Set();
    const allowedActions = new Set();

    for (const w of WIDGET_CATALOG) {
        const entry = matrix[w.id] || { level: 'none' };
        const rank = LEVEL_RANK[entry.level] || 0;
        const legacyId = w.permissionsSchema?.legacyWidgetId || `app:${w.id}`;

        if (rank >= LEVEL_RANK.read) {
            allowedWidgets.add(legacyId);
        }
        if (rank >= LEVEL_RANK.execute) {
            for (const act of (w.permissionsSchema?.executeActions || [])) {
                allowedActions.add(act);
            }
            for (const subW of (w.permissionsSchema?.executeWidgets || [])) {
                allowedWidgets.add(subW);
            }
        }
        if (rank >= LEVEL_RANK.manage) {
            for (const act of (w.permissionsSchema?.manageActions || [])) {
                allowedActions.add(act);
            }
        }
    }

    // Add scoped MCP servers (`mcp:<id>`) if MCP client is at least readable/executable
    const mcpRank = LEVEL_RANK[matrix['mcp-chat']?.level] || 0;
    if (mcpRank >= LEVEL_RANK.read || mcpScopes.length > 0) {
        allowedWidgets.add('app:mcp-chat');
        allowedActions.add('action:use_mcp_tools');
        if (mcpScopes.includes('*')) {
            allowedWidgets.add('mcp:*');
            for (const sId of (roleData._knownMcpIds || [])) {
                allowedWidgets.add(`mcp:${sId}`);
            }
        } else {
            for (const sId of mcpScopes) {
                allowedWidgets.add(`mcp:${sId}`);
            }
        }
    }

    // Add scoped RAG Drive folders (`rag:<id>`)
    for (const fId of ragFolderScopes) {
        allowedWidgets.add(`rag:${fId}`);
    }

    // Add custom skills (`skill:<id>`)
    for (const sk of customSkills) {
        allowedWidgets.add(sk.startsWith('skill:') ? sk : `skill:${sk}`);
    }

    // Add system admin actions
    if (sysAdmin.manage_settings) allowedActions.add('action:manage_system_settings');
    if (sysAdmin.manage_roles) allowedActions.add('action:manage_roles');
    if (sysAdmin.manage_users) allowedActions.add('action:manage_users');
    if (sysAdmin.invite_users) allowedActions.add('action:invite_users');
    if (sysAdmin.manage_rag_folders) allowedActions.add('action:manage_rag_folders');

    // Compile allowed_pods (any pod with 'read', 'write', or 'manage')
    const allowedPods = [];
    for (const [podId, perm] of Object.entries(podScopes)) {
        if (perm && perm !== 'none') {
            allowedPods.push(podId);
        }
    }

    const label = roleData.label || roleData.displayName || roleKey;
    return {
        roleCategory: roleData.roleCategory || 'custom',
        label,
        displayName: label,
        description: roleData.description || '',
        grants,
        mcp_rules: mcpRules,
        allowed_widgets: Array.from(allowedWidgets),
        allowed_actions: Array.from(allowedActions),
        allowed_models: Array.isArray(roleData.allowed_models) && roleData.allowed_models.length > 0
            ? roleData.allowed_models
            : ['model:gemini-flash'],
        allowed_pods: allowedPods,
        widget_levels: widgetLevels,
        v2_matrix: matrix,
        pod_scopes: podScopes,
        mcp_scopes: mcpScopes,
        rag_folder_scopes: ragFolderScopes,
        system_admin: sysAdmin,
        custom_skills: customSkills
    };
}

/**
 * Hydrate and normalize an entire RBAC_POLICIES object
 */
function hydrateAllPolicies(rawPolicies = {}, knownMcpIds = []) {
    const result = {};
    const keys = Object.keys(rawPolicies);
    if (!keys.includes('admin')) keys.unshift('admin');
    if (!keys.includes('user')) keys.push('user');

    for (const key of keys) {
        result[key] = hydrateRolePolicy(key, {
            ...(rawPolicies[key] || {}),
            _knownMcpIds: knownMcpIds
        });
        delete result[key]._knownMcpIds;
    }
    return result;
}

/**
 * Role Preset Templates for Universal Role Builder (MCP, HR/Department Scopes, NPB/Gov Open Data, DeepResearch, Executive Workflows)
 */
const ROLE_PRESET_TEMPLATES = {
    mcp_admin: {
        roleKey: 'mcp_admin',
        roleCategory: 'mcp',
        displayName: '🔌 MCP Admin (全MCP管理・データ更新ロール)',
        description: 'すべてのMCPサーバーへの接続設定、ハーネス(YAML)更新、およびデータ更新ツール(write_query等)の実行を許可する管理者ロール',
        allowed_models: ['model:gemini-flash', 'model:gemini-pro', 'model:claude-sonnet', 'model:claude-opus'],
        grants: [
            {
                id: 'grant_mcp_all_admin',
                resource_type: 'mcp_server',
                resource_id: '*',
                resource_label: '全 MCP サーバー (*)',
                operation_level: 'admin',
                data_scope: 'all_company',
                constraints: {
                    restricted_identifiers: [],
                    blocked_tools: [],
                    scope_prompt_guard: ''
                }
            },
            {
                id: 'grant_widget_mcp_admin',
                resource_type: 'widget',
                resource_id: 'mcp-chat',
                resource_label: 'MCP Client & Tool Agent',
                operation_level: 'admin',
                data_scope: 'all_company',
                constraints: { allowed_tasks: ['publish_knowledge', 'manage_mcp_servers', 'edit_harness'] }
            }
        ],
        v2_matrix: {
            gemini: { level: 'execute', canPublishKnowledge: true },
            'mcp-chat': { level: 'manage', canPublishKnowledge: true },
            'knowledge-base': { level: 'execute', canPublishKnowledge: true }
        },
        mcp_scopes: ['*'],
        pod_scopes: { '*': 'write' },
        system_admin: {
            manage_settings: true,
            manage_roles: false,
            manage_users: false,
            invite_users: false,
            manage_rag_folders: false
        }
    },
    mcp_viewer: {
        roleKey: 'mcp_viewer',
        roleCategory: 'mcp',
        displayName: '👁️ MCP 汎用参照ロール (Read-Only)',
        description: 'MCPサーバーを用いたデータ検索・集計・可視化(SELECT/参照系ツール)のみ許可し、DBの更新・削除(write_query, drop_table等)をブロックする参照専用ロール',
        allowed_models: ['model:gemini-flash', 'model:gemini-pro', 'model:claude-sonnet'],
        grants: [
            {
                id: 'grant_mcp_all_readonly',
                resource_type: 'mcp_server',
                resource_id: '*',
                resource_label: '全 MCP サーバー (*)',
                operation_level: 'read_only',
                data_scope: 'all_company',
                constraints: {
                    restricted_identifiers: [],
                    blocked_tools: ['write_query', 'drop_table'],
                    scope_prompt_guard: 'データの参照・検索・集計のみ許可。INSERT/UPDATE/DELETE/DROP等のデータ変更操作は厳禁。'
                }
            },
            {
                id: 'grant_widget_mcp_viewer',
                resource_type: 'widget',
                resource_id: 'mcp-chat',
                resource_label: 'MCP Client & Tool Agent',
                operation_level: 'execute',
                data_scope: 'all_company',
                constraints: {}
            }
        ],
        v2_matrix: {
            gemini: { level: 'execute', canPublishKnowledge: false },
            'mcp-chat': { level: 'execute', canPublishKnowledge: false },
            'knowledge-base': { level: 'read', canPublishKnowledge: false }
        },
        mcp_scopes: ['*'],
        pod_scopes: { public: 'read' },
        system_admin: {
            manage_settings: false,
            manage_roles: false,
            manage_users: false,
            invite_users: false,
            manage_rag_folders: false
        }
    },
    hr_mcp_admin: {
        roleKey: 'hr_mcp_admin',
        roleCategory: 'hr_domain',
        displayName: '👔 人事MCP Admin (人事部用・全社人事DB更新可)',
        description: '人事部メンバー向け。全社員の人事評価・給与・配置データへのフルアクセスおよびデータ更新(Read/Write)を許可するロール',
        allowed_models: ['model:gemini-flash', 'model:gemini-pro', 'model:claude-sonnet'],
        grants: [
            {
                id: 'grant_hr_mcp_rw',
                resource_type: 'mcp_server',
                resource_id: '*',
                resource_label: '人事データベース MCP / 全MCP (*)',
                operation_level: 'read_write',
                data_scope: 'all_company',
                constraints: {
                    restricted_identifiers: [],
                    blocked_tools: ['drop_table'],
                    scope_prompt_guard: '人事部特権ロール：全社部門の人事・給与・評価テーブルの参照および更新クエリの実行を許可。'
                }
            },
            {
                id: 'grant_hr_pod',
                resource_type: 'organization_pod',
                resource_id: '*',
                resource_label: '全社部門 Pod (*)',
                operation_level: 'read_write',
                data_scope: 'all_company',
                constraints: {}
            }
        ],
        v2_matrix: {
            gemini: { level: 'execute', canPublishKnowledge: true },
            'mcp-chat': { level: 'execute', canPublishKnowledge: true },
            'knowledge-base': { level: 'execute', canPublishKnowledge: true }
        },
        mcp_scopes: ['*'],
        pod_scopes: { '*': 'write' },
        system_admin: {
            manage_settings: false,
            manage_roles: false,
            manage_users: true,
            invite_users: true,
            manage_rag_folders: false
        }
    },
    hr_mcp_dept_mgr: {
        roleKey: 'hr_mcp_dept_mgr',
        roleCategory: 'hr_domain',
        displayName: '📋 人事MCP 参照 (部長用・自部門スコープ & 給与カラム除外)',
        description: '事業部長・部門長向け。自部門メンバーのスキル・目標・配置データの参照のみ許可し、給与テーブル(salary/bonus)や他部門データの直接取得・DB更新を遮断するロール',
        allowed_models: ['model:gemini-flash', 'model:gemini-pro', 'model:claude-sonnet'],
        grants: [
            {
                id: 'grant_hr_dept_readonly',
                resource_type: 'mcp_server',
                resource_id: '*',
                resource_label: '人事・基幹 MCP (部門長制限付き)',
                operation_level: 'read_only',
                data_scope: 'department_pod',
                constraints: {
                    restricted_identifiers: ['salary', 'bonus', 'base_pay', 'compensation', 'secret_evaluation'],
                    blocked_tools: ['write_query', 'drop_table'],
                    scope_prompt_guard: '所属部門(Pod)のメンバー情報のみ参照可能。給与・賞与(salary, bonus)等の機密人事カラムの抽出および他部門の個人データ照会は禁止。'
                }
            }
        ],
        v2_matrix: {
            gemini: { level: 'execute', canPublishKnowledge: true },
            'mcp-chat': { level: 'execute', canPublishKnowledge: false },
            'knowledge-base': { level: 'execute', canPublishKnowledge: true }
        },
        mcp_scopes: ['*'],
        pod_scopes: { public: 'write' },
        system_admin: {
            manage_settings: false,
            manage_roles: false,
            manage_users: false,
            invite_users: false,
            manage_rag_folders: false
        }
    },
    npb_commissioner: {
        roleKey: 'npb_commissioner',
        roleCategory: 'mcp_sample',
        displayName: '⚾ NPB コミッショナー (全12球団データ更新・管理ロール)',
        description: '【検証用：人事部相当】NPB管理者用MCP(#5)を含む全NPBデータに対し、全12球団の参照およびデータ更新(write_query)を許可するフル権限ロール',
        allowed_models: ['model:gemini-flash', 'model:gemini-pro', 'model:claude-sonnet'],
        grants: [
            {
                id: 'grant_npb_admin_rw',
                resource_type: 'mcp_server',
                resource_id: '5',
                resource_label: 'NPB Baseball (管理者用 / 参照・更新 #5)',
                operation_level: 'read_write',
                data_scope: 'all_company',
                constraints: {
                    restricted_identifiers: [],
                    blocked_tools: ['drop_table'],
                    scope_prompt_guard: 'NPB全12球団の全テーブル(打撃・投手・順位・CS結果)の参照およびwrite_queryによるデータ更新を許可。'
                }
            },
            {
                id: 'grant_npb_ro_4',
                resource_type: 'mcp_server',
                resource_id: '4',
                resource_label: 'NPB Baseball (参照専用 #4)',
                operation_level: 'read_only',
                data_scope: 'all_company',
                constraints: {}
            }
        ],
        v2_matrix: {
            gemini: { level: 'execute', canPublishKnowledge: true },
            'mcp-chat': { level: 'execute', canPublishKnowledge: true },
            'knowledge-base': { level: 'execute', canPublishKnowledge: true }
        },
        mcp_scopes: ['4', '5', '6'],
        pod_scopes: { '*': 'write' },
        system_admin: {
            manage_settings: false,
            manage_roles: false,
            manage_users: false,
            invite_users: false,
            manage_rag_folders: false
        }
    },
    npb_team_mgr: {
        roleKey: 'npb_team_mgr',
        roleCategory: 'mcp_sample',
        displayName: '🐯 NPB 球団編成部長 (参照専用・自球団スコープ & 制限カラム検証用)',
        description: '【検証用：部長ロール相当】NPB MCP(#4/#5)に接続できるが、write_query等の更新ツールは遮断(Read-Only)され、特定テーブル/カラム(pitching_stats, salary)へのSQLアクセスもPEPでブロックされる検証ロール',
        allowed_models: ['model:gemini-flash', 'model:gemini-pro', 'model:claude-sonnet'],
        grants: [
            {
                id: 'grant_npb_mgr_5',
                resource_type: 'mcp_server',
                resource_id: '5',
                resource_label: 'NPB Baseball (管理者用 #5 を参照制限モードで利用)',
                operation_level: 'read_only',
                data_scope: 'department_pod',
                constraints: {
                    restricted_identifiers: ['pitching_stats', 'salary', 'contract_amount'],
                    blocked_tools: ['write_query', 'drop_table'],
                    scope_prompt_guard: '担当球団（阪神タイガース / セ・リーグ）の野手・チーム成績の分析のみ許可。pitching_stats（投手機密査定テーブル）およびsalaryカラムの直接クエリやデータ更新は禁止。'
                }
            },
            {
                id: 'grant_npb_mgr_4',
                resource_type: 'mcp_server',
                resource_id: '4',
                resource_label: 'NPB Baseball (参照専用 #4)',
                operation_level: 'read_only',
                data_scope: 'department_pod',
                constraints: {
                    restricted_identifiers: ['pitching_stats', 'salary', 'contract_amount'],
                    blocked_tools: ['write_query', 'drop_table'],
                    scope_prompt_guard: '担当球団（阪神タイガース）の分析のみ許可。pitching_statsテーブルおよびsalaryのクエリは禁止。'
                }
            }
        ],
        v2_matrix: {
            gemini: { level: 'execute', canPublishKnowledge: false },
            'mcp-chat': { level: 'execute', canPublishKnowledge: false },
            'knowledge-base': { level: 'read', canPublishKnowledge: false }
        },
        mcp_scopes: ['4', '5'],
        pod_scopes: { public: 'read' },
        system_admin: {
            manage_settings: false,
            manage_roles: false,
            manage_users: false,
            invite_users: false,
            manage_rag_folders: false
        }
    },
    gov_analyst: {
        roleKey: 'gov_analyst',
        roleCategory: 'mcp_sample',
        displayName: '🏛️ デジタル庁 行政データ分析ロール (公開統計MCP専用)',
        description: '【検証用：サーバー単位の分離】デジタル庁 行政手続分析 MCP(#7)とナレッジMCP(#2)のみ利用可能で、NPBデータベース(#4, #5)へのアクセスは完全に遮断されるロール',
        allowed_models: ['model:gemini-flash', 'model:gemini-pro', 'model:claude-sonnet'],
        grants: [
            {
                id: 'grant_gov_mcp_7',
                resource_type: 'mcp_server',
                resource_id: '7',
                resource_label: 'デジタル庁 行政手続分析 MCP (#7)',
                operation_level: 'read_only',
                data_scope: 'public_summary',
                constraints: {
                    restricted_identifiers: [],
                    blocked_tools: [],
                    scope_prompt_guard: '公開されている行政手続・法令・統計オープンデータの分析に特化。社内機密・個人情報の送信は禁止。'
                }
            },
            {
                id: 'grant_gov_mcp_2',
                resource_type: 'mcp_server',
                resource_id: '2',
                resource_label: 'Knowledge Base MCP (#2)',
                operation_level: 'read_only',
                data_scope: 'public_summary',
                constraints: {}
            }
        ],
        v2_matrix: {
            gemini: { level: 'execute', canPublishKnowledge: true },
            'mcp-chat': { level: 'execute', canPublishKnowledge: true },
            'knowledge-base': { level: 'read', canPublishKnowledge: false }
        },
        mcp_scopes: ['2', '7'],
        pod_scopes: { public: 'read' },
        system_admin: {
            manage_settings: false,
            manage_roles: false,
            manage_users: false,
            invite_users: false,
            manage_rag_folders: false
        }
    },
    researcher_viewer: {
        roleKey: 'researcher_viewer',
        roleCategory: 'widget_task',
        displayName: '🔬 DeepResearch & ナレッジ閲覧専用ロール (実行・登録制限)',
        description: '【検証用：MCP以外のウィジェット権限】DeepResearchの過去レポート閲覧およびナレッジベースでのAI壁打ち(Read)のみ許可し、新規DeepResearch調査の実行やナレッジ登録(Write)を遮断するロール',
        allowed_models: ['model:gemini-flash', 'model:claude-haiku'],
        grants: [
            {
                id: 'grant_dr_readonly',
                resource_type: 'widget',
                resource_id: 'deep-research',
                resource_label: 'DeepResearch (自律調査エージェント)',
                operation_level: 'read_only',
                data_scope: 'all_company',
                constraints: {
                    allowed_tasks: ['history_view'],
                    scope_prompt_guard: '過去の調査レポート履歴の閲覧のみ許可。新規DeepResearchジョブの実行(execute)は不可。'
                }
            },
            {
                id: 'grant_kb_readonly',
                resource_type: 'widget',
                resource_id: 'knowledge-base',
                resource_label: 'Knowledge Base (RAG & AI壁打ち)',
                operation_level: 'read_only',
                data_scope: 'public_summary',
                constraints: {
                    allowed_tasks: ['rag_chat']
                }
            },
            {
                id: 'grant_gemini_exec',
                resource_type: 'widget',
                resource_id: 'gemini',
                resource_label: 'AI Assistant (Normal Chat)',
                operation_level: 'execute',
                data_scope: 'all_company',
                constraints: {}
            }
        ],
        v2_matrix: {
            gemini: { level: 'execute', canPublishKnowledge: false },
            'mcp-chat': { level: 'none', canPublishKnowledge: false },
            'knowledge-base': { level: 'read', canPublishKnowledge: false },
            'deep-research': { level: 'read', canPublishKnowledge: false }
        },
        mcp_scopes: [],
        pod_scopes: { public: 'read' },
        system_admin: {
            manage_settings: false,
            manage_roles: false,
            manage_users: false,
            invite_users: false,
            manage_rag_folders: false
        }
    },
    exec_planner: {
        roleKey: 'exec_planner',
        roleCategory: 'business',
        displayName: '📊 経営管理・営業支援 (全社分析まとめ)',
        description: 'MCPで売上見込み等を分析し、経営会議用の全社まとめレポートをナレッジ登録・管理するロール',
        allowed_models: ['model:gemini-flash', 'model:gemini-pro', 'model:claude-sonnet', 'model:claude-opus'],
        v2_matrix: {
            gemini: { level: 'execute', canPublishKnowledge: true },
            'mcp-chat': { level: 'execute', canPublishKnowledge: true },
            'knowledge-base': { level: 'manage', canPublishKnowledge: true },
            'deep-research': { level: 'execute', canPublishKnowledge: true }
        },
        pod_scopes: { '*': 'write' },
        mcp_scopes: ['*'],
        system_admin: {
            manage_settings: false,
            manage_roles: false,
            manage_users: false,
            invite_users: false,
            manage_rag_folders: true
        }
    },
    domain_leader: {
        roleKey: 'domain_leader',
        roleCategory: 'business',
        displayName: '🏢 事業部長・部門長 (ドメイン深掘り分析)',
        description: '事前共有された全社まとめをRAG参照しつつ、自事業部ドメインの課題やQ2投資判断を分析・意見投稿するロール',
        allowed_models: ['model:gemini-flash', 'model:gemini-pro', 'model:claude-sonnet'],
        v2_matrix: {
            gemini: { level: 'execute', canPublishKnowledge: true },
            'mcp-chat': { level: 'execute', canPublishKnowledge: true },
            'knowledge-base': { level: 'execute', canPublishKnowledge: true },
            'deep-research': { level: 'execute', canPublishKnowledge: true }
        },
        pod_scopes: { '*': 'read', public: 'write' },
        mcp_scopes: ['*'],
        system_admin: {
            manage_settings: false,
            manage_roles: false,
            manage_users: false,
            invite_users: false,
            manage_rag_folders: false
        }
    },
    general_member: {
        roleKey: 'general_member',
        roleCategory: 'business',
        displayName: '👤 一般社員 (基本チャット & 公開ナレッジ参照)',
        description: 'ノーマルチャットでの業務対話および公開ナレッジの参照(RAG)のみ可能な標準ロール',
        allowed_models: ['model:gemini-flash', 'model:claude-haiku'],
        v2_matrix: {
            gemini: { level: 'execute', canPublishKnowledge: false },
            'mcp-chat': { level: 'none', canPublishKnowledge: false },
            'knowledge-base': { level: 'read', canPublishKnowledge: false }
        },
        pod_scopes: { public: 'read' },
        mcp_scopes: [],
        system_admin: {
            manage_settings: false,
            manage_roles: false,
            manage_users: false,
            invite_users: false,
            manage_rag_folders: false
        }
    }
};

/**
 * Evaluate effective v2 widget permission level for a user (across multiple assigned roles)
 */
async function evaluateUserWidgetLevel(user, widgetId) {
    if (!user) return 'none';
    const roles = (user.role || 'user').split(',').map(r => r.trim()).filter(Boolean);
    if (roles.includes('admin')) return 'manage';

    try {
        const raw = JSON.parse((await db.getSetting('RBAC_POLICIES')) || '{}');
        const hydrated = hydrateAllPolicies(raw);
        let maxRank = 0;
        let maxLevel = 'none';

        for (const r of roles) {
            const rolePolicy = hydrated[r];
            if (!rolePolicy) continue;
            const entry = rolePolicy.v2_matrix?.[widgetId];
            const rank = LEVEL_RANK[entry?.level] || 0;
            if (rank > maxRank) {
                maxRank = rank;
                maxLevel = entry.level;
            }
        }
        return maxLevel;
    } catch (e) {
        return 'none';
    }
}

/**
 * Evaluate effective MCP Server Grant for a given set of roles and a specific MCP server ID.
 * Used both at runtime by `mcpClient.cjs` and by the 1-click PEP Simulator.
 */
function evaluateRolesMcpGrant(hydratedPolicies, roleKeys = [], serverId) {
    const sIdStr = String(serverId);
    if (roleKeys.includes('admin')) {
        return {
            allowed: true,
            operation_level: 'admin',
            data_scope: 'all_company',
            restricted_identifiers: [],
            blocked_tools: [],
            scope_prompt_guard: '',
            matched_roles: ['admin']
        };
    }

    let matched = false;
    let bestOpRank = 0;
    let bestOpLevel = 'none';
    let bestScope = 'public_summary';
    const matchedRoles = [];
    const restrictedPerRole = [];
    const blockedToolsPerRole = [];
    const guards = [];

    const SCOPE_RANK = {
        public_summary: 1,
        own_only: 2,
        department_pod: 3,
        all_company: 4
    };

    for (const rKey of roleKeys) {
        const policy = hydratedPolicies[rKey];
        if (!policy) continue;

        const scopes = (policy.mcp_scopes || []).map(String);
        const legacyWidgets = policy.allowed_widgets || [];
        const hasServer =
            scopes.includes('*') ||
            scopes.includes(sIdStr) ||
            legacyWidgets.includes('*') ||
            legacyWidgets.includes('mcp:*') ||
            legacyWidgets.includes(`mcp:${sIdStr}`);

        if (!hasServer) continue;

        matched = true;
        matchedRoles.push(rKey);

        // Find specific rule for serverId or fallback to '*' rule
        const rule = policy.mcp_rules?.[sIdStr] || policy.mcp_rules?.['*'] || {};
        const opLevel = rule.operation_level || (
            policy.v2_matrix?.['mcp-chat']?.level === 'manage'
                ? 'admin'
                : policy.v2_matrix?.['mcp-chat']?.level === 'read'
                    ? 'read_only'
                    : 'execute'
        );
        const opRank = OP_LEVEL_RANK[opLevel] || 1;
        if (opRank > bestOpRank) {
            bestOpRank = opRank;
            bestOpLevel = opLevel;
        }

        const dScope = rule.data_scope || 'all_company';
        if ((SCOPE_RANK[dScope] || 0) > (SCOPE_RANK[bestScope] || 0)) {
            bestScope = dScope;
        }

        restrictedPerRole.push(normalizeIdentifiers(rule.restricted_identifiers));
        blockedToolsPerRole.push(normalizeIdentifiers(rule.blocked_tools));
        if (rule.scope_prompt_guard) {
            guards.push(rule.scope_prompt_guard);
        }
    }

    if (!matched) {
        return {
            allowed: false,
            operation_level: 'none',
            data_scope: 'none',
            restricted_identifiers: [],
            blocked_tools: [],
            scope_prompt_guard: '',
            matched_roles: []
        };
    }

    // If a user has multiple roles granting access to the same MCP server, an identifier is only restricted if ALL granting roles restrict it
    // (or if only 1 role grants access, use that role's restrictions).
    let effectiveRestricted = [];
    if (restrictedPerRole.length === 1) {
        effectiveRestricted = restrictedPerRole[0];
    } else if (restrictedPerRole.length > 1) {
        const first = restrictedPerRole[0];
        effectiveRestricted = first.filter(item =>
            restrictedPerRole.every(list => list.some(x => x.toLowerCase() === item.toLowerCase()))
        );
    }

    let effectiveBlockedTools = [];
    if (blockedToolsPerRole.length === 1) {
        effectiveBlockedTools = blockedToolsPerRole[0];
    } else if (blockedToolsPerRole.length > 1) {
        const first = blockedToolsPerRole[0];
        effectiveBlockedTools = first.filter(item =>
            blockedToolsPerRole.every(list => list.some(x => x.toLowerCase() === item.toLowerCase()))
        );
    }

    return {
        allowed: true,
        operation_level: bestOpLevel,
        data_scope: bestScope,
        restricted_identifiers: effectiveRestricted,
        blocked_tools: effectiveBlockedTools,
        scope_prompt_guard: Array.from(new Set(guards)).join(' / '),
        matched_roles: matchedRoles
    };
}

/**
 * Inspect tool execution arguments (e.g., SQL query) against an evaluated MCP Grant.
 */
function inspectMcpToolCallAgainstGrant(grant, toolName, args = {}) {
    if (!grant || !grant.allowed) {
        return {
            allowed: false,
            reason: 'このロールには対象 MCP サーバーへの接続権限 (mcp_server grant) が付与されていません。'
        };
    }

    const cleanTool = String(toolName).replace(/^mcp_\d+_/, '');

    // 1. Check explicit blocked_tools constraint
    if (Array.isArray(grant.blocked_tools) && grant.blocked_tools.some(bt => bt.toLowerCase() === cleanTool.toLowerCase())) {
        return {
            allowed: false,
            reason: `ロールの制約 (blocked_tools) によりツール「${cleanTool}」の実行は禁止されています。`
        };
    }

    // 2. Check operation_level vs write/destructive tool names
    if (grant.operation_level === 'read_only' && isWriteToolName(cleanTool)) {
        return {
            allowed: false,
            reason: `ロールの操作権限が「参照のみ (read_only)」のため、更新・削除系ツール「${cleanTool}」は ZTA PEP によりブロックされました。`
        };
    }

    // 3. Inspect SQL / query arguments for mutating SQL when operation_level is read_only
    const sqlText = String(args?.query || args?.sql || args?.statement || '');
    if (grant.operation_level === 'read_only' && sqlText && MUTATING_SQL_REGEX.test(sqlText)) {
        return {
            allowed: false,
            reason: `ロールの操作権限が「参照のみ (read_only)」のため、データ変更を伴う SQL クエリ (${sqlText.slice(0, 60)}...) は ZTA PEP によりブロックされました。`
        };
    }

    // 4. Inspect SQL / arguments against restricted_identifiers (tables/columns like salary, bonus, pitching_stats)
    const restricted = grant.restricted_identifiers || [];
    if (restricted.length > 0) {
        const serializedArgs = `${sqlText} ${JSON.stringify(args || {})}`.toLowerCase();
        const hit = restricted.find(ident => {
            const needle = String(ident).trim().toLowerCase();
            if (!needle) return false;
            const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const boundaryRx = new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i');
            return boundaryRx.test(serializedArgs) || serializedArgs.includes(needle);
        });
        if (hit) {
            return {
                allowed: false,
                reason: `ロールのデータスコープ制約 (${grant.data_scope}) により、機密指定された識別子・テーブル・カラム「${hit}」へのアクセスは ZTA PEP によりブロックされました。`
            };
        }
    }

    return {
        allowed: true,
        reason: `許可 (operation_level: ${grant.operation_level}, data_scope: ${grant.data_scope})`
    };
}

/**
 * Dry-run PEP Permission Simulator for the Role Builder UI
 */
function evaluatePermissionSimulation(rawPolicies, roleKeys = [], scenario = {}, knownMcpIds = []) {
    const roles = Array.isArray(roleKeys) ? roleKeys : String(roleKeys || '').split(',').map(s => s.trim()).filter(Boolean);
    const hydrated = hydrateAllPolicies(rawPolicies, knownMcpIds);

    const resourceType = scenario.resource_type || 'mcp_server';
    const resourceId = String(scenario.resource_id ?? '5');
    const actionType = scenario.action_type || 'read_query';
    const sampleQuery = scenario.sample_query || '';

    if (resourceType === 'mcp_server') {
        const grant = evaluateRolesMcpGrant(hydrated, roles, resourceId);
        if (!grant.allowed) {
            return {
                allowed: false,
                decision: 'DENY',
                stage: 'MCP Server Scope Check',
                reason: `選択されたロール (${roles.join(', ')}) には MCP サーバー #${resourceId} へのアクセス権限がありません。`,
                grant
            };
        }
        const toolCheck = inspectMcpToolCallAgainstGrant(grant, actionType, { query: sampleQuery });
        return {
            allowed: toolCheck.allowed,
            decision: toolCheck.allowed ? 'PERMIT' : 'DENY',
            stage: toolCheck.allowed ? 'ZTA PEP Guard Passed' : 'ZTA PEP Tool & SQL Guard',
            reason: toolCheck.reason,
            grant
        };
    }

    if (resourceType === 'widget') {
        if (roles.includes('admin')) {
            return {
                allowed: true,
                decision: 'PERMIT',
                stage: 'Admin Bypass',
                reason: 'システム管理者 (admin) はすべてのウィジェット操作が許可されています。'
            };
        }
        const normalizedResId = resourceId.replace(/^app:/, '');
        const aliasSet = new Set([
            resourceId,
            normalizedResId,
            `app:${normalizedResId}`,
            normalizedResId === 'deepresearch' ? 'deep-research' : normalizedResId,
            normalizedResId === 'deep-research' ? 'deepresearch' : normalizedResId
        ]);
        let maxRank = 0;
        let maxLevel = 'none';
        let canPublish = false;
        for (const r of roles) {
            const p = hydrated[r];
            if (!p) continue;
            for (const cand of aliasSet) {
                const entry = p.v2_matrix?.[cand];
                const rnk = LEVEL_RANK[entry?.level] || 0;
                if (rnk > maxRank) {
                    maxRank = rnk;
                    maxLevel = entry.level;
                }
                if (entry?.canPublishKnowledge) canPublish = true;
            }
            if (Array.isArray(p.grants)) {
                for (const g of p.grants) {
                    if (g.resource_type === 'widget' && (g.resource_id === '*' || aliasSet.has(g.resource_id))) {
                        const mappedLevel = g.operation_level === 'admin' ? 'manage'
                            : (g.operation_level === 'read_write' || g.operation_level === 'execute') ? 'execute'
                            : g.operation_level === 'read_only' ? 'read' : 'none';
                        const rnk = LEVEL_RANK[mappedLevel] || 0;
                        if (rnk > maxRank) {
                            maxRank = rnk;
                            maxLevel = mappedLevel;
                        }
                        if (g.operation_level === 'read_write' || g.operation_level === 'admin') {
                            canPublish = true;
                        }
                    }
                }
            }
        }

        if (actionType === 'view_history' || actionType === 'read') {
            const ok = maxRank >= LEVEL_RANK.read;
            return {
                allowed: ok,
                decision: ok ? 'PERMIT' : 'DENY',
                stage: 'Widget Read Check',
                reason: ok
                    ? `ウィジェット「${resourceId}」の閲覧・参照 (現在の権限レベル: ${maxLevel}) が許可されています。`
                    : `ウィジェット「${resourceId}」へのアクセス権がありません (level: none)。`
            };
        }

        if (actionType === 'publish_knowledge') {
            const ok = maxRank >= LEVEL_RANK.execute && canPublish;
            return {
                allowed: ok,
                decision: ok ? 'PERMIT' : 'DENY',
                stage: 'Knowledge Publish Check',
                reason: ok
                    ? `ウィジェット「${resourceId}」からのナレッジ登録・公開が許可されています。`
                    : `このロールは参照・実行のみ可能で、公式ナレッジベースへの新規登録 (canPublishKnowledge) は制限されています。`
            };
        }

        if (actionType === 'manage') {
            const ok = maxRank >= LEVEL_RANK.manage;
            return {
                allowed: ok,
                decision: ok ? 'PERMIT' : 'DENY',
                stage: 'Widget Manage Check',
                reason: ok
                    ? `ウィジェット「${resourceId}」の管理操作が許可されています。`
                    : `管理操作には manage (管理) レベルが必要ですが、現在のロールは「${maxLevel}」レベルのためブロックされました。`
            };
        }

        // Default: execute (e.g. starting a new DeepResearch task)
        const ok = maxRank >= LEVEL_RANK.execute;
        return {
            allowed: ok,
            decision: ok ? 'PERMIT' : 'DENY',
            stage: 'Widget Execute Check',
            reason: ok
                ? `ウィジェット「${resourceId}」でのタスク実行 (レベル: ${maxLevel}) が許可されています。`
                : maxRank === LEVEL_RANK.read
                    ? `このロールは「参照のみ (read_only)」のため、過去履歴の閲覧は可能ですが、新規ジョブ実行 (execute) は ZTA PEP によりブロックされました。`
                    : `ウィジェット「${resourceId}」へのアクセス権がありません。`
        };
    }

    return {
        allowed: false,
        decision: 'DENY',
        stage: 'Unknown Resource Type',
        reason: '未対応のリソース種別です。'
    };
}

module.exports = {
    LEVEL_RANK,
    OP_LEVEL_RANK,
    ROLE_PRESET_TEMPLATES,
    isWriteToolName,
    hydrateRolePolicy,
    compileRolePolicy,
    hydrateAllPolicies,
    evaluateUserWidgetLevel,
    evaluateRolesMcpGrant,
    inspectMcpToolCallAgainstGrant,
    evaluatePermissionSimulation
};
