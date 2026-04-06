
import dotenv from 'dotenv';
dotenv.config();
import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });

const OPENROUTER_API_KEY: string = process.env.OPENROUTER_API_KEY || '';
const NVIDIA_API_KEY: string = process.env.NVIDIA_API_KEY || '';
const CEREBRAS_API_KEY: string = process.env.CEREBRAS_API_KEY || '';
const SAMBANOVA_API_KEY: string = process.env.SAMBANOVA_API_KEY || '';

// ─── Model Config per Provider ────────────────────────────────────────────

const NVIDIA_MODELS: Record<string, string> = {
    SIMPLE:   'meta/llama-3.1-8b-instruct',
    MODERATE: 'qwen/qwen2.5-coder-32b-instruct',
    COMPLEX:  'meta/llama-3.3-70b-instruct'
};

const CEREBRAS_MODELS: Record<string, string> = {
    SIMPLE:   'llama3.1-8b',
    MODERATE: 'qwen-3-235b-a22b-instruct-2507',
    COMPLEX:  'qwen-3-235b-a22b-instruct-2507'
};

const SAMBANOVA_MODELS: Record<string, string> = {
    SIMPLE:   'Meta-Llama-3.1-8B-Instruct',
    MODERATE: 'Qwen3-32B',
    COMPLEX:  'Meta-Llama-3.3-70B-Instruct'
};

// ─── Provider Health Tracker ──────────────────────────────────────────────
// Tracks remaining tokens/requests from response headers per provider.
// Providers are dynamically sorted: healthiest first.

const providerHealth: Record<string, any> = {
    nvidia: {
        name: 'NVIDIA',
        hasKey: !!NVIDIA_API_KEY,
        remainingRequests: Infinity,
        remainingTokens: Infinity,
        lastError: null,
        lastSuccess: null,
        consecutiveFailures: 0,
        cooldownUntil: 0,
    },
    cerebras: {
        name: 'Cerebras',
        hasKey: !!CEREBRAS_API_KEY,
        remainingRequests: Infinity,
        remainingTokens: Infinity,
        lastError: null,
        lastSuccess: null,
        consecutiveFailures: 0,
        cooldownUntil: 0,
    },
    groq: {
        name: 'Groq',
        hasKey: !!process.env.GROQ_API_KEY,
        remainingRequests: Infinity,
        remainingTokens: Infinity,
        lastError: null,
        lastSuccess: null,
        consecutiveFailures: 0,
        cooldownUntil: 0,
    },
    openrouter: {
        name: 'OpenRouter',
        hasKey: !!OPENROUTER_API_KEY,
        remainingRequests: Infinity,
        remainingTokens: Infinity,
        lastError: null,
        lastSuccess: null,
        consecutiveFailures: 0,
        cooldownUntil: 0,
    },
    sambanova: {
        name: 'SambaNova',
        hasKey: !!SAMBANOVA_API_KEY,
        remainingRequests: Infinity,
        remainingTokens: Infinity,
        lastError: null,
        lastSuccess: null,
        consecutiveFailures: 0,
        cooldownUntil: 0,
    }
};

const COOLDOWN_MS = 60000; // 1 min cooldown after 3 consecutive failures

/**
 * Update provider health from response headers.
 */
function updateHealth(providerId: string, headers: any): void {
    const h = providerHealth[providerId];
    if (!h || !headers) return;

    // Parse remaining requests (prefer per-minute, fallback to generic)
    const remainReqMin = headers.get('x-ratelimit-remaining-requests-minute');
    const remainReq = headers.get('x-ratelimit-remaining-requests');
    if (remainReqMin !== null) h.remainingRequests = parseInt(remainReqMin, 10);
    else if (remainReq !== null) h.remainingRequests = parseInt(remainReq, 10);

    // Parse remaining tokens (prefer per-minute, fallback to generic)
    const remainTokMin = headers.get('x-ratelimit-remaining-tokens-minute');
    const remainTok = headers.get('x-ratelimit-remaining-tokens');
    if (remainTokMin !== null) h.remainingTokens = parseInt(remainTokMin, 10);
    else if (remainTok !== null) h.remainingTokens = parseInt(remainTok, 10);
}

function recordSuccess(providerId: string): void {
    const h = providerHealth[providerId];
    h.lastSuccess = Date.now();
    h.lastError = null;
    h.consecutiveFailures = 0;
    h.cooldownUntil = 0;
}

function recordFailure(providerId: string, errMsg: string): void {
    const h = providerHealth[providerId];
    h.lastError = errMsg;
    h.consecutiveFailures++;
    if (h.consecutiveFailures >= 3) {
        h.cooldownUntil = Date.now() + COOLDOWN_MS;
    }
    // If rate limited, set tokens/requests to 0
    if (errMsg.includes('429') || errMsg.includes('rate limit') || errMsg.includes('Rate limit')) {
        h.remainingRequests = 0;
        h.remainingTokens = 0;
    }
    if (errMsg.includes('402') || errMsg.includes('payment')) {
        h.remainingRequests = 0;
    }
}

/**
 * Score a provider for sorting. Higher = healthier = tried first.
 */
function healthScore(providerId: string): number {
    const h = providerHealth[providerId];
    if (!h.hasKey) return -1000;
    if (Date.now() < h.cooldownUntil) return -500;

    let score = 100;

    // Penalize low remaining requests
    if (h.remainingRequests <= 0) score -= 200;
    else if (h.remainingRequests < 5) score -= 50;
    else if (h.remainingRequests < 20) score -= 10;

    // Penalize low remaining tokens
    if (h.remainingTokens <= 0) score -= 200;
    else if (h.remainingTokens < 1000) score -= 50;
    else if (h.remainingTokens < 5000) score -= 10;

    // Penalize consecutive failures
    score -= h.consecutiveFailures * 30;

    // Boost recently successful providers
    if (h.lastSuccess && Date.now() - h.lastSuccess < 60000) score += 10;

    return score;
}

/**
 * Returns provider IDs sorted by health (best first), excluding those without keys.
 */
function getSortedProviders(): string[] {
    const ids = Object.keys(providerHealth).filter(id => providerHealth[id].hasKey);
    ids.sort((a, b) => healthScore(b) - healthScore(a));
    return ids;
}

/**
 * Returns current health status for all providers (for logging/API).
 */
function getProviderStatus(): Record<string, any> {
    const status: Record<string, any> = {};
    for (const [id, h] of Object.entries(providerHealth)) {
        status[id] = {
            name: h.name,
            active: h.hasKey,
            score: h.hasKey ? healthScore(id) : 'no key',
            remainingRequests: h.remainingRequests === Infinity ? 'unknown' : h.remainingRequests,
            remainingTokens: h.remainingTokens === Infinity ? 'unknown' : h.remainingTokens,
            consecutiveFailures: h.consecutiveFailures,
            cooldown: Date.now() < h.cooldownUntil,
            lastError: h.lastError
        };
    }
    return status;
}

// ─── Provider Implementations ─────────────────────────────────────────────

async function callNvidia(prompt: string, maxTokens: number, temperature: number, complexity: string): Promise<{ content: string; model: string }> {
    if (!NVIDIA_API_KEY) throw new Error('NVIDIA API Key missing');
    const model = NVIDIA_MODELS[complexity] || NVIDIA_MODELS.MODERATE;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
            'Authorization': `Bearer ${NVIDIA_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens
        })
    }).finally(() => clearTimeout(timeout));

    updateHealth('nvidia', response.headers);

    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`NVIDIA HTTP ${response.status} ${errBody.slice(0, 200)}`);
    }

    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content.trim()) throw new Error('NVIDIA returned empty content');
    return { content, model };
}

async function callCerebras(prompt: string, maxTokens: number, temperature: number, complexity: string): Promise<{ content: string; model: string }> {
    if (!CEREBRAS_API_KEY) throw new Error('Cerebras API Key missing');
    const model = CEREBRAS_MODELS[complexity] || CEREBRAS_MODELS.MODERATE;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
            'Authorization': `Bearer ${CEREBRAS_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens
        })
    }).finally(() => clearTimeout(timeout));

    updateHealth('cerebras', response.headers);

    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Cerebras HTTP ${response.status} ${errBody.slice(0, 200)}`);
    }

    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content.trim()) throw new Error('Cerebras returned empty content');
    return { content, model };
}

async function callGroq(prompt: string, maxTokens: number, temperature: number): Promise<{ content: string; model: string }> {
    if (!process.env.GROQ_API_KEY) throw new Error('Groq API Key missing');

    const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        temperature,
        max_tokens: maxTokens
    });

    // Groq SDK doesn't expose headers directly — update from error responses only
    const content = completion.choices[0]?.message?.content || '';
    if (!content.trim()) throw new Error('Groq returned empty content');
    return { content, model: 'llama-3.3-70b-versatile' };
}

async function callOpenRouter(prompt: string, maxTokens: number, temperature: number): Promise<{ content: string; model: string }> {
    if (!OPENROUTER_API_KEY) throw new Error('OpenRouter API Key missing');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40000);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'SAP O2C Local Graph System',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'meta-llama/llama-3.1-70b-instruct',
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens
        })
    }).finally(() => clearTimeout(timeout));

    // OpenRouter doesn't expose rate limit headers
    if (!response.ok) {
        throw new Error(`OpenRouter HTTP ${response.status}`);
    }

    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content.trim()) throw new Error('OpenRouter returned empty content');
    return { content, model: 'meta-llama/llama-3.1-70b-instruct' };
}

async function callSambanova(prompt: string, maxTokens: number, temperature: number, complexity: string): Promise<{ content: string; model: string }> {
    if (!SAMBANOVA_API_KEY) throw new Error('SambaNova API Key missing');
    const model = SAMBANOVA_MODELS[complexity] || SAMBANOVA_MODELS.MODERATE;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    const response = await fetch('https://api.sambanova.ai/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
            'Authorization': `Bearer ${SAMBANOVA_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens
        })
    }).finally(() => clearTimeout(timeout));

    updateHealth('sambanova', response.headers);

    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`SambaNova HTTP ${response.status} ${errBody.slice(0, 200)}`);
    }

    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content.trim()) throw new Error('SambaNova returned empty content');
    return { content, model };
}

// Map provider ID to call function
const PROVIDER_FN: Record<string, (...args: any[]) => Promise<{ content: string; model: string }>> = {
    nvidia:     callNvidia,
    cerebras:   callCerebras,
    groq:       callGroq,
    openrouter: callOpenRouter,
    sambanova:  callSambanova,
};

// ─── Shared Utilities ─────────────────────────────────────────────────────

function cleanResponse(responseBody: string): string {
    let sql = responseBody.trim();
    sql = sql.replace(/```sql/gi, '');
    sql = sql.replace(/```/g, '');
    sql = sql.trim();

    // Strip thinking blocks from reasoning models
    sql = sql.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    const selectIndex = sql.search(/\bSELECT\b/i);
    if (selectIndex > 0) {
        sql = sql.substring(selectIndex);
    }

    const lastSemicolon = sql.lastIndexOf(';');
    if (lastSemicolon !== -1) {
        sql = sql.substring(0, lastSemicolon + 1);
    }

    return sql.trim();
}

function buildNLAnswerPrompt(userQuestion: string, rows: any[], rowCount: number, context: string | null = null, datasetName: string | null = null): string {
    const MAX_ROWS_FOR_NL = 10;
    const truncated = rows.slice(0, MAX_ROWS_FOR_NL);
    const rowsJson = JSON.stringify(truncated, null, 2);

    const contextBlock = context
        ? `\nAdditional Business Context:\n${context}\n`
        : '';

    const systemRole = datasetName
        ? `You are a data analyst for the "${datasetName}" dataset.`
        : 'You are a data analyst.';

    return `${systemRole}

The user asked: "${userQuestion}"

The query returned ${rowCount} row(s). Here are the results (up to ${MAX_ROWS_FOR_NL} shown):
${rowsJson}
${contextBlock}
Based ONLY on this data, write a concise natural language answer to the user's question.
Rules:
- Be direct and factual. Do not speculate or add information not present in the data.
- If the data contains IDs, amounts, dates, or counts, mention the specific values.
- If multiple rows are returned, summarize the key findings.
- Keep the answer to 1-3 sentences maximum.
- Do NOT use markdown formatting. Just plain text.
- Do NOT say "based on the data" or "according to the results". Just state the answer directly.`;
}

const MAX_SQL_LENGTH = 3000;

function validateLLMOutput(sql: string): string {
    if (!sql || !sql.trim().toUpperCase().startsWith('SELECT')) {
        throw new Error('Invalid SQL generated by LLM.');
    }
    if (sql.length > MAX_SQL_LENGTH) {
        throw new Error(`Generated SQL exceeds ${MAX_SQL_LENGTH} character limit (${sql.length} chars).`);
    }
    return sql;
}

// ─── Dynamic Orchestrators ────────────────────────────────────────────────

/**
 * SQL generation with dynamic provider ordering.
 * Providers are sorted by health score — healthiest first.
 * Each provider uses complexity-based model routing.
 */
async function getSqlFromLLM(prompt: string, complexity: string = 'MODERATE'): Promise<string> {
    const order = getSortedProviders();
    const orderStr = order.map(id => `${providerHealth[id].name}(${healthScore(id)})`).join(' → ');
    console.log(`[LLM] Provider order: ${orderStr}`);

    for (const providerId of order) {
        const h = providerHealth[providerId];
        const fn = PROVIDER_FN[providerId];
        try {
            const modelInfo = providerId === 'nvidia' ? NVIDIA_MODELS[complexity]
                : providerId === 'cerebras' ? CEREBRAS_MODELS[complexity]
                : providerId === 'sambanova' ? SAMBANOVA_MODELS[complexity]
                : providerId === 'groq' ? 'llama-3.3-70b-versatile'
                : 'llama-3.1-70b-instruct';

            console.log(`[LLM] Attempting ${h.name} (${modelInfo}) for ${complexity} query...`);
            const { content } = await fn(prompt, 1500, 0, complexity);
            const sql = validateLLMOutput(cleanResponse(content));
            recordSuccess(providerId);
            console.log(`[LLM] ${h.name} success. [Remaining: req=${h.remainingRequests}, tok=${h.remainingTokens}]`);
            return sql;
        } catch (err: any) {
            recordFailure(providerId, err.message);
            console.error(`[LLM] ${h.name} failed:`, err.message);
        }
    }

    throw new Error(`All LLM providers (${order.map(id => providerHealth[id].name).join(', ')}) failed to generate SQL.`);
}

/**
 * NL answer generation with dynamic provider ordering.
 */
async function generateNLAnswer(userQuestion: string, rows: any[], rowCount: number, context: string | null = null, complexity: string = 'SIMPLE', datasetName: string | null = null): Promise<string | null> {
    const prompt = buildNLAnswerPrompt(userQuestion, rows, rowCount, context, datasetName);
    const order = getSortedProviders();

    for (const providerId of order) {
        const h = providerHealth[providerId];
        const fn = PROVIDER_FN[providerId];
        try {
            console.log(`[LLM-NL] Attempting ${h.name} for NL answer...`);
            const { content } = await fn(prompt, 300, 0.1, complexity);
            recordSuccess(providerId);
            console.log(`[LLM-NL] ${h.name} NL success.`);
            return content.trim();
        } catch (err: any) {
            recordFailure(providerId, err.message);
            console.error(`[LLM-NL] ${h.name} NL failed:`, err.message);
        }
    }

    return null; // Graceful degradation
}

export {
    getSqlFromLLM,
    generateNLAnswer,
    getProviderStatus,
    NVIDIA_MODELS,
    CEREBRAS_MODELS,
    SAMBANOVA_MODELS
};
