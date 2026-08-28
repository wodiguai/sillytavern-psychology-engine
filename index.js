/**
 * Psychology Engine for SillyTavern
 * v0.3.3 — Actor Eligibility Gate
 *
 * No secondary LLM call.
 *
 * Main generation:
 *   current state + psychology protocol
 *        ↓
 *   user's normal SillyTavern main API / model / preset
 *        ↓
 *   RP prose + invisible HTML-comment control blocks
 *        ↓
 *   plugin parses control blocks, strips them, updates state
 *
 * This means the psychology engine follows the SAME main generation path
 * as normal roleplay.
 */

const METADATA_KEY = 'psychology_engine_v1';
const SETTINGS_KEY = 'psychologyEngine';
const PROMPT_ID = 'psychology_engine_single_pass';
const MSG_META_KEY = 'psychology_engine_v03';

const CORE_VARIABLES = [
    'Love','Trust','Security','Intimacy','Dependency','Exclusivity','Resentment','Respect',
    'Mood','Arousal','Anger','Fear','Shyness','Hurt','Longing','RelationalThreat','Guilt','Disgust',
];

const LONG_RELATION_VARIABLES = new Set([
    'Love','Trust','Security','Intimacy','Dependency','Exclusivity','Resentment','Respect',
]);

const SHORT_STATE_VARIABLES = new Set([
    'Mood','Arousal','Anger','Fear','Shyness','Hurt','Longing','RelationalThreat','Guilt','Disgust',
]);

const DERIVED_VARIABLES = [
    'Jealousy','AffectionSeeking','Shame','Curiosity','Gratitude',
    'Attraction','Pride','Loneliness','Admiration',
];

const PERSONALITY_CONTROL = [
    'SelfControl','Assertiveness','VulnerabilityTolerance',
    'PrivacyBias','Empathy','CognitiveFlexibility','NeedForControl',
];

const STYLE_TRAITS = [
    'warmth','sociability','romanticExpressiveness','jealousyProneness',
    'dependencyProneness','angerProneness','fearProneness','shameProneness',
    'curiosityProneness','disgustSensitivity','respectSensitivity',
];

const DEFAULT_SETTINGS = {
    enabled: true,
    injectRuntime: true,
    injectionDepth: 0,
    maxEdgesInjected: 8,
    autoInitialize: true,
    hideControlBlocks: true,
    showToasts: true,
    debugProtocolInPrompt: false,
};

let initialized = false;
let generationActive = false;

function ctx() {
    return window.SillyTavern?.getContext?.();
}

function nowIso() {
    return new Date().toISOString();
}

function clone(x) {
    return x === undefined ? undefined : structuredClone(x);
}

function fastFingerprint(text) {
    const s = String(text ?? '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return `${s.length}:${(h >>> 0).toString(16)}`;
}

function latestAssistantMessageId() {
    const chat = ctx()?.chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system) return i;
    }
    return -1;
}

function currentSwipeKey(msg) {
    const id = Number(msg?.swipe_id);
    return Number.isFinite(id) ? String(id) : '0';
}

function toast(type, message) {
    if (!getSettings().showToasts) return;
    const t = window.toastr;
    if (t?.[type]) t[type](message, 'Psychology Engine');
    else console.log(`[Psychology Engine] ${message}`);
}

function getSettings() {
    const c = ctx();
    const bucket = c?.extensionSettings ?? window.extension_settings ?? {};
    if (!bucket[SETTINGS_KEY]) bucket[SETTINGS_KEY] = structuredClone(DEFAULT_SETTINGS);
    for (const [k,v] of Object.entries(DEFAULT_SETTINGS)) {
        if (bucket[SETTINGS_KEY][k] === undefined) bucket[SETTINGS_KEY][k] = v;
    }
    return bucket[SETTINGS_KEY];
}

function saveSettings() {
    const c = ctx();
    if (c?.saveSettingsDebounced) c.saveSettingsDebounced();
    else window.saveSettingsDebounced?.();
}

function newState() {
    return {
        schemaVersion: '0.3.3',
        cardContexts: {},
        actorRegistry: {},
        characters: {},
        relations: {},
        events: {},
        knowledge: {},
        storyTime: { label:'', elapsed:'', confidence:'low' },
        runtime: {
            lastProcessedMessageId: null,
            lastProcessedAt: null,
            lastControlRaw: null,
            lastControlParsed: null,
            lastControlError: null,
            initRetryReason: null,
        },
    };
}

function getState() {
    const c = ctx();
    if (!c?.chatMetadata) return newState();

    if (!c.chatMetadata[METADATA_KEY]) c.chatMetadata[METADATA_KEY] = newState();
    const s = c.chatMetadata[METADATA_KEY];

    s.schemaVersion = '0.3.3';
    s.cardContexts ??= {};
    s.actorRegistry ??= {};
    s.characters ??= {};
    s.relations ??= {};
    s.events ??= {};
    s.knowledge ??= {};
    s.storyTime ??= { label:'', elapsed:'', confidence:'low' };
    s.runtime ??= {};
    s.runtime.lastProcessedMessageId ??= null;
    s.runtime.lastProcessedAt ??= null;
    s.runtime.lastControlRaw ??= null;
    s.runtime.lastControlParsed ??= null;
    s.runtime.lastControlError ??= null;
    s.runtime.initRetryReason ??= null;
    s.runtime.lastRollback ??= null;

    return s;
}

function saveState() {
    const c = ctx();
    if (c?.saveMetadataDebounced) c.saveMetadataDebounced();
    else c?.saveChat?.();
}

function normName(x) {
    return String(x ?? '').trim();
}

function currentCharacterObject() {
    const c = ctx();
    if (!c) return null;

    const id = c.characterId ?? c.this_chid ?? window.this_chid;
    const chars = c.characters ?? window.characters;

    if (id !== undefined && id !== null && chars?.[id]) return chars[id];
    if (c.character && typeof c.character === 'object') return c.character;

    if (Array.isArray(chars) && c.name2) {
        return chars.find(ch => normName(ch?.name) === normName(c.name2)) ?? null;
    }

    return null;
}

function currentCharacterName() {
    return normName(currentCharacterObject()?.name || ctx()?.name2 || '');
}

function currentUserName() {
    return normName(ctx()?.name1 || 'user');
}

function ensureCardContext(cardName) {
    cardName = normName(cardName);
    if (!cardName) return null;

    const s = getState();
    s.cardContexts[cardName] ??= {
        name: cardName,
        isContainer: null,
        actorNames: [],
        updatedAt: null,
    };
    return s.cardContexts[cardName];
}

function isContainerName(name) {
    name = normName(name);
    if (!name) return false;
    return getState().cardContexts?.[name]?.isContainer === true;
}

function registerActor(name, source, evidence = '', sourceCard = '') {
    name = normName(name);
    source = String(source ?? '').trim();
    if (!name || !['character_card','world_info'].includes(source)) return null;
    if (isContainerName(name)) return null;

    const s = getState();
    s.actorRegistry[name] = {
        name,
        source,
        evidence: String(evidence ?? '').trim().slice(0, 600),
        sourceCard: normName(sourceCard),
        persistent: true,
        registeredAt: s.actorRegistry[name]?.registeredAt ?? nowIso(),
        updatedAt: nowIso(),
    };
    return s.actorRegistry[name];
}

function isEligibleActor(name) {
    name = normName(name);
    if (!name || isContainerName(name)) return false;
    return Boolean(getState().actorRegistry?.[name]?.persistent === true);
}

function eligibleActorNames() {
    return Object.values(getState().actorRegistry ?? {})
        .filter(x => x?.persistent === true)
        .map(x => normName(x.name))
        .filter(Boolean);
}

function actorRegistryForPrompt() {
    return eligibleActorNames().map(name => {
        const reg = getState().actorRegistry[name];
        return {
            name,
            source: reg.source,
            sourceCard: reg.sourceCard || undefined,
        };
    });
}

function confirmedActorNames() {
    const user = currentUserName();
    return Object.values(getState().characters ?? {})
        .filter(ch =>
            ch?.profileStatus === 'confirmed' &&
            ch?.psychologyProfile &&
            normName(ch.id) !== user &&
            isEligibleActor(ch.id)
        )
        .map(ch => normName(ch.id))
        .filter(Boolean);
}

function uninitializedActorNames() {
    const user = currentUserName();
    return eligibleActorNames()
        .filter(name => name !== user)
        .filter(name => getState().characters?.[name]?.profileStatus !== 'confirmed');
}

function actorProfilesForPrompt() {
    const s = getState();
    return confirmedActorNames().map(name => {
        const ch = s.characters[name];
        return {
            character: name,
            sourceCards: ch?.sourceCards ?? [],
            personalityControl: ch?.psychologyProfile?.personalityControl ?? null,
            styleTraits: ch?.psychologyProfile?.styleTraits ?? null,
        };
    });
}

function purgeContainerIdentity(cardName) {
    cardName = normName(cardName);
    if (!cardName) return;

    const s = getState();

    // Remove the old v0.3.x pseudo-character if a card title/container had
    // previously been mistaken for a psychological actor.
    delete s.characters[cardName];
    delete s.knowledge[cardName];
    delete s.actorRegistry[cardName];

    for (const [key, edge] of Object.entries(s.relations ?? {})) {
        if (normName(edge?.observer) === cardName || normName(edge?.target) === cardName) {
            delete s.relations[key];
        }
    }

    for (const event of Object.values(s.events ?? {})) {
        if (Array.isArray(event?.knownBy)) {
            event.knownBy = event.knownBy.filter(n => normName(n) !== cardName);
        }
    }
}

function needsInitializationForContext(cardName) {
    const settings = getSettings();
    if (!settings.autoInitialize) return false;

    cardName = normName(cardName);
    if (!cardName) return false;

    const s = getState();
    const context = s.cardContexts?.[cardName];

    // New card context: let the main model decide whether this is a real
    // single actor card or only a container/title for multiple actors.
    if (!context) return true;

    // Known single-character card.
    if (context.isContainer === false) {
        if (!profileExists(cardName)) return true;
    }

    // Known container: every registered actor should eventually get a profile.
    if (context.isContainer === true) {
        if (!(context.actorNames ?? []).length) return true;
        if ((context.actorNames ?? []).some(name => !profileExists(name))) return true;
    }

    // New actors discovered dynamically by PSY_UPDATE need profiles too.
    if (uninitializedActorNames().length) return true;

    return false;
}

function ensureCharacter(name) {
    name = normName(name);
    if (!name) return null;

    const s = getState();
    s.characters[name] ??= {
        id: name,
        displayName: name,
        aliases: [],
        notes: '',
        profileStatus: 'uninitialized',
        psychologyProfile: null,
        createdAt: nowIso(),
    };
    return s.characters[name];
}

function profileExists(name = currentCharacterName()) {
    const ch = getState().characters?.[normName(name)];
    return Boolean(ch?.profileStatus === 'confirmed' && ch?.psychologyProfile);
}

function edgeKey(observer, target) {
    return `${normName(observer)}→${normName(target)}`;
}

function ensureEdge(observer, target) {
    observer = normName(observer);
    target = normName(target);
    if (!observer || !target || observer === target) return null;

    ensureCharacter(observer);
    ensureCharacter(target);

    const s = getState();
    const key = edgeKey(observer,target);

    s.relations[key] ??= {
        observer,
        target,
        status: 'uninitialized',
        core: {},
        derived: {},
        personalityControl: {},
        activeThreads: [],
        memories: [],
        lastUpdatedAt: null,
    };

    return s.relations[key];
}

function clamp100(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-100, Math.min(100, Math.round(n)));
}

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.5;
    return Math.max(0, Math.min(1, n));
}

function clampDelta(variable, value, kind) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;

    let cap = 20;
    if (kind === 'core') {
        if (LONG_RELATION_VARIABLES.has(variable)) cap = 12;
        else if (SHORT_STATE_VARIABLES.has(variable)) cap = 35;
    } else {
        cap = 25;
    }

    return Math.max(-cap, Math.min(cap, Math.round(n)));
}

function semanticBand(value) {
    const n = Number(value) || 0;
    const a = Math.abs(n);
    const sign = n < 0 ? 'negative' : n > 0 ? 'positive' : 'neutral';

    let strength = 'neutral';
    if (a <= 10) strength = 'neutral';
    else if (a <= 25) strength = 'mild';
    else if (a <= 40) strength = 'noticeable';
    else if (a <= 55) strength = 'moderate';
    else if (a <= 70) strength = 'strong';
    else if (a <= 85) strength = 'very_strong';
    else if (a <= 95) strength = 'extreme';
    else strength = 'limit';

    return `${sign}:${strength}`;
}

function defaultCoreParameter(variable, pc, traits) {
    const sc = pc.SelfControl ?? 0.5;
    const vt = pc.VulnerabilityTolerance ?? 0.5;
    const trait = (name, fallback=0.5) => Number(traits?.[name] ?? fallback);

    let normalMin = -75;
    let normalMax = 75;
    let positiveSensitivity = 0.5;
    let negativeSensitivity = 0.5;
    let expression = 0.5;
    let awareness = 0.6;

    if (variable === 'Dependency') {
        normalMin = -95 + Math.round(35 * trait('dependencyProneness'));
        normalMax = 25 + Math.round(55 * trait('dependencyProneness'));
        expression = Math.max(0.15, vt * 0.8);
    } else if (variable === 'Anger') {
        normalMin = -90;
        normalMax = 35 + Math.round(55 * trait('angerProneness'));
        expression = Math.max(0.1, (1 - sc) * 0.65 + 0.15);
    } else if (variable === 'Fear') {
        normalMin = -90;
        normalMax = 35 + Math.round(55 * trait('fearProneness'));
    } else if (variable === 'Shyness') {
        normalMin = -90;
        normalMax = 35 + Math.round(50 * trait('shameProneness'));
        expression = Math.max(0.15, vt * 0.6);
    } else if (variable === 'Disgust') {
        normalMin = -80;
        normalMax = 35 + Math.round(55 * trait('disgustSensitivity'));
    } else if (variable === 'Respect') {
        normalMin = -90;
        normalMax = 95;
        positiveSensitivity = 0.25 + 0.5 * trait('respectSensitivity');
    } else if (variable === 'Love') {
        normalMin = -80;
        normalMax = 70 + Math.round(25 * trait('romanticExpressiveness'));
        positiveSensitivity = 0.25 + 0.35 * trait('romanticExpressiveness');
    } else if (variable === 'Exclusivity') {
        normalMin = -85;
        normalMax = 35 + Math.round(55 * trait('jealousyProneness'));
    }

    return {
        normal_min: clamp100(normalMin),
        normal_max: clamp100(normalMax),
        absolute_min: -100,
        absolute_max: 100,
        positive_sensitivity: clamp01(positiveSensitivity),
        negative_sensitivity: clamp01(negativeSensitivity),
        expression: clamp01(expression),
        awareness: clamp01(awareness),
    };
}

function defaultDerivedParameter(variable, pc, traits) {
    const vt = pc.VulnerabilityTolerance ?? 0.5;
    const trait = (name, fallback=0.5) => Number(traits?.[name] ?? fallback);

    let normalMin = -75;
    let normalMax = 75;
    let trigger = 35;
    let expression = 0.5;

    if (variable === 'AffectionSeeking') {
        normalMin = -90;
        normalMax = 20 + Math.round(
            50 * trait('romanticExpressiveness') +
            25 * trait('dependencyProneness')
        );
        trigger = 35 + Math.round((1 - vt) * 20);
        expression = Math.max(0.1, vt * 0.8);
    } else if (variable === 'Jealousy') {
        normalMin = -90;
        normalMax = 25 + Math.round(65 * trait('jealousyProneness'));
    } else if (variable === 'Shame') {
        normalMin = -90;
        normalMax = 25 + Math.round(65 * trait('shameProneness'));
    } else if (variable === 'Curiosity') {
        normalMin = -80;
        normalMax = 35 + Math.round(60 * trait('curiosityProneness'));
    } else if (variable === 'Attraction') {
        normalMin = -90;
        normalMax = 45 + Math.round(50 * trait('romanticExpressiveness'));
    }

    return {
        normal_min: clamp100(normalMin),
        normal_max: clamp100(normalMax),
        absolute_min: -100,
        absolute_max: 100,
        trigger_threshold: clamp100(trigger),
        expression: clamp01(expression),
        awareness: 0.6,
    };
}

function detectBinaryCollapse(values) {
    if (!values || typeof values !== 'object') {
        return { collapsed:false, numericCount:0, binaryLikeCount:0, ratio:0 };
    }

    const nums = Object.values(values)
        .filter(v => v !== null && v !== undefined && Number.isFinite(Number(v)))
        .map(Number);

    if (nums.length < 8) {
        return { collapsed:false, numericCount:nums.length, binaryLikeCount:0, ratio:0 };
    }

    const binaryLikeCount = nums.filter(v => v === -1 || v === 0 || v === 1).length;
    const ratio = binaryLikeCount / nums.length;

    return {
        collapsed: ratio >= 0.70,
        numericCount: nums.length,
        binaryLikeCount,
        ratio,
    };
}

function parseJsonTolerant(text) {
    if (text && typeof text === 'object') return text;

    let s = String(text ?? '').trim();
    if (!s) throw new Error('empty JSON block');

    const fence = s.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();

    s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');
    s = s.replace(/,\s*([}\]])/g, '$1');
    s = s.replace(/\bNone\b/g, 'null')
         .replace(/\bTrue\b/g, 'true')
         .replace(/\bFalse\b/g, 'false');

    const attempts = [s];

    // simple JS-like key quoting fallback
    attempts.push(
        s.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)(\s*:)/g, '$1"$2"$3')
    );

    let last = null;
    for (const attempt of attempts) {
        try { return JSON.parse(attempt); }
        catch (err) { last = err; }
    }
    throw last ?? new Error('invalid JSON');
}

function profileFromInitPayload(payload, charName, userName, sourceCard = '') {
    if (!payload || typeof payload !== 'object') throw new Error('PSY_INIT profile payload missing');

    const actorName = normName(payload.character || charName);
    if (!actorName) throw new Error('PSY_INIT profile missing character name');

    const personalityControl = {};
    for (const k of PERSONALITY_CONTROL) {
        const v = payload?.personalityControl?.[k];
        if (v === undefined || v === null || !Number.isFinite(Number(v))) {
            throw new Error(`PSY_INIT ${actorName} missing personalityControl.${k}`);
        }
        personalityControl[k] = clamp01(v);
    }

    const styleTraits = {};
    for (const k of STYLE_TRAITS) {
        const v = payload?.styleTraits?.[k];
        if (v === undefined || v === null || !Number.isFinite(Number(v))) {
            throw new Error(`PSY_INIT ${actorName} missing styleTraits.${k}`);
        }
        styleTraits[k] = clamp01(v);
    }

    const evidenceSummary = Array.isArray(payload.evidenceSummary)
        ? payload.evidenceSummary.map(String).filter(Boolean).slice(0,20)
        : [];

    if (!evidenceSummary.length) {
        throw new Error(`PSY_INIT ${actorName} evidenceSummary is empty`);
    }

    const profile = {
        version: '0.3.3',
        character: actorName,
        sourceCard: normName(sourceCard),
        evidenceSummary,
        personalityControl,
        styleTraits,
        coreParameters: {},
        derivedParameters: {},
        initialRelations: [],
        generatedAt: nowIso(),
    };

    for (const k of CORE_VARIABLES) {
        profile.coreParameters[k] = defaultCoreParameter(k, personalityControl, styleTraits);
    }
    for (const k of DERIVED_VARIABLES) {
        profile.derivedParameters[k] = defaultDerivedParameter(k, personalityControl, styleTraits);
    }

    const relationInputs = Array.isArray(payload.initialRelations)
        ? payload.initialRelations
        : payload.initialRelation
            ? [payload.initialRelation]
            : [];

    for (const relationInput of relationInputs.slice(0, 8)) {
        const target = normName(relationInput?.target || '');
        if (!target || target === actorName) continue;

        const values = relationInput?.values ?? {};
        const collapse = detectBinaryCollapse(values);
        if (collapse.collapsed) {
            const err = new Error(
                `PSY_INIT ${actorName}→${target} looks binary: ` +
                `${collapse.binaryLikeCount}/${collapse.numericCount} values are -1/0/1`
            );
            err.binaryCollapse = collapse;
            throw err;
        }

        const rel = {
            target,
            status: 'initialized',
            evidence: Array.isArray(relationInput?.evidence)
                ? relationInput.evidence.map(String).filter(Boolean).slice(0,12)
                : [],
            core: {},
            derived: {},
        };

        for (const [k,v] of Object.entries(values)) {
            if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
            if (CORE_VARIABLES.includes(k)) rel.core[k] = clamp100(v);
            if (DERIVED_VARIABLES.includes(k)) rel.derived[k] = clamp100(v);
        }

        if (!Object.keys(rel.core).length && !Object.keys(rel.derived).length) {
            rel.status = 'uninitialized';
        }

        profile.initialRelations.push(rel);
    }

    return profile;
}

function parseInitBundle(payload, cardName, userName) {
    if (!payload || typeof payload !== 'object') throw new Error('PSY_INIT payload missing');

    cardName = normName(cardName);
    const rawProfiles = Array.isArray(payload.profiles) ? payload.profiles : [payload];
    if (!rawProfiles.length) throw new Error('PSY_INIT profiles is empty');

    const explicitContainer = typeof payload.cardIsContainer === 'boolean' ? payload.cardIsContainer : null;
    const profileNames = rawProfiles.map(p => normName(p?.character)).filter(Boolean);
    const inferredContainer = explicitContainer !== null
        ? explicitContainer
        : Boolean(cardName && profileNames.length && profileNames.every(name => name !== cardName));

    let usableProfiles = rawProfiles;
    if (inferredContainer && cardName) {
        usableProfiles = rawProfiles.filter(p => normName(p?.character) !== cardName);
    }
    if (!usableProfiles.length) throw new Error('PSY_INIT contains no usable real actor profiles');

    const profiles = [];
    const registrations = [];

    for (const p of usableProfiles.slice(0, 8)) {
        const actorName = normName(p?.character);
        if (!actorName) continue;

        const eligibility = p?.eligibility ?? {};
        const source = String(eligibility?.source ?? '').trim();
        const evidence = String(eligibility?.evidence ?? '').trim();

        if (!['character_card','world_info'].includes(source) || !evidence) {
            console.warn('[Psychology Engine] skipped transient/ineligible actor', actorName, p);
            continue;
        }
        if (inferredContainer && actorName === cardName) continue;

        profiles.push(profileFromInitPayload(p, actorName, userName, cardName));
        registrations.push({ name: actorName, source, evidence, sourceCard: cardName });
    }

    if (!profiles.length) throw new Error('PSY_INIT did not contain any eligible persistent actor profiles');

    return {
        cardContext: cardName,
        cardIsContainer: inferredContainer,
        profiles,
        registrations,
    };
}

function applyInitBundle(bundle) {
    const cardName = normName(bundle?.cardContext);
    const profiles = Array.isArray(bundle?.profiles) ? bundle.profiles : [];
    const registrations = Array.isArray(bundle?.registrations) ? bundle.registrations : [];

    if (cardName) {
        const context = ensureCardContext(cardName);
        context.isContainer = Boolean(bundle.cardIsContainer);
        context.actorNames = [...new Set(profiles.map(p => normName(p.character)).filter(Boolean))];
        context.updatedAt = nowIso();
        if (context.isContainer) purgeContainerIdentity(cardName);
    }

    for (const reg of registrations) {
        registerActor(reg.name, reg.source, reg.evidence, reg.sourceCard);
    }
    for (const profile of profiles) {
        if (isEligibleActor(profile.character)) applyProfile(profile, cardName);
    }
}

function applyProfile(profile, sourceCard = '') {
    const s = getState();
    const name = normName(profile.character);
    const ch = ensureCharacter(name);

    ch.psychologyProfile = profile;
    ch.profileStatus = 'confirmed';
    ch.personalityControl = clone(profile.personalityControl);
    ch.profileConfirmedAt = nowIso();
    ch.sourceCards ??= [];

    const card = normName(sourceCard || profile.sourceCard);
    if (card && !ch.sourceCards.includes(card)) ch.sourceCards.push(card);

    for (const rel of profile.initialRelations ?? []) {
        const edge = ensureEdge(name, rel.target);
        if (!edge) continue;

        edge.status = rel.status;
        edge.personalityControl = clone(profile.personalityControl);

        for (const [k,v] of Object.entries(rel.core ?? {})) {
            if (CORE_VARIABLES.includes(k)) edge.core[k] = clamp100(v);
        }
        for (const [k,v] of Object.entries(rel.derived ?? {})) {
            if (DERIVED_VARIABLES.includes(k)) edge.derived[k] = clamp100(v);
        }

        if (rel.evidence?.length) {
            edge.memories.push({
                type:'initialization_evidence',
                text: rel.evidence.join('；'),
                at: nowIso(),
            });
        }

        edge.lastUpdatedAt = nowIso();
    }
}

function activeNamesFromRecentChat() {
    const c = ctx();
    const names = new Set();
    const user = currentUserName();
    if (user) names.add(user);

    for (const m of (c?.chat ?? []).slice(-10)) {
        const name = normName(m?.name);
        if (name && isEligibleActor(name)) names.add(name);
    }
    for (const name of eligibleActorNames()) names.add(name);
    return [...names].filter(Boolean);
}

function relevantEdges() {
    const s = getState();
    const active = new Set(activeNamesFromRecentChat());
    const user = currentUserName();

    return Object.values(s.relations)
        .filter(e => e.status !== 'uninitialized')
        .filter(e => isEligibleActor(e.observer))
        .filter(e => e.target === user || isEligibleActor(e.target))
        .filter(e => active.has(e.observer) || active.has(e.target) || e.target === user)
        .sort((a,b) => String(b.lastUpdatedAt ?? '').localeCompare(String(a.lastUpdatedAt ?? '')))
        .slice(0, Math.max(1, Number(getSettings().maxEdgesInjected) || 8));
}

function relationForPrompt(edge) {
    const core = {};
    const derived = {};

    for (const [k,v] of Object.entries(edge.core ?? {})) {
        core[k] = { value:v, band:semanticBand(v) };
    }
    for (const [k,v] of Object.entries(edge.derived ?? {})) {
        derived[k] = { value:v, band:semanticBand(v) };
    }

    return {
        observer: edge.observer,
        target: edge.target,
        core,
        derived,
        activeThreads: (edge.activeThreads ?? []).slice(-5),
        memories: (edge.memories ?? []).slice(-3),
    };
}

function buildProtocolPrompt() {
    const settings = getSettings();
    if (!settings.enabled || !settings.injectRuntime) return '';

    const cardName = currentCharacterName();
    const user = currentUserName();
    if (!cardName) return '';

    const state = getState();
    const cardContext = state.cardContexts?.[cardName] ?? null;
    const pendingActors = uninitializedActorNames();
    const needsInit = needsInitializationForContext(cardName);

    const runtime = {
        cardContext: {
            name: cardName,
            isContainer: cardContext?.isContainer ?? 'unknown',
            knownActors: cardContext?.actorNames ?? [],
        },
        user,
        actorRegistry: actorRegistryForPrompt(),
        actorProfiles: actorProfilesForPrompt(),
        uninitializedActors: pendingActors,
        relations: relevantEdges().map(relationForPrompt),
    };

    const initRetry = state.runtime.initRetryReason
        ? `Previous initialization was rejected: ${state.runtime.initRetryReason}. Recreate PSY_INIT carefully.`
        : '';

    const initInstruction = needsInit ? `
ACTOR INITIALIZATION IS REQUIRED.

IDENTITY RULE — VERY IMPORTANT:
"${cardName}" is the SillyTavern CARD CONTEXT NAME.
A card context name is NOT automatically a psychological character.

First determine:
- If "${cardName}" is the name of ONE actual person/character, set "cardIsContainer": false.
- If "${cardName}" is a work title, scenario title, group title, family title,
  multi-character card title, narrator/container label, or otherwise not a real
  person in the story, set "cardIsContainer": true.

When cardIsContainer=true:
- NEVER create a profile whose character name is "${cardName}".
- NEVER use "${cardName}" as observer/target/knownBy.
- Use the individual real character names instead.

PERSISTENT ACTOR ELIGIBILITY GATE:

A person appearing in prose is NOT automatically a persistent psychology actor.

Only create a persistent profile if:
1. source = "character_card": the person is a principal/main character explicitly
   defined by the current character card/scenario data; OR
2. source = "world_info": the person is an explicitly defined named recurring
   character in currently available World Info / lore context.

DO NOT register generic or incidental NPCs such as shop clerks, guards, teachers,
servants, doctors, passers-by, drivers, unnamed enemies, or one-scene roles merely
because they appear in the current scene.

Transient NPCs may participate in events, but must not receive persistent Profile
or relation edges.

Prefer only 1–4 newly eligible actors per response. Do not initialize a huge cast.

Already registered persistent actors are listed in Current runtime.actorRegistry.
Do not duplicate them.

In this SAME normal roleplay response, after the visible RP prose, append:

<!--PSY_INIT
{STRICT_JSON}
/PSY_INIT-->

Use this shape:
{
  "cardContext": "${cardName}",
  "cardIsContainer": true,
  "profiles": [
    {
      "character": "REAL INDIVIDUAL CHARACTER NAME",
      "eligibility": {
        "source": "character_card|world_info",
        "evidence": "brief reason this is a principal card character or explicit recurring World Info character"
      },
      "evidenceSummary": [
        "1-4 concise stable-personality observations supported by card/scenario"
      ],
      "personalityControl": {
        "SelfControl": 0.0,
        "Assertiveness": 0.0,
        "VulnerabilityTolerance": 0.0,
        "PrivacyBias": 0.0,
        "Empathy": 0.0,
        "CognitiveFlexibility": 0.0,
        "NeedForControl": 0.0
      },
      "styleTraits": {
        "warmth": 0.0,
        "sociability": 0.0,
        "romanticExpressiveness": 0.0,
        "jealousyProneness": 0.0,
        "dependencyProneness": 0.0,
        "angerProneness": 0.0,
        "fearProneness": 0.0,
        "shameProneness": 0.0,
        "curiosityProneness": 0.0,
        "disgustSensitivity": 0.0,
        "respectSensitivity": 0.0
      },
      "initialRelations": [
        {
          "target": "${user}",
          "evidence": ["0-4 relation-specific reasons"],
          "values": {
            "Love": 75,
            "Trust": 60,
            "Respect": 55
          }
        },
        {
          "target": "ANOTHER REAL ACTOR",
          "evidence": ["only when an established relation is actually supported"],
          "values": {
            "Trust": 45,
            "Intimacy": 50
          }
        }
      ]
    }
  ]
}

Initialization rules:
- PersonalityControl/styleTraits use [0,1].
- Relationship values use the FULL [-100,100] intensity scale.
- -100 extreme negative; -75 strong negative; -50 clear negative; -25 mild negative.
- 0 genuinely neutral; +25 mild positive; +50 moderate; +75 strong; +90 very strong.
- 1 is NOT "true"; 1 means almost neutral.
- Every profile MUST include eligibility.source and eligibility.evidence.
- eligibility.source may ONLY be "character_card" or "world_info".
- Incidental/transient NPCs must NOT appear in profiles.
- Relationship "values" should be SPARSE: include only variables supported by evidence.
- Omitted variable = insufficient information.
- Do not create every possible pair in a multi-person scene.
- Established actor→actor relationships may be initialized when directly supported.
- Do not use the user's latest message as evidence for stable personality.
${initRetry}
` : `
No PSY_INIT is required unless a genuinely new real actor appears who is not
listed in runtime.actorProfiles. If that happens, you MAY append a PSY_INIT
block using the same multi-profile format, containing only the new actor(s).
`;

    return `
[Psychology Engine — SINGLE-PASS MULTI-ACTOR RUNTIME]

This instruction is part of the SAME main SillyTavern generation.
Use the current main API, model, preset, sampling settings, and normal RP context.

IDENTITY MODEL:
Card Context != Actor.
The card context name may only be a container/title.
Psychological variables belong to REAL INDIVIDUAL ACTORS.

The psychology states below are authoritative CURRENT internal states.
Character card/personality determines HOW an actor expresses a state.
Dynamic psychology state determines WHAT that actor currently feels.
Do not erase strong current states merely to preserve a static stereotype.

Do not expose psychology numbers, engine terminology, or control JSON in visible RP prose.
Do not mechanically map a value to a fixed gesture.
Infer behavior from:
state + personality + relationship + scene + social context + recent behavior.

Current runtime:
${JSON.stringify(runtime, null, 2)}

${initInstruction}

AFTER the normal visible RP prose, ALWAYS append one invisible HTML comment:

<!--PSY_UPDATE
{STRICT_JSON}
/PSY_UPDATE-->

Use this compact shape:
{
  "events": [
    {
      "id": "e1",
      "summary": "short objective event",
      "knownBy": ["REAL ACTOR NAME"]
    }
  ],
  "updates": [
    {
      "observer": "REAL ACTOR WHOSE PSYCHOLOGY CHANGES",
      "target": "REAL PERSON/TARGET",
      "basedOn": ["e1"],
      "coreDelta": {"Trust": 1},
      "derivedDelta": {"Curiosity": 2},
      "reason": "short reason",
      "addThreads": [],
      "resolveThreads": [],
      "memories": []
    }
  ]
}

PSY_UPDATE rules:
- observer MUST be a REGISTERED persistent actor from runtime.actorRegistry.
- target MUST be either the user or a REGISTERED persistent actor.
- Transient NPCs may appear in event summaries/knownBy, but must NOT be observer/target of persistent updates.
- Card/group/scenario titles must never be observer/target.
- In multi-character cards, evaluate EACH actor independently.
- A single event may update A→user and B→user differently.
- Actor→actor updates are allowed when the event genuinely changes that relationship.
- No Knowledge => No Update.
- Narrator knowledge is NOT character knowledge.
- Do not infer the user's hidden feelings; normally do NOT use the user as observer.
- Relationships are directed: A→B != B→A.
- Only include psychologically meaningful updates.
- Ordinary long-term relationship deltas are usually 0 to ±3.
- Short emotional deltas may be larger when justified.
- Do not update every variable.
- Love != Trust != Respect != Attraction != Admiration.
- High Love does not automatically mean Jealousy or AffectionSeeking.
- Delta +1 means a TINY increase, not boolean true.
- If no meaningful psychological change occurred, use "updates": [].
- Keep the control block concise.
`.trim();
}

async function refreshInjection() {
    const c = ctx();
    if (!c?.setExtensionPrompt) return;

    const content = buildProtocolPrompt();
    const settings = getSettings();

    try {
        await c.setExtensionPrompt(
            PROMPT_ID,
            settings.enabled && settings.injectRuntime ? content : '',
            1,
            Math.max(0, Number(settings.injectionDepth) || 0),
            false,
            0
        );
    } catch (err) {
        console.error('[Psychology Engine] injection failed', err);
    }
}

const INIT_COMMENT_RE = /<!--\s*PSY_INIT\s*([\s\S]*?)\s*\/PSY_INIT\s*-->/i;
const UPDATE_COMMENT_RE = /<!--\s*PSY_UPDATE\s*([\s\S]*?)\s*\/PSY_UPDATE\s*-->/i;

// Fallback if a model outputs visible XML-like tags despite the instruction.
const INIT_TAG_RE = /<PSY_INIT>\s*([\s\S]*?)\s*<\/PSY_INIT>/i;
const UPDATE_TAG_RE = /<PSY_UPDATE>\s*([\s\S]*?)\s*<\/PSY_UPDATE>/i;

function extractControlBlock(text, kind) {
    const s = String(text ?? '');
    const re = kind === 'init' ? INIT_COMMENT_RE : UPDATE_COMMENT_RE;
    const fallback = kind === 'init' ? INIT_TAG_RE : UPDATE_TAG_RE;

    const m = s.match(re) ?? s.match(fallback);
    if (!m) return null;

    return {
        raw: m[0],
        jsonText: m[1].trim(),
    };
}

function stripControlBlocks(text) {
    return String(text ?? '')
        .replace(INIT_COMMENT_RE, '')
        .replace(UPDATE_COMMENT_RE, '')
        .replace(INIT_TAG_RE, '')
        .replace(UPDATE_TAG_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}

function eventKey(messageId, eventId) {
    return `m${messageId}:${String(eventId || 'e')}`;
}

function applyUpdatePayload(payload, messageId) {
    if (!payload || typeof payload !== 'object') throw new Error('PSY_UPDATE payload missing');

    const s = getState();
    const eventMap = new Map();

    for (const e of payload.events ?? []) {
        const id = eventKey(messageId, e?.id);
        const knownBy = Array.isArray(e?.knownBy)
            ? e.knownBy
                .map(normName)
                .filter(Boolean)
                .filter(name => !isContainerName(name))
            : [];

        const record = {
            id,
            summary: String(e?.summary ?? ''),
            knownBy,
            createdAt: nowIso(),
            messageId,
        };

        s.events[id] = record;
        eventMap.set(String(e?.id), record);

        for (const name of knownBy) {
            ensureCharacter(name);
            s.knowledge[name] ??= {};
            s.knowledge[name][id] = {
                known: true,
                source: 'single_pass',
                certainty: 1,
                learnedAt: nowIso(),
            };
        }
    }

    for (const u of payload.updates ?? []) {
        const observer = normName(u?.observer);
        const target = normName(u?.target);

        if (!observer || !target || observer === target) continue;

        // Persistent psychology belongs only to registered eligible actors.
        if (!isEligibleActor(observer)) {
            console.warn('[Psychology Engine] Actor Eligibility Gate blocked observer', observer, u);
            continue;
        }

        const user = currentUserName();
        if (target !== user && !isEligibleActor(target)) {
            console.warn('[Psychology Engine] Actor Eligibility Gate blocked target', target, u);
            continue;
        }

        if (observer === user) {
            console.warn('[Psychology Engine] ignored user-as-observer update', u);
            continue;
        }

        const basis = Array.isArray(u?.basedOn) ? u.basedOn.map(String) : [];
        if (!basis.length) {
            console.warn('[Psychology Engine] ignored update without event basis', u);
            continue;
        }

        const knowledgeInvalid = basis.some(localId => {
            const ev = eventMap.get(localId);
            return !ev || !ev.knownBy.includes(observer);
        });

        if (knowledgeInvalid) {
            console.warn('[Psychology Engine] Knowledge Gate blocked update', u);
            continue;
        }

        const coreKeys = Object.keys(u?.coreDelta ?? {}).filter(k => CORE_VARIABLES.includes(k));
        const derivedKeys = Object.keys(u?.derivedDelta ?? {}).filter(k => DERIVED_VARIABLES.includes(k));

        // Pathology guard: sparse updates only.
        if (coreKeys.length > 8 || derivedKeys.length > 6) {
            console.warn('[Psychology Engine] rejected blanket update', u);
            continue;
        }

        const edge = ensureEdge(observer,target);
        if (!edge) continue;
        edge.status = 'active';

        for (const k of coreKeys) {
            const delta = clampDelta(k, u.coreDelta[k], 'core');
            const base = Number.isFinite(Number(edge.core[k])) ? Number(edge.core[k]) : 0;
            edge.core[k] = clamp100(base + delta);
        }

        for (const k of derivedKeys) {
            const delta = clampDelta(k, u.derivedDelta[k], 'derived');
            const base = Number.isFinite(Number(edge.derived[k])) ? Number(edge.derived[k]) : 0;
            edge.derived[k] = clamp100(base + delta);
        }

        for (const t of u?.addThreads ?? []) {
            const x = String(t).trim();
            if (x && !edge.activeThreads.includes(x)) edge.activeThreads.push(x);
        }

        for (const t of u?.resolveThreads ?? []) {
            const x = String(t).trim();
            edge.activeThreads = edge.activeThreads.filter(v => v !== x);
        }

        for (const m of u?.memories ?? []) {
            const x = String(m).trim();
            if (x) edge.memories.push({
                text: x,
                at: nowIso(),
                reason: String(u?.reason ?? ''),
            });
        }

        edge.activeThreads = edge.activeThreads.slice(-20);
        edge.memories = edge.memories.slice(-50);
        edge.lastUpdatedAt = nowIso();
    }
}


function getMessageMeta(msg) {
    msg.extra ??= {};
    msg.extra[MSG_META_KEY] ??= {
        fingerprint: null,
        visibleFingerprint: null,
        processedAt: null,
        errors: [],
        appliedSwipeKey: null,
        swipeCache: {},
        transaction: null,
    };

    const meta = msg.extra[MSG_META_KEY];
    meta.swipeCache ??= {};
    return meta;
}

function compactOldTransactions(keepMessageId) {
    const chat = ctx()?.chat ?? [];
    for (let i = 0; i < chat.length; i++) {
        if (i === keepMessageId) continue;
        const meta = chat[i]?.extra?.[MSG_META_KEY];
        if (!meta?.transaction?.beforeState) continue;

        // v0.3.1 deliberately supports exact rollback only for the latest
        // assistant response. Remove historical full snapshots to prevent
        // chat-file growth.
        meta.transaction = {
            finalizedAt: nowIso(),
            rollbackAvailable: false,
        };
    }
}

async function rollbackMessageTransaction(messageId, { silent = false } = {}) {
    const c = ctx();
    const id = Number(messageId);
    const msg = c?.chat?.[id];
    if (!msg || msg.is_user || msg.is_system) return false;

    if (id !== latestAssistantMessageId()) {
        if (!silent) {
            toast('warning', 'v0.3.1 只对最新一条 AI 回复提供精确 rollback；历史消息暂不回退。');
        }
        return false;
    }

    const meta = getMessageMeta(msg);
    const beforeState = meta?.transaction?.beforeState;

    if (!beforeState) return false;

    c.chatMetadata[METADATA_KEY] = clone(beforeState);

    const restored = getState();
    restored.runtime.lastRollback = {
        messageId: id,
        swipeKey: meta.appliedSwipeKey,
        at: nowIso(),
    };

    // Keep the per-swipe cache, but clear "currently applied" markers.
    meta.transaction = null;
    meta.fingerprint = null;
    meta.visibleFingerprint = null;
    meta.appliedSwipeKey = null;
    meta.processedAt = null;
    meta.errors = [];

    saveState();
    await c?.saveChat?.();

    renderStatus();
    renderStateViewer();
    renderDebug();

    if (!silent) toast('info', '已回退上一条 AI 回复造成的心理状态变化。');
    return true;
}

function cachedControlForSwipe(meta, swipeKey, visibleFingerprint) {
    const cached = meta?.swipeCache?.[swipeKey];
    if (!cached) return null;
    if (cached.visibleFingerprint !== visibleFingerprint) return null;
    return cached;
}

async function processAssistantMessage(messageId) {
    const c = ctx();

    let id = Number(messageId);
    if (!Number.isInteger(id) || !c?.chat?.[id]) id = (c?.chat?.length ?? 1) - 1;

    const msg = c?.chat?.[id];
    if (!msg || msg.is_user || msg.is_system) return;

    const meta = getMessageMeta(msg);
    const swipeKey = currentSwipeKey(msg);
    const text = String(msg.mes ?? '');

    const initBlock = extractControlBlock(text, 'init');
    const updateBlock = extractControlBlock(text, 'update');
    const visibleText = stripControlBlocks(text);
    const visibleFingerprint = fastFingerprint(visibleText);

    const rawControlFingerprint = fastFingerprint(
        `${initBlock?.jsonText ?? ''}\n---\n${updateBlock?.jsonText ?? ''}`
    );

    // If this exact selected swipe has already been applied and the message is
    // simply being rendered/saved again after our own block stripping, do nothing.
    if (
        meta.appliedSwipeKey === swipeKey &&
        meta.visibleFingerprint === visibleFingerprint &&
        (
            (!initBlock && !updateBlock) ||
            meta.fingerprint === rawControlFingerprint
        )
    ) {
        return;
    }

    // If a different version of the latest assistant message is about to be
    // applied and the old version still owns an active transaction, restore the
    // exact pre-message state first.
    if (meta?.transaction?.beforeState && id === latestAssistantMessageId()) {
        await rollbackMessageTransaction(id, { silent: true });
    }

    const freshMeta = getMessageMeta(msg);
    const cached = cachedControlForSwipe(freshMeta, swipeKey, visibleFingerprint);

    let initPayload = null;
    let updatePayload = null;
    let initRaw = initBlock?.jsonText ?? null;
    let updateRaw = updateBlock?.jsonText ?? null;

    const debug = {
        messageId: id,
        swipeKey,
        at: nowIso(),
        source: {
            init: initBlock ? 'message' : cached?.initParsed ? 'swipe-cache' : null,
            update: updateBlock ? 'message' : cached?.updateParsed ? 'swipe-cache' : null,
        },
        initRaw,
        updateRaw,
        initParsed: null,
        updateParsed: null,
        errors: [],
        rollbackSnapshotSaved: false,
    };

    // Prefer control blocks physically present in the selected swipe.
    // If SillyTavern previously persisted our stripped visible text, reuse the
    // cached parsed control block for this exact swipe/visible-text pair.
    try {
        if (initBlock) initPayload = parseJsonTolerant(initBlock.jsonText);
        else if (cached?.initParsed) initPayload = clone(cached.initParsed);

        if (updateBlock) updatePayload = parseJsonTolerant(updateBlock.jsonText);
        else if (cached?.updateParsed) updatePayload = clone(cached.updateParsed);
    } catch (err) {
        debug.errors.push(`CONTROL JSON: ${String(err?.message ?? err)}`);
    }

    debug.initParsed = initPayload;
    debug.updateParsed = updatePayload;

    const hasUsableControl = Boolean(initPayload || updatePayload);

    // No control data for this selected swipe: after a reroll, the previous
    // transaction remains rolled back and this swipe contributes no state change.
    if (!hasUsableControl) {
        const state = getState();
        state.runtime.lastProcessedMessageId = id;
        state.runtime.lastProcessedAt = nowIso();
        state.runtime.lastControlRaw = { init: initRaw, update: updateRaw };
        state.runtime.lastControlParsed = { init: null, update: null };
        state.runtime.lastControlError = debug.errors.length ? debug.errors : null;

        freshMeta.fingerprint = rawControlFingerprint;
        freshMeta.visibleFingerprint = visibleFingerprint;
        freshMeta.appliedSwipeKey = swipeKey;
        freshMeta.processedAt = nowIso();
        freshMeta.errors = debug.errors;
        freshMeta.transaction = null;

        saveState();
        await c?.saveChat?.();
        await refreshInjection();
        renderStatus();
        renderStateViewer();
        renderDebug();
        return;
    }

    // Full engine-state snapshot before this message. This is intentionally
    // simple and exact: clamp effects, Profile initialization, Events,
    // Knowledge, Threads and Memories all roll back together.
    const beforeState = clone(getState());

    // Apply initialization first so update deltas can build on initialized state.
    if (initPayload) {
        try {
            const cardName = currentCharacterName();
            const bundle = parseInitBundle(initPayload, cardName, currentUserName());

            applyInitBundle(bundle);
            getState().runtime.initRetryReason = null;
        } catch (err) {
            const reason = String(err?.message ?? err);
            debug.errors.push(`PSY_INIT: ${reason}`);
            getState().runtime.initRetryReason = reason;
            console.error('[Psychology Engine] PSY_INIT rejected', err);
        }
    }

    if (updatePayload) {
        try {
            applyUpdatePayload(updatePayload, id);
        } catch (err) {
            const reason = String(err?.message ?? err);
            debug.errors.push(`PSY_UPDATE: ${reason}`);
            console.error('[Psychology Engine] PSY_UPDATE rejected', err);
        }
    }

    const state = getState();
    state.runtime.lastProcessedMessageId = id;
    state.runtime.lastProcessedAt = nowIso();
    state.runtime.lastControlRaw = {
        init: initRaw,
        update: updateRaw,
    };
    state.runtime.lastControlParsed = {
        init: initPayload,
        update: updatePayload,
    };
    state.runtime.lastControlError = debug.errors.length ? debug.errors : null;

    freshMeta.fingerprint = rawControlFingerprint;
    freshMeta.visibleFingerprint = visibleFingerprint;
    freshMeta.appliedSwipeKey = swipeKey;
    freshMeta.processedAt = nowIso();
    freshMeta.errors = debug.errors;
    freshMeta.transaction = {
        beforeState,
        appliedAt: nowIso(),
        swipeKey,
        rollbackAvailable: true,
    };

    freshMeta.swipeCache[swipeKey] = {
        visibleFingerprint,
        initRaw,
        updateRaw,
        initParsed: clone(initPayload),
        updateParsed: clone(updatePayload),
        cachedAt: nowIso(),
    };

    debug.rollbackSnapshotSaved = true;

    if (getSettings().hideControlBlocks && (initBlock || updateBlock)) {
        msg.mes = visibleText;
    }

    compactOldTransactions(id);

    saveState();
    await c?.saveChat?.();
    await refreshInjection();

    renderStatus();
    renderStateViewer();
    renderDebug();

    if (debug.errors.length) {
        toast('warning', `控制块有 ${debug.errors.length} 个问题，状态已按安全规则处理。`);
    }
}

function exportState() {
    const blob = new Blob([JSON.stringify(getState(), null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `psychology-state-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

async function importState(file) {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== 'object' || !parsed.relations) {
        throw new Error('无效的 Psychology Engine 状态文件');
    }
    ctx().chatMetadata[METADATA_KEY] = parsed;
    saveState();
    await refreshInjection();
    renderStatus();
    renderStateViewer();
    renderDebug();
}

function resetState() {
    if (!confirm('确定清空当前聊天的全部 Psychology Engine 状态吗？')) return;
    ctx().chatMetadata[METADATA_KEY] = newState();
    saveState();
    refreshInjection();
    renderStatus();
    renderStateViewer();
    renderDebug();
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;',
    }[m]));
}

function renderStatus() {
    const el = document.getElementById('psy_status');
    const initEl = document.getElementById('psy_init_status');

    const cardName = currentCharacterName();
    const s = getState();
    const context = s.cardContexts?.[cardName];
    const actors = confirmedActorNames();

    if (el) {
        el.textContent = getSettings().enabled
            ? 'Single-pass 已启用 · Multi-Actor · 最新回复可Rollback'
            : '已关闭';
    }

    if (initEl) {
        if (!cardName) {
            initEl.innerHTML = '<span class="psy-warn">未检测到当前卡片上下文</span>';
            return;
        }

        if (context?.isContainer === true) {
            const names = (context.actorNames ?? []).filter(profileExists);
            initEl.innerHTML =
                `<span class="psy-ok">✓ 卡片容器：${escapeHtml(cardName)}</span>` +
                `<div>实际角色：${names.length ? names.map(escapeHtml).join('、') : '等待初始化'}</div>`;
        } else if (context?.isContainer === false && profileExists(cardName)) {
            initEl.innerHTML = `<span class="psy-ok">✓ ${escapeHtml(cardName)} 已初始化</span>`;
        } else if (actors.length) {
            initEl.innerHTML =
                `<span class="psy-warn">○ ${escapeHtml(cardName)} 身份待确认</span>` +
                `<div>已知实际角色：${actors.map(escapeHtml).join('、')}</div>`;
        } else {
            initEl.innerHTML =
                `<span class="psy-warn">○ ${escapeHtml(cardName)} 将在下一次主回复中识别实际角色并初始化</span>`;
        }
    }
}

function renderStateViewer() {
    const box = document.getElementById('psy_state_viewer');
    if (!box) return;

    const user = currentUserName();
    const rows = Object.values(getState().relations)
        .filter(edge => isEligibleActor(edge.observer))
        .filter(edge => edge.target === user || isEligibleActor(edge.target))
        .sort((a,b) => edgeKey(a.observer,a.target).localeCompare(edgeKey(b.observer,b.target)));

    if (!rows.length) {
        box.innerHTML = '<div class="psy-empty">尚无关系状态。</div>';
        return;
    }

    box.innerHTML = rows.map(edge => {
        const core = Object.entries(edge.core ?? {})
            .map(([k,v]) => `<span><b>${escapeHtml(k)}</b> ${v}</span>`).join('');

        const derived = Object.entries(edge.derived ?? {})
            .map(([k,v]) => `<span><b>${escapeHtml(k)}</b> ${v}</span>`).join('');

        const status = edge.status === 'uninitialized'
            ? '<span class="psy-uninit">未初始化</span>'
            : '';

        return `
        <details class="psy-edge">
          <summary>${escapeHtml(edge.observer)} → ${escapeHtml(edge.target)} ${status}</summary>
          <div class="psy-grid">${core || '<span>暂无核心值</span>'}</div>
          <div class="psy-grid psy-derived">${derived}</div>
          ${edge.activeThreads?.length
            ? `<div class="psy-threads"><b>Threads:</b> ${edge.activeThreads.map(escapeHtml).join(' · ')}</div>`
            : ''}
        </details>`;
    }).join('');
}

function renderDebug() {
    const box = document.getElementById('psy_debug_text');
    if (!box) return;

    const rt = getState().runtime ?? {};
    box.value = JSON.stringify({
        cardContexts: getState().cardContexts,
        actorRegistry: getState().actorRegistry,
        confirmedActors: confirmedActorNames(),
        uninitializedActors: uninitializedActorNames(),
        lastProcessedMessageId: rt.lastProcessedMessageId,
        lastProcessedAt: rt.lastProcessedAt,
        initRetryReason: rt.initRetryReason,
        lastRollback: rt.lastRollback,
        lastControlRaw: rt.lastControlRaw,
        lastControlParsed: rt.lastControlParsed,
        lastControlError: rt.lastControlError,
    }, null, 2);
}

function bindSetting(id,key,type='checkbox') {
    const el = document.getElementById(id);
    if (!el) return;

    const settings = getSettings();
    if (type === 'checkbox') el.checked = Boolean(settings[key]);
    else el.value = settings[key];

    el.addEventListener('change', async () => {
        if (type === 'checkbox') settings[key] = el.checked;
        else if (type === 'number') settings[key] = Number(el.value);
        else settings[key] = el.value;

        saveSettings();
        await refreshInjection();
        renderStatus();
    });
}

function buildSettingsUi() {
    if (document.getElementById('psychology_engine_settings')) return;

    const host = document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings')
        || document.body;

    const wrapper = document.createElement('div');
    wrapper.id = 'psychology_engine_settings';
    wrapper.className = 'extension_container';

    wrapper.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Psychology Engine v0.3.3 · Eligibility Gate</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>

      <div class="inline-drawer-content">
        <div id="psy_init_status"></div>

        <label><input id="psy_enabled" type="checkbox"> 启用 Psychology Engine</label>
        <label><input id="psy_inject" type="checkbox"> 向主回复注入当前心理状态</label>
        <label><input id="psy_auto_init" type="checkbox"> 未初始化角色在下一次主回复中自动初始化</label>
        <label><input id="psy_hide_blocks" type="checkbox"> 自动移除主回复中的隐藏控制块</label>

        <label>注入深度
          <input id="psy_depth" class="text_pole" type="number" min="0" max="20" style="width:80px">
        </label>

        <div class="psy-buttons">
          <button id="psy_export" class="menu_button">导出状态</button>
          <label class="menu_button psy-file-label">导入状态
            <input id="psy_import" type="file" accept=".json,application/json" hidden>
          </label>
          <button id="psy_reset" class="menu_button">清空当前聊天状态</button>
          <button id="psy_refresh" class="menu_button">刷新注入</button>
        </div>

        <div class="psy-status">运行状态：<span id="psy_status">就绪</span></div>

        <details>
          <summary>最后控制块 / Debug</summary>
          <textarea id="psy_debug_text" class="text_pole" rows="14" readonly></textarea>
        </details>

        <div id="psy_state_viewer"></div>
      </div>
    </div>`;

    host.appendChild(wrapper);

    bindSetting('psy_enabled','enabled');
    bindSetting('psy_inject','injectRuntime');
    bindSetting('psy_auto_init','autoInitialize');
    bindSetting('psy_hide_blocks','hideControlBlocks');
    bindSetting('psy_depth','injectionDepth','number');

    document.getElementById('psy_export')?.addEventListener('click', exportState);
    document.getElementById('psy_reset')?.addEventListener('click', resetState);
    document.getElementById('psy_refresh')?.addEventListener('click', async () => {
        await refreshInjection();
        toast('success','主 Prompt 注入已刷新');
    });

    document.getElementById('psy_import')?.addEventListener('change', async ev => {
        const file = ev.target.files?.[0];
        if (!file) return;

        try {
            await importState(file);
            toast('success','状态导入成功');
        } catch (err) {
            toast('error',`导入失败：${err?.message ?? err}`);
        }

        ev.target.value = '';
    });

    wrapper.querySelector('.inline-drawer-toggle')?.addEventListener('click', () => {
        wrapper.querySelector('.inline-drawer-content')?.classList.toggle('open');
    });

    renderStatus();
    renderStateViewer();
    renderDebug();
}

async function onChatChanged() {
    // Do NOT automatically create currentCharacterName() as an actor.
    // It may be only a multi-character card/group/scenario title.
    await refreshInjection();
    renderStatus();
    renderStateViewer();
    renderDebug();
}

async function onMessageSent() {
    // Once the user advances the story, exact rollback snapshots older than the
    // latest assistant response are intentionally compacted.
    compactOldTransactions(-1);

    // Refresh immediately before the normal main generation.
    await refreshInjection();
}

async function onMessageReceived(messageId) {
    // No second model call. Parse what the MAIN model already generated.
    setTimeout(() => processAssistantMessage(messageId), 0);
}

async function onMessageSwiped(messageId) {
    const id = Number(messageId);

    // MESSAGE_SWIPED may fire BEFORE a newly requested swipe begins generation.
    // Roll back immediately so the new main generation sees the pre-reply state.
    await rollbackMessageTransaction(id, { silent: true });
    await refreshInjection();

    // When switching to an already-existing swipe there may be no new
    // MESSAGE_RECEIVED event. Give GENERATION_STARTED a moment to fire; if no
    // generation is active, apply the selected existing swipe (or its cache).
    setTimeout(() => {
        if (!generationActive) processAssistantMessage(id);
    }, 250);
}

function onGenerationStarted() {
    generationActive = true;
}

function onGenerationEnded() {
    generationActive = false;
}

async function init() {
    if (initialized) return;

    const c = ctx();
    if (!c) {
        setTimeout(init,500);
        return;
    }

    initialized = true;
    buildSettingsUi();

    const es = c.eventSource;
    const et = c.eventTypes;

    if (es && et) {
        if (et.CHAT_CHANGED) es.on(et.CHAT_CHANGED,onChatChanged);
        if (et.MESSAGE_SENT) es.on(et.MESSAGE_SENT,onMessageSent);

        if (et.MESSAGE_RECEIVED) {
            // Prefer first listener so we can strip the machine block as early as possible.
            if (typeof es.makeFirst === 'function') es.makeFirst(et.MESSAGE_RECEIVED,onMessageReceived);
            else es.on(et.MESSAGE_RECEIVED,onMessageReceived);
        }

        if (et.MESSAGE_SWIPED) es.on(et.MESSAGE_SWIPED,onMessageSwiped);
        if (et.GENERATION_STARTED) es.on(et.GENERATION_STARTED,onGenerationStarted);
        if (et.GENERATION_ENDED) es.on(et.GENERATION_ENDED,onGenerationEnded);
    }

    await onChatChanged();
    console.log('[Psychology Engine] v0.3.3 actor eligibility gate initialized');
}

window.init = init;
init();
