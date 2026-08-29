/**
 * Psychology Engine for SillyTavern
 * v0.4.2 — Regenerate Rollback Fix
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

const CHARACTER_STATE_VARIABLES = [
    'Mood','Activation','Fear','Shame','Pride','Loneliness',
];

const RELATION_LONG_VARIABLES = [
    'Love','Trust','Security','Intimacy','Dependency','Exclusivity','Resentment','Respect',
];

const RELATION_DYNAMIC_VARIABLES = [
    'Anger','Shyness','Hurt','Longing','RelationalThreat','Guilt','Disgust',
    'Jealousy','AffectionSeeking','Curiosity','Gratitude','Attraction','Admiration',
];

const ALL_RELATION_VARIABLES = [...RELATION_LONG_VARIABLES, ...RELATION_DYNAMIC_VARIABLES];
const ALL_DYNAMIC_VARIABLES = [...CHARACTER_STATE_VARIABLES, ...RELATION_DYNAMIC_VARIABLES];
const BIPOLAR_VARIABLES = new Set(['Mood','Trust','Respect']);

const PERSONALITY_CONTROL = [
    'SelfControl','Assertiveness','VulnerabilityTolerance',
    'PrivacyBias','Empathy','CognitiveFlexibility','NeedForControl',
];

const STYLE_TRAITS = [
    'warmth','sociability','romanticExpressiveness','jealousyProneness',
    'dependencyProneness','angerProneness','fearProneness','shameProneness',
    'curiosityProneness','disgustSensitivity','respectSensitivity',
    'autonomy','composure','directness','flirtatiousness',
];

const HALF_LIFE = {
    Mood:14, Activation:3, Fear:6, Shame:10, Pride:16, Loneliness:null,
    Anger:6, Shyness:4, Hurt:14, Longing:null, RelationalThreat:6, Guilt:16,
    Disgust:24, Jealousy:8, AffectionSeeking:5, Curiosity:18,
    Gratitude:null, Attraction:null, Admiration:null,
};

// Caps are safety limits, not target deltas. AI still decides semantic direction/magnitude.
const DELTA_CAPS = {
    Love: { ordinary:[2,2], major:[6,6], extreme:[15,15] },
    Trust: { ordinary:[5,3], major:[25,10], extreme:[50,20] },
    Security:{ ordinary:[3,3], major:[12,12], extreme:[30,30] },
    Intimacy:{ ordinary:[3,3], major:[10,10], extreme:[25,25] },
    Dependency:{ ordinary:[2,2], major:[8,8], extreme:[20,20] },
    Exclusivity:{ ordinary:[2,2], major:[8,8], extreme:[20,20] },
    Resentment:{ ordinary:[1,2], major:[6,8], extreme:[15,20] },
    Respect:{ ordinary:[5,3], major:[20,10], extreme:[40,20] },
    Mood:{ ordinary:[10,10], major:[25,25], extreme:[45,45] },
    Activation:{ ordinary:[25,25], major:[50,50], extreme:[80,80] },
    Fear:{ ordinary:[20,20], major:[45,45], extreme:[75,75] },
    Shame:{ ordinary:[15,15], major:[35,35], extreme:[60,60] },
    Pride:{ ordinary:[10,10], major:[25,25], extreme:[45,45] },
    Loneliness:{ ordinary:[6,6], major:[15,15], extreme:[30,30] },
    Anger:{ ordinary:[15,15], major:[40,40], extreme:[70,70] },
    Shyness:{ ordinary:[15,15], major:[35,35], extreme:[60,60] },
    Hurt:{ ordinary:[12,12], major:[35,35], extreme:[60,60] },
    Longing:{ ordinary:[10,10], major:[25,25], extreme:[40,40] },
    RelationalThreat:{ ordinary:[15,15], major:[40,40], extreme:[70,70] },
    Guilt:{ ordinary:[12,12], major:[30,30], extreme:[50,50] },
    Disgust:{ ordinary:[10,10], major:[30,30], extreme:[55,55] },
    Jealousy:{ ordinary:[15,15], major:[35,35], extreme:[60,60] },
    AffectionSeeking:{ ordinary:[12,12], major:[25,25], extreme:[40,40] },
    Curiosity:{ ordinary:[12,12], major:[25,25], extreme:[40,40] },
    Gratitude:{ ordinary:[6,6], major:[20,20], extreme:[40,40] },
    Attraction:{ ordinary:[4,4], major:[12,12], extreme:[25,25] },
    Admiration:{ ordinary:[6,6], major:[20,20], extreme:[35,35] },
};

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


// Threads are unresolved open loops, never a scene log.
// New v0.4.1 threads are structured so the main model must explicitly judge
// why the issue is still open and what future event would close it.
const THREAD_KINDS = new Set([
    'unanswered_question',
    'unfulfilled_commitment',
    'unresolved_conflict',
    'pending_decision',
    'withheld_intention',
    'ongoing_uncertainty',
    'unfinished_task',
    'other',
]);

function threadId(text, turn=0) {
    const fp = fastFingerprint(String(text ?? '')).split(':').pop();
    return `th_${Number(turn)||0}_${fp}`;
}

function normalizeThreadForPrompt(t) {
    if (!t || typeof t !== 'object') return null;
    const id = String(t.id ?? '').trim();
    const text = String(t.text ?? '').trim();
    if (!id || !text) return null;
    return {
        id,
        text,
        kind:String(t.kind ?? 'other'),
        resolutionCriterion:String(t.resolutionCriterion ?? ''),
    };
}

function normalizeThreadCandidate(raw, turn=0) {
    // v0.4.1 deliberately rejects bare strings. A string cannot prove that
    // the main model performed the required unresolved/open-loop judgment.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const text = String(raw.text ?? '').trim();
    const kind = String(raw.kind ?? '').trim();
    const resolutionCriterion = String(raw.resolutionCriterion ?? '').trim();
    const whyOpen = String(raw.whyOpen ?? '').trim();
    const isUnresolved = raw.isUnresolved === true;
    const futureResolutionRequired = raw.futureResolutionRequired === true;
    if (!text || !THREAD_KINDS.has(kind)) return null;
    if (!isUnresolved || !futureResolutionRequired) return null;
    if (resolutionCriterion.length < 4 || whyOpen.length < 4) return null;
    return {
        id: threadId(text, turn),
        text,
        kind,
        whyOpen,
        resolutionCriterion,
        createdAt:nowIso(),
        createdTurn:Number(turn)||0,
    };
}

function threadMatchesResolution(thread, raw) {
    if (!thread) return false;
    const id = typeof raw === 'object' && raw ? String(raw.id ?? '').trim() : String(raw ?? '').trim();
    const text = typeof raw === 'object' && raw ? String(raw.text ?? '').trim() : String(raw ?? '').trim();
    if (id && String(thread.id ?? '') === id) return true;
    if (text && String(thread.text ?? '') === text) return true;
    return false;
}

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
        schemaVersion: '0.4.1',
        cardContexts: {},
        actorRegistry: {},
        characters: {},
        relations: {},
        events: {},
        knowledge: {},
        storyTime: { label:'', elapsed:'', confidence:'low' },
        runtime: {
            turnCounter: 0,
            lastProcessedMessageId: null,
            lastProcessedAt: null,
            lastControlRaw: null,
            lastControlParsed: null,
            lastControlError: null,
            initRetryReason: null,
        },
    };
}


function migrateStateTo041(s) {
    if (!s || typeof s !== 'object') return newState();
    if (s.schemaVersion === '0.4.1') return s;

    s.cardContexts ??= {};
    s.actorRegistry ??= {};
    s.characters ??= {};
    s.relations ??= {};
    s.events ??= {};
    s.knowledge ??= {};
    s.storyTime ??= { label:'', elapsed:'', confidence:'low' };
    s.runtime ??= {};

    const oldCoreLong = new Set(['Love','Trust','Security','Intimacy','Dependency','Exclusivity','Resentment','Respect']);
    const oldCoreDynamic = new Set(['Anger','Shyness','Hurt','Longing','RelationalThreat','Guilt','Disgust']);
    const oldCharCore = new Set(['Mood','Arousal','Fear']);
    const oldCharDerived = new Set(['Shame','Pride','Loneliness']);

    for (const [name,ch0] of Object.entries(s.characters)) {
        const ch = ch0 ?? {};
        ch.state ??= {};
        ch.stateMeta ??= {};
        if (ch.psychologyProfile) {
            const pc = ch.psychologyProfile.personalityControl ?? {};
            const st = ch.psychologyProfile.styleTraits ?? {};
            const missingAxes = PERSONALITY_CONTROL.some(k => !Number.isFinite(Number(pc[k])))
                || STYLE_TRAITS.some(k => !Number.isFinite(Number(st[k])));
            ch.psychologyProfile.version = '0.4.1';
            ch.psychologyProfile.invariants ??= [];
            delete ch.psychologyProfile.coreParameters;
            delete ch.psychologyProfile.derivedParameters;
            // v0.3.x profiles do not contain the four new axes. Keep relationship state,
            // but request a fresh profile on the next main response instead of inventing 0.5 values.
            if (missingAxes) ch.profileStatus = 'uninitialized';
        }
        s.characters[name] = ch;
    }

    const assignCharacterState = (name, variable, value) => {
        name = normName(name);
        if (!name) return;
        const ch = s.characters[name] ??= { id:name, displayName:name, aliases:[], notes:'', profileStatus:'uninitialized', psychologyProfile:null, createdAt:nowIso(), state:{}, stateMeta:{} };
        ch.state ??= {};
        const renamed = variable === 'Arousal' ? 'Activation' : variable;
        if (!CHARACTER_STATE_VARIABLES.includes(renamed)) return;
        const next = clampVariable(renamed, value);
        const prev = ch.state[renamed];
        if (prev === undefined || Math.abs(next) > Math.abs(Number(prev)||0)) ch.state[renamed] = next;
    };

    for (const edge of Object.values(s.relations)) {
        edge.longTerm ??= {};
        edge.dynamic ??= {};
        edge.stateMeta ??= {};
        edge.interactionCount ??= 0;
        edge.familiarityBase ??= 0;

        // v0.4.0 allowed free-form string Threads, so completed scene summaries could
        // be misclassified as unresolved issues. They are not trustworthy enough to
        // migrate. Structured v0.4.1 threads, if present, are retained.
        if (Array.isArray(edge.activeThreads)) {
            edge.activeThreads = edge.activeThreads.filter(t => t && typeof t === 'object' && t.id && t.text);
        } else {
            edge.activeThreads = [];
        }

        for (const [k,v] of Object.entries(edge.core ?? {})) {
            if (oldCoreLong.has(k)) edge.longTerm[k] = clampVariable(k,v);
            else if (oldCoreDynamic.has(k)) edge.dynamic[k] = clampVariable(k,v);
            else if (oldCharCore.has(k)) assignCharacterState(edge.observer,k,v);
        }
        for (const [k,v] of Object.entries(edge.derived ?? {})) {
            if (oldCharDerived.has(k)) assignCharacterState(edge.observer,k,v);
            else if (RELATION_DYNAMIC_VARIABLES.includes(k)) edge.dynamic[k] = clampVariable(k,v);
        }
        delete edge.core;
        delete edge.derived;
        delete edge.personalityControl;
    }

    s.schemaVersion = '0.4.1';
    s.runtime.turnCounter ??= 0;
    return s;
}

function getState() {
    const c = ctx();
    if (!c?.chatMetadata) return newState();

    if (!c.chatMetadata[METADATA_KEY]) c.chatMetadata[METADATA_KEY] = newState();
    const s = migrateStateTo041(c.chatMetadata[METADATA_KEY]);
    c.chatMetadata[METADATA_KEY] = s;

    s.schemaVersion = '0.4.1';
    s.cardContexts ??= {};
    s.actorRegistry ??= {};
    s.characters ??= {};
    s.relations ??= {};
    s.events ??= {};
    s.knowledge ??= {};
    s.storyTime ??= { label:'', elapsed:'', confidence:'low' };
    s.runtime ??= {};
    s.runtime.turnCounter ??= 0;
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
        const profile = ch?.psychologyProfile ?? {};
        return {
            character: name,
            sourceCards: ch?.sourceCards ?? [],
            personalityControl: profile.personalityControl ?? null,
            styleTraits: profile.styleTraits ?? null,
            invariants: (profile.invariants ?? []).slice(0,2),
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
        state: {},
        stateMeta: {},
        createdAt: nowIso(),
    };
    s.characters[name].state ??= {};
    s.characters[name].stateMeta ??= {};
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
    if (target !== currentUserName()) ensureCharacter(target);

    const s = getState();
    const key = edgeKey(observer,target);

    s.relations[key] ??= {
        observer,
        target,
        status: 'uninitialized',
        longTerm: {},
        dynamic: {},
        stateMeta: {},
        interactionCount: 0,
        familiarityBase: 0,
        activeThreads: [],
        memories: [],
        lastUpdatedAt: null,
    };

    const edge = s.relations[key];
    edge.longTerm ??= {};
    edge.dynamic ??= {};
    edge.stateMeta ??= {};
    edge.interactionCount ??= 0;
    edge.familiarityBase ??= 0;
    return edge;
}


function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.5;
    return Math.max(0, Math.min(1, n));
}

function variableDomain(variable) {
    return BIPOLAR_VARIABLES.has(variable) ? [-100,100] : [0,100];
}

function clampVariable(variable, value) {
    const n = Number(value);
    const [lo,hi] = variableDomain(variable);
    if (!Number.isFinite(n)) return lo < 0 ? 0 : lo;
    return Math.max(lo, Math.min(hi, Math.round(n)));
}

function severityName(value) {
    const s = String(value ?? 'ordinary').toLowerCase();
    return ['ordinary','major','extreme'].includes(s) ? s : 'ordinary';
}

function capDelta(variable, value, severity='ordinary') {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const spec = DELTA_CAPS[variable]?.[severityName(severity)] ?? [20,20];
    const cap = n < 0 ? spec[0] : spec[1];
    return Math.max(-cap, Math.min(cap, Math.round(n)));
}

function semanticBand(variable, value) {
    const n = Number(value) || 0;
    const a = Math.abs(n);
    let strength = 'neutral';
    if (a <= 10) strength = 'neutral';
    else if (a <= 25) strength = 'mild';
    else if (a <= 40) strength = 'noticeable';
    else if (a <= 55) strength = 'moderate';
    else if (a <= 70) strength = 'strong';
    else if (a <= 85) strength = 'very_strong';
    else if (a <= 95) strength = 'extreme';
    else strength = 'limit';

    if (!BIPOLAR_VARIABLES.has(variable)) return strength;
    const sign = n < 0 ? 'negative' : n > 0 ? 'positive' : 'neutral';
    return `${sign}:${strength}`;
}

function axesForActor(name) {
    const profile = getState().characters?.[normName(name)]?.psychologyProfile ?? {};
    return { ...(profile.personalityControl ?? {}), ...(profile.styleTraits ?? {}) };
}

function traitValueFor(variable, axes) {
    const A = (k, d=0.5) => clamp01(axes?.[k] ?? d);
    switch (variable) {
        case 'Fear': return 0.7*A('fearProneness') + 0.3*A('NeedForControl');
        case 'Shame':
        case 'Shyness': return 0.45*A('shameProneness') + 0.35*A('PrivacyBias') + 0.20*(1-A('VulnerabilityTolerance'));
        case 'Intimacy': return 0.45*A('VulnerabilityTolerance') + 0.35*(1-A('PrivacyBias')) + 0.20*A('warmth');
        case 'Dependency': return A('dependencyProneness');
        case 'Exclusivity': return 0.7*A('jealousyProneness') + 0.3*A('NeedForControl');
        case 'Resentment': return 0.5*A('angerProneness') + 0.5*(1-A('CognitiveFlexibility'));
        case 'Respect': return A('respectSensitivity');
        case 'Anger': return 0.7*A('angerProneness') + 0.3*A('NeedForControl');
        case 'Longing': return 0.6*A('dependencyProneness') + 0.4*A('warmth');
        case 'RelationalThreat': return 0.45*A('NeedForControl') + 0.35*A('jealousyProneness') + 0.20*A('dependencyProneness');
        case 'Guilt': return 0.7*A('Empathy') + 0.3*A('CognitiveFlexibility');
        case 'Disgust': return A('disgustSensitivity');
        case 'Jealousy': return A('jealousyProneness');
        case 'AffectionSeeking': return 0.6*A('dependencyProneness') + 0.4*A('warmth');
        case 'Curiosity': return 0.7*A('curiosityProneness') + 0.3*A('CognitiveFlexibility');
        case 'Gratitude': return 0.6*A('Empathy') + 0.4*A('respectSensitivity');
        case 'Admiration': return 0.7*A('respectSensitivity') + 0.3*A('curiosityProneness');
        default: return null;
    }
}

function reactivityFactor(variable, axes) {
    const p = traitValueFor(variable, axes);
    if (p === null) return 1;
    const signature = new Set(['Jealousy','Anger','Shyness','Shame','Dependency','Curiosity','Disgust']);
    return signature.has(variable)
        ? 0.55 + 0.95 * p
        : 0.75 + 0.50 * p;
}

function effectiveHalfLife(variable, observer) {
    const base = HALF_LIFE[variable];
    if (!base) return null;
    const axes = axesForActor(observer);
    const p = traitValueFor(variable, axes);
    if (p === null) return base;
    if (['Anger','Shyness','Shame','Jealousy','Curiosity','Disgust','Fear'].includes(variable)) {
        return Math.max(1, base * (0.8 + 0.5 * p));
    }
    return base;
}

function relationshipFamiliarity(edge) {
    if (!edge) return 0;
    const n = Math.max(0, Number(edge.interactionCount) || 0);
    const intimacy = Math.max(0, Number(edge.longTerm?.Intimacy) || 0) / 100;
    const learned = 0.7 * (1 - Math.exp(-n / 18)) + 0.3 * intimacy;
    return clamp01(Math.max(Number(edge.familiarityBase) || 0, learned));
}

function saturationFactor(variable, current, delta, severity) {
    if (!(delta > 0)) return 1;
    severity = severityName(severity);
    const x = Math.max(0, Number(current) || 0);
    if (variable === 'Trust') {
        if (severity === 'extreme') return 1;
        const floor = severity === 'major' ? 0.45 : 0.15;
        return Math.max(floor, 1 - Math.max(x,0) / 100);
    }
    if (variable === 'Intimacy') {
        if (severity === 'extreme') return 1;
        const floor = severity === 'major' ? 0.5 : 0.2;
        return Math.max(floor, 1 - x / 100);
    }
    if (variable === 'Love' && severity === 'ordinary') {
        return Math.max(0.35, 1 - x / 110);
    }
    return 1;
}

function contextFactor(variable, observer, edge, context={}, severity='ordinary') {
    const axes = axesForActor(observer);
    const novelty = clamp01(context?.novelty ?? 0);
    const vulnerability = clamp01(context?.vulnerability ?? 0);
    const familiarity = relationshipFamiliarity(edge);

    if (variable === 'Curiosity' && edge) {
        const traitFloor = 0.35 + 0.65 * clamp01(axes.curiosityProneness ?? 0.5);
        const familiarityEffect = 1 - 0.6 * familiarity * (1 - novelty);
        return Math.max(traitFloor, familiarityEffect);
    }

    if (variable === 'Jealousy' && edge) {
        const security = Math.max(0, Number(edge.longTerm?.Security) || 0) / 100;
        const jp = clamp01(axes.jealousyProneness ?? 0.5);
        // Security suppresses panic-type jealousy, but cannot erase trait jealousy.
        return Math.max(0.55 + 0.45*jp, 1 - 0.5 * security * (1 - jp));
    }

    if (variable === 'RelationalThreat' && edge) {
        if (severityName(severity) === 'extreme') return 1;
        const security = Math.max(0, Number(edge.longTerm?.Security) || 0) / 100;
        const floor = severityName(severity) === 'major' ? 0.75 : 0.45;
        return Math.max(floor, 1 - 0.55 * security);
    }

    return 1;
}

function shynessCeiling(observer, edge, context={}) {
    const axes = axesForActor(observer);
    const familiarity = relationshipFamiliarity(edge);
    const novelty = clamp01(context?.novelty ?? 0);
    const vulnerability = clamp01(context?.vulnerability ?? 0);
    const trait = clamp01(axes.shameProneness ?? 0.5);
    const traitFloor = 20 + 30 * trait;
    const contextual = 20 + 65*(1-familiarity) + 35*novelty + 25*vulnerability;
    return Math.max(20, Math.min(100, Math.round(Math.max(traitFloor, contextual))));
}

function applyMechanicalDelta(variable, rawDelta, current, observer, edge, context, severity) {
    let delta = Number(rawDelta);
    if (!Number.isFinite(delta) || delta === 0) return 0;
    const axes = axesForActor(observer);
    delta *= reactivityFactor(variable, axes);
    delta *= contextFactor(variable, observer, edge, context, severity);
    delta *= saturationFactor(variable, current, delta, severity);
    return capDelta(variable, delta, severity);
}

function decayTowardZero(value, halfLife) {
    if (!halfLife) return value;
    const n = Number(value) || 0;
    const next = n * Math.pow(2, -1 / halfLife);
    if (Math.abs(next) < 1) return 0;
    return Math.round(next);
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
        ? payload.evidenceSummary.map(String).map(x=>x.trim()).filter(Boolean).slice(0,8)
        : [];
    if (!evidenceSummary.length) throw new Error(`PSY_INIT ${actorName} evidenceSummary is empty`);

    const invariants = Array.isArray(payload.invariants)
        ? payload.invariants.map(String).map(x=>x.trim()).filter(Boolean).slice(0,2).map(x=>x.slice(0,260))
        : [];

    const initialCharacterState = {};
    for (const [k,v] of Object.entries(payload.initialCharacterState ?? {})) {
        if (!CHARACTER_STATE_VARIABLES.includes(k) || !Number.isFinite(Number(v))) continue;
        initialCharacterState[k] = clampVariable(k,v);
    }

    const profile = {
        version: '0.4.1',
        character: actorName,
        sourceCard: normName(sourceCard),
        evidenceSummary,
        personalityControl,
        styleTraits,
        invariants,
        initialCharacterState,
        initialRelations: [],
        generatedAt: nowIso(),
    };

    const relationInputs = Array.isArray(payload.initialRelations)
        ? payload.initialRelations
        : payload.initialRelation ? [payload.initialRelation] : [];

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
                ? relationInput.evidence.map(String).filter(Boolean).slice(0,8)
                : [],
            values: {},
            familiarityBase: clamp01(relationInput?.familiarity ?? 0),
        };

        for (const [k,v] of Object.entries(values)) {
            if (!ALL_RELATION_VARIABLES.includes(k) || !Number.isFinite(Number(v))) continue;
            rel.values[k] = clampVariable(k,v);
        }
        if (!Object.keys(rel.values).length) rel.status = 'uninitialized';
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
    const name = normName(profile.character);
    const ch = ensureCharacter(name);

    ch.psychologyProfile = profile;
    ch.profileStatus = 'confirmed';
    ch.personalityControl = clone(profile.personalityControl);
    ch.profileConfirmedAt = nowIso();
    ch.sourceCards ??= [];

    for (const [k,v] of Object.entries(profile.initialCharacterState ?? {})) {
        if (CHARACTER_STATE_VARIABLES.includes(k)) ch.state[k] = clampVariable(k,v);
    }

    const card = normName(sourceCard || profile.sourceCard);
    if (card && !ch.sourceCards.includes(card)) ch.sourceCards.push(card);

    for (const rel of profile.initialRelations ?? []) {
        const edge = ensureEdge(name, rel.target);
        if (!edge) continue;
        edge.status = rel.status;
        edge.familiarityBase = Math.max(edge.familiarityBase || 0, clamp01(rel.familiarityBase ?? 0));

        for (const [k,v] of Object.entries(rel.values ?? {})) {
            if (RELATION_LONG_VARIABLES.includes(k)) edge.longTerm[k] = clampVariable(k,v);
            if (RELATION_DYNAMIC_VARIABLES.includes(k)) edge.dynamic[k] = clampVariable(k,v);
        }

        if (rel.evidence?.length) {
            edge.memories.push({ type:'initialization_evidence', text:rel.evidence.join('；'), at:nowIso() });
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

function characterStateForPrompt(name) {
    const ch = getState().characters?.[name];
    const active = {};
    for (const [k,v] of Object.entries(ch?.state ?? {})) {
        if (!CHARACTER_STATE_VARIABLES.includes(k)) continue;
        if (Math.abs(Number(v)||0) <= 10) continue;
        active[k] = { value:v, band:semanticBand(k,v) };
    }
    return Object.keys(active).length ? { character:name, active } : null;
}

function relationForPrompt(edge) {
    const persistent = {};
    const active = {};

    for (const [k,v] of Object.entries(edge.longTerm ?? {})) {
        persistent[k] = { value:v, band:semanticBand(k,v) };
    }
    for (const [k,v] of Object.entries(edge.dynamic ?? {})) {
        if (Math.abs(Number(v)||0) <= 10) continue;
        active[k] = { value:v, band:semanticBand(k,v) };
    }

    return {
        observer: edge.observer,
        target: edge.target,
        familiarity: Number(relationshipFamiliarity(edge).toFixed(2)),
        persistent,
        active,
        activeThreads: (edge.activeThreads ?? []).slice(-5).map(normalizeThreadForPrompt).filter(Boolean),
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
    const actorNames = confirmedActorNames();

    const runtime = {
        cardContext: { name:cardName, isContainer:cardContext?.isContainer ?? 'unknown', knownActors:cardContext?.actorNames ?? [] },
        user,
        actorRegistry: actorRegistryForPrompt(),
        actorProfiles: actorProfilesForPrompt(),
        characterStates: actorNames.map(characterStateForPrompt).filter(Boolean),
        uninitializedActors: pendingActors,
        relations: relevantEdges().map(relationForPrompt),
    };

    const initRetry = state.runtime.initRetryReason
        ? `Previous initialization was rejected: ${state.runtime.initRetryReason}. Recreate PSY_INIT carefully.`
        : '';

    const initInstruction = needsInit ? `
ACTOR INITIALIZATION IS REQUIRED.

Card Context != Actor. Determine whether "${cardName}" is one real actor or a container/title.
Only persistent actors are eligible: principal character-card actors or explicitly defined recurring World Info actors.
Never register incidental NPCs just because they appear. Prefer only 1–4 newly eligible actors.

After visible RP prose append:
<!--PSY_INIT
{STRICT_JSON}
/PSY_INIT-->

Shape:
{
  "cardContext":"${cardName}",
  "cardIsContainer":false,
  "profiles":[{
    "character":"REAL ACTOR NAME",
    "eligibility":{"source":"character_card|world_info","evidence":"brief evidence"},
    "evidenceSummary":["1-4 concise stable observations"],
    "personalityControl":{
      "SelfControl":0.5,"Assertiveness":0.5,"VulnerabilityTolerance":0.5,"PrivacyBias":0.5,
      "Empathy":0.5,"CognitiveFlexibility":0.5,"NeedForControl":0.5
    },
    "styleTraits":{
      "warmth":0.5,"sociability":0.5,"romanticExpressiveness":0.5,"jealousyProneness":0.5,
      "dependencyProneness":0.5,"angerProneness":0.5,"fearProneness":0.5,"shameProneness":0.5,
      "curiosityProneness":0.5,"disgustSensitivity":0.5,"respectSensitivity":0.5,
      "autonomy":0.5,"composure":0.5,"directness":0.5,"flirtatiousness":0.5
    },
    "invariants":["0-2 short anti-erosion constraints only when genuinely needed"],
    "initialCharacterState":{"Mood":0},
    "initialRelations":[{
      "target":"${user}",
      "familiarity":0.0,
      "evidence":["supported relation history only"],
      "values":{"Love":60,"Trust":50,"Intimacy":45}
    }]
  }]
}

Initialization rules:
- All personality axes use [0,1].
- Relationship domains: Trust/Respect [-100,100]; every other relationship variable [0,100].
- Character-state domains: Mood [-100,100]; Activation/Fear/Shame/Pride/Loneliness [0,100].
- 0 is genuine absence/neutrality, not boolean false; 1 is tiny intensity, not boolean true.
- Keep initial states SPARSE. Omitted = insufficient evidence.
- familiarity is mechanical history familiarity [0,1], not intimacy; use high values for established long-term relationships when supported.
- invariants are OPTIONAL, max 2, and must protect a core character-card feature that dynamics might otherwise erase. Do not use archetype labels or fixed action scripts.
- Character card remains authoritative for stable personality/style.
- Do not use the user's newest message as evidence for stable personality.
${initRetry}
` : `
No PSY_INIT is required unless a genuinely new eligible actor appears.
`;

    return `
[Psychology Engine v0.4.2 — SINGLE-PASS]

This is part of the SAME normal SillyTavern generation and uses the same API/model/preset.

TOP RULES:
1. Character Card = WHO the actor is. It remains authoritative for stable personality, values, speech and special character traits.
2. Personality axes = HOW the actor tends to appraise/react/express.
3. Dynamic state = WHAT the actor currently feels.
4. State evolves; personality persists; expression adapts.
5. Relationship development must NOT automatically cure, normalize or average away established character traits.
6. Internal intensity != visible expression. High Anger/Fear/Jealousy does not force loss of composure or a fixed gesture.
7. Never mechanically map a number to blush/pout/shout/etc. Infer behavior from card + state + relationship + context + recent behavior.
8. No Knowledge => No Psychological Update. Narrator knowledge != character knowledge.

Important trait-preservation examples:
- High Security may reduce abandonment panic but must not erase trait jealousy or clinginess.
- Familiarity reduces unfamiliarity-based reactions, not personality-based reactions.
- A shy character can habituate to routine intimacy yet remain unusually reactive to NEW/private/vulnerable exposure.
- A composed character may feel intense emotion without behaving chaotically.
- Love/Intimacy do not automatically increase Dependency; high-autonomy characters may love deeply while remaining independent.
- RomanticExpressiveness != Love capacity; Flirtatiousness != Love or Attraction.

Current runtime:
${JSON.stringify(runtime, null, 2)}

${initInstruction}

After visible RP prose ALWAYS append:
<!--PSY_UPDATE
{STRICT_JSON}
/PSY_UPDATE-->

Compact shape:
{
  "events":[{
    "id":"e1",
    "summary":"short objective event",
    "participants":["REAL ACTOR","${user}"],
    "knownBy":["REAL ACTOR"]
  }],
  "updates":[{
    "observer":"REAL REGISTERED ACTOR",
    "target":"${user}",
    "basedOn":["e1"],
    "severity":"ordinary|major|extreme",
    "characterDelta":{"Activation":8},
    "relationshipDelta":{"Trust":1,"Shyness":8},
    "context":{"novelty":0.0,"vulnerability":0.0},
    "maintainCharacter":[],
    "maintainRelationship":[],
    "reason":"short appraisal reason",
    "addThreads":[{"text":"...","kind":"unanswered_question|unfulfilled_commitment|unresolved_conflict|pending_decision|withheld_intention|ongoing_uncertainty|unfinished_task|other","isUnresolved":true,"futureResolutionRequired":true,"whyOpen":"why it still needs future handling","resolutionCriterion":"what future condition closes it"}],"resolveThreads":[{"id":"th_..."}],"memories":[]
  }]
}

Update rules:
- observer must be a registered persistent actor. The user is normally never observer.
- target is optional when ONLY characterDelta changes; relationshipDelta requires target=user or another registered actor.
- participants/knownBy use real actor names, never card/group titles.
- Character state: Mood, Activation, Fear, Shame, Pride, Loneliness.
- Directed relationship: Love, Trust, Security, Intimacy, Dependency, Exclusivity, Resentment, Respect, Anger, Shyness, Hurt, Longing, RelationalThreat, Guilt, Disgust, Jealousy, AffectionSeeking, Curiosity, Gratitude, Attraction, Admiration.
- Trust/Respect/Mood are bipolar [-100,100]. All others are [0,100]. Negative Anger/Fear/Jealousy/etc. are invalid.
- Deltas are semantic BASE changes; do not pre-amplify them numerically just because a trait is high. The plugin applies mechanical reactivity/caps. Traits DO affect whether a weak cue triggers at all.
- Signature-prone traits (jealousy/anger/shyness/dependency/curiosity/disgust) should have meaningfully different trigger thresholds. Do not flatten them to tiny ±20% flavor.
- Ordinary turns should usually change only 2–5 variables. Major/extreme events may change more. Do not blanket-update the whole state vector.
- Long-term variables move slowly. A compliment is not Love +10. Trust builds slower than it can be destroyed.
- High values have diminishing returns for routine positive Trust/Intimacy; major events still matter.
- Security suppresses catastrophic threat interpretation, not all jealousy or dependency.
- Familiarity suppresses routine novelty; NEW vulnerable/private layers may still create high Shyness.
- Jealousy can exist with low RelationalThreat in a secure but trait-jealous character.
- AffectionSeeking is an internal relational impulse, not a scripted cute action. Security/intimacy mainly change willingness to EXPRESS it.
- Use context.novelty/vulnerability only when relevant; otherwise omit them.
- THREAD GATE: addThreads is ONLY for a genuinely unresolved open loop that still requires future handling/resolution. Before adding one, explicitly judge: “If the scene stopped now, would a specific unanswered question, unfulfilled commitment, unresolved conflict, pending decision/intention, ongoing uncertainty, or unfinished task still remain?” If NO, addThreads must be [].
- Completed interactions are NOT Threads merely because they were emotionally meaningful, romantic, flirtatious, sexual, dramatic, funny, or memorable. Example: “flirting in the car” after it already happened with no unresolved consequence = Event only (and Memory only if it has enduring future significance), never Thread.
- Never use Threads as scene logs, activity history, summaries, relationship highlights, or recent-event lists.
- Every new Thread MUST be an object with isUnresolved:true, futureResolutionRequired:true, a concrete whyOpen, and a concrete resolutionCriterion. Bare string Threads are rejected by the plugin.
- Review existing activeThreads when current events actually bear on them. When its resolutionCriterion is satisfied or the issue is explicitly abandoned/closed, put its id in resolveThreads. Do not keep a resolved Thread merely because the past event remains memorable.
- MEMORY GATE: memories are for completed events with durable future appraisal/relationship significance. Ordinary completed banter, meals, dates, routine affection, etc. remain Events only unless something about them has lasting significance.
- maintain* means the state is still actively sustained this turn even if delta=0, preventing passive decay.
- If no meaningful psychological change occurred, use updates:[]. Events may still record meaningful interaction for familiarity/decay.
- Keep control JSON concise and invisible.
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
    s.runtime.turnCounter = (Number(s.runtime.turnCounter) || 0) + 1;
    const turn = s.runtime.turnCounter;
    const user = currentUserName();
    const eventMap = new Map();
    const activeActors = new Set();
    const interactedPairs = new Set();

    for (const e of payload.events ?? []) {
        const id = eventKey(messageId, e?.id);
        const knownBy = Array.isArray(e?.knownBy)
            ? e.knownBy.map(normName).filter(Boolean).filter(name => !isContainerName(name))
            : [];
        const participants = Array.isArray(e?.participants)
            ? [...new Set(e.participants.map(normName).filter(Boolean).filter(name => !isContainerName(name)))]
            : [];

        const record = { id, summary:String(e?.summary ?? ''), participants, knownBy, createdAt:nowIso(), messageId };
        s.events[id] = record;
        eventMap.set(String(e?.id), record);

        for (const name of knownBy) {
            if (isEligibleActor(name)) activeActors.add(name);
            if (isEligibleActor(name)) {
                ensureCharacter(name);
                s.knowledge[name] ??= {};
                s.knowledge[name][id] = { known:true, source:'single_pass', certainty:1, learnedAt:nowIso() };
            }
        }

        // Familiarity is mechanical interaction history, not a psychological state.
        for (const actor of participants.filter(isEligibleActor)) {
            for (const target of participants) {
                if (actor === target) continue;
                if (target !== user && !isEligibleActor(target)) continue;
                if (!knownBy.includes(actor)) continue;
                const key = edgeKey(actor,target);
                if (interactedPairs.has(key)) continue;
                const edge = ensureEdge(actor,target);
                if (edge) {
                    edge.interactionCount = Math.max(0, Number(edge.interactionCount)||0) + 1;
                    interactedPairs.add(key);
                }
            }
        }
    }

    const valid = [];
    for (const u of payload.updates ?? []) {
        const observer = normName(u?.observer);
        const target = normName(u?.target);
        if (!observer || !isEligibleActor(observer) || observer === user) continue;
        activeActors.add(observer);

        const characterKeys = Object.keys(u?.characterDelta ?? {}).filter(k => CHARACTER_STATE_VARIABLES.includes(k));
        const relationKeys = Object.keys(u?.relationshipDelta ?? {}).filter(k => ALL_RELATION_VARIABLES.includes(k));
        if (!characterKeys.length && !relationKeys.length && !(u?.maintainCharacter?.length || u?.maintainRelationship?.length)) continue;

        if (relationKeys.length) {
            if (!target || target === observer) continue;
            if (target !== user && !isEligibleActor(target)) continue;
        }

        const basis = Array.isArray(u?.basedOn) ? u.basedOn.map(String) : [];
        if (!basis.length) continue;
        const knowledgeInvalid = basis.some(localId => {
            const ev = eventMap.get(localId);
            return !ev || !ev.knownBy.includes(observer);
        });
        if (knowledgeInvalid) {
            console.warn('[Psychology Engine] Knowledge Gate blocked update', u);
            continue;
        }

        const severity = severityName(u?.severity);
        const total = characterKeys.length + relationKeys.length;
        const maxVars = severity === 'ordinary' ? 5 : severity === 'major' ? 8 : 12;
        if (total > maxVars) {
            console.warn('[Psychology Engine] rejected blanket update', u);
            continue;
        }

        valid.push({ u, observer, target, characterKeys, relationKeys, severity });
    }

    const reinforcedCharacter = new Map();
    const reinforcedRelation = new Map();
    const maintainedCharacter = new Map();
    const maintainedRelation = new Map();
    const addSet = (map,key,values) => {
        if (!map.has(key)) map.set(key,new Set());
        const set=map.get(key); for (const v of values) set.add(v);
    };

    for (const item of valid) {
        addSet(reinforcedCharacter,item.observer,item.characterKeys);
        if (item.target) addSet(reinforcedRelation,edgeKey(item.observer,item.target),item.relationKeys);
        addSet(maintainedCharacter,item.observer,(item.u?.maintainCharacter ?? []).filter(k=>CHARACTER_STATE_VARIABLES.includes(k)));
        if (item.target) addSet(maintainedRelation,edgeKey(item.observer,item.target),(item.u?.maintainRelationship ?? []).filter(k=>RELATION_DYNAMIC_VARIABLES.includes(k)));
    }

    // Passive decay only for actors actually active/aware this turn. Off-screen actors do not drift arbitrarily.
    for (const observer of activeActors) {
        const ch = ensureCharacter(observer);
        const skip = new Set([...(reinforcedCharacter.get(observer) ?? []), ...(maintainedCharacter.get(observer) ?? [])]);
        for (const variable of CHARACTER_STATE_VARIABLES) {
            if (skip.has(variable) || ch.state?.[variable] === undefined) continue;
            const hl = effectiveHalfLife(variable, observer);
            if (!hl) continue;
            ch.state[variable] = clampVariable(variable, decayTowardZero(ch.state[variable], hl));
        }

        for (const edge of Object.values(s.relations).filter(e=>e.observer===observer)) {
            const key=edgeKey(edge.observer,edge.target);
            const rskip = new Set([...(reinforcedRelation.get(key) ?? []), ...(maintainedRelation.get(key) ?? [])]);
            for (const variable of RELATION_DYNAMIC_VARIABLES) {
                if (rskip.has(variable) || edge.dynamic?.[variable] === undefined) continue;
                const hl = effectiveHalfLife(variable, observer);
                if (!hl) continue;
                edge.dynamic[variable] = clampVariable(variable, decayTowardZero(edge.dynamic[variable], hl));
            }
        }
    }

    for (const item of valid) {
        const {u,observer,target,characterKeys,relationKeys,severity}=item;
        const context = u?.context ?? {};
        const ch = ensureCharacter(observer);
        const edge = target ? ensureEdge(observer,target) : null;
        if (edge) edge.status='active';

        for (const variable of characterKeys) {
            const base = Number.isFinite(Number(ch.state?.[variable])) ? Number(ch.state[variable]) : 0;
            const delta = applyMechanicalDelta(variable,u.characterDelta[variable],base,observer,null,context,severity);
            ch.state[variable] = clampVariable(variable,base+delta);
            ch.stateMeta[variable] = { lastReinforcedTurn:turn, lastUpdatedAt:nowIso(), reason:String(u?.reason ?? '') };
        }

        for (const variable of relationKeys) {
            if (!edge) continue;
            const bucket = RELATION_LONG_VARIABLES.includes(variable) ? edge.longTerm : edge.dynamic;
            const base = Number.isFinite(Number(bucket?.[variable])) ? Number(bucket[variable]) : 0;
            const delta = applyMechanicalDelta(variable,u.relationshipDelta[variable],base,observer,edge,context,severity);
            let next = clampVariable(variable,base+delta);
            if (variable === 'Shyness') next = Math.min(next, shynessCeiling(observer,edge,context));
            bucket[variable] = next;
            edge.stateMeta[variable] = { lastReinforcedTurn:turn, lastUpdatedAt:nowIso(), reason:String(u?.reason ?? '') };
        }

        if (edge) {
            edge.activeThreads ??= [];
            // v0.4.1 Thread Gate: only accept structured candidates that explicitly
            // prove an unresolved future-facing open loop. This prevents completed
            // scene summaries (e.g. finished flirting) from becoming Threads.
            for (const rawThread of u?.addThreads ?? []) {
                const t = normalizeThreadCandidate(rawThread, turn);
                if (!t) continue;
                const duplicate = edge.activeThreads.some(v =>
                    String(v?.text ?? '').trim().toLowerCase() === t.text.toLowerCase()
                    || String(v?.id ?? '') === t.id
                );
                if (!duplicate) edge.activeThreads.push(t);
            }
            for (const r of u?.resolveThreads ?? []) {
                edge.activeThreads = edge.activeThreads.filter(t => !threadMatchesResolution(t, r));
            }
            for (const m of u?.memories ?? []) {
                const x=String(typeof m === 'object' && m ? (m.text ?? '') : m).trim();
                if (x) edge.memories.push({ text:x, at:nowIso(), reason:String(u?.reason ?? '') });
            }
            edge.activeThreads=edge.activeThreads.filter(t => t && typeof t === 'object' && t.id && t.text).slice(-20);
            edge.memories=edge.memories.slice(-50);
            edge.lastUpdatedAt=nowIso();
        }
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
            toast('warning', '当前版本只对最新一条 AI 回复提供精确 rollback；历史消息暂不回退。');
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
    if (!parsed || typeof parsed !== 'object' || !parsed.relations) throw new Error('无效的 Psychology Engine 状态文件');
    ctx().chatMetadata[METADATA_KEY] = migrateStateTo040(parsed);
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

    if (el) el.textContent = getSettings().enabled ? 'Single-pass 已启用 · Dynamics v0.4.2 · 最新回复可Rollback' : '已关闭';
    if (!initEl) return;
    if (!cardName) { initEl.innerHTML='<span class="psy-warn">未检测到当前卡片上下文</span>'; return; }
    if (context?.isContainer === true) {
        const names=(context.actorNames ?? []).filter(profileExists);
        initEl.innerHTML=`<span class="psy-ok">✓ 卡片容器：${escapeHtml(cardName)}</span><div>实际角色：${names.length?names.map(escapeHtml).join('、'):'等待初始化'}</div>`;
    } else if (context?.isContainer === false && profileExists(cardName)) {
        initEl.innerHTML=`<span class="psy-ok">✓ ${escapeHtml(cardName)} 已初始化</span>`;
    } else if (actors.length) {
        initEl.innerHTML=`<span class="psy-warn">○ ${escapeHtml(cardName)} 身份待确认</span><div>已知实际角色：${actors.map(escapeHtml).join('、')}</div>`;
    } else {
        initEl.innerHTML=`<span class="psy-warn">○ ${escapeHtml(cardName)} 将在下一次主回复中识别实际角色并初始化</span>`;
    }
}


function renderStateViewer() {
    const box = document.getElementById('psy_state_viewer');
    if (!box) return;
    const s=getState();
    const user=currentUserName();
    const actorSections=confirmedActorNames().map(name=>{
        const ch=s.characters[name];
        const state=Object.entries(ch?.state ?? {}).map(([k,v])=>`<span><b>${escapeHtml(k)}</b> ${v}</span>`).join('');
        const inv=(ch?.psychologyProfile?.invariants ?? []).map(x=>`<li>${escapeHtml(x)}</li>`).join('');
        return `<details class="psy-edge"><summary>${escapeHtml(name)} · Character State</summary><div class="psy-grid">${state||'<span>暂无显著自身状态</span>'}</div>${inv?`<ul class="psy-threads">${inv}</ul>`:''}</details>`;
    }).join('');

    const rows=Object.values(s.relations).filter(e=>isEligibleActor(e.observer)).filter(e=>e.target===user||isEligibleActor(e.target)).sort((a,b)=>edgeKey(a.observer,a.target).localeCompare(edgeKey(b.observer,b.target)));
    const relSections=rows.map(edge=>{
        const longTerm=Object.entries(edge.longTerm ?? {}).map(([k,v])=>`<span><b>${escapeHtml(k)}</b> ${v}</span>`).join('');
        const dynamic=Object.entries(edge.dynamic ?? {}).filter(([,v])=>Math.abs(Number(v)||0)>0).map(([k,v])=>`<span><b>${escapeHtml(k)}</b> ${v}</span>`).join('');
        const status=edge.status==='uninitialized'?'<span class="psy-uninit">未初始化</span>':'';
        return `<details class="psy-edge"><summary>${escapeHtml(edge.observer)} → ${escapeHtml(edge.target)} ${status} · Familiarity ${relationshipFamiliarity(edge).toFixed(2)}</summary><div class="psy-grid">${longTerm||'<span>暂无长期值</span>'}</div><div class="psy-grid psy-derived">${dynamic||'<span>暂无动态值</span>'}</div>${edge.activeThreads?.length?`<div class="psy-threads"><b>Unresolved Threads:</b> ${edge.activeThreads.map(t=>escapeHtml(t?.text ?? '')).filter(Boolean).join(' · ')}</div>`:''}</details>`;
    }).join('');
    box.innerHTML=(actorSections+relSections)||'<div class="psy-empty">尚无心理状态。</div>';
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
        <b>Psychology Engine v0.4.2 · Regenerate Rollback Fix</b>
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

async function onGenerationStarted(type, _options, dryRun = false) {
    generationActive = true;

    // Native SillyTavern has two different replacement paths:
    //   1) swipe/overswipe -> MESSAGE_SWIPED is emitted before Generate('swipe')
    //   2) explicit Regenerate -> Generate('regenerate') deletes the last assistant
    //      message later, without emitting MESSAGE_SWIPED.
    //
    // Roll back here for explicit regeneration, while the old assistant message
    // (and its transaction snapshot in message.extra) still exists.
    // GENERATION_STARTED is awaited by SillyTavern before it removes the old
    // message and assembles the new prompt, so refreshInjection() below makes
    // the replacement generation see the exact pre-reply psychology state.
    if (type === 'regenerate' && !dryRun) {
        const c = ctx();
        const chat = c?.chat ?? [];
        const lastId = chat.length - 1;
        const last = chat[lastId];

        // SillyTavern treats Regenerate on a trailing user message as a normal
        // new assistant generation. In that case there is nothing to replace,
        // so do NOT roll back the previous assistant turn.
        if (lastId >= 0 && last && !last.is_user && !last.is_system) {
            const rolledBack = await rollbackMessageTransaction(lastId, { silent: true });
            if (rolledBack) {
                const state = getState();
                state.runtime.lastRegenerateRollback = {
                    messageId: lastId,
                    at: nowIso(),
                };
                saveState();
                await refreshInjection();
            }
        }
    }
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
    console.log('[Psychology Engine] v0.4.2 regenerate rollback fix initialized');
}

window.init = init;
init();
