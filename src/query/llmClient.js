require('dotenv').config();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

/**
 * Standardizes an API response payload via the OpenAI Chat Completions interface
 */
async function generateSqlWithGroq(prompt) {
    if (!process.env.GROQ_API_KEY) throw new Error('Groq API Key missing');
    
    // Choose the best reasoning / coding model on Groq
    const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        temperature: 0,
        max_tokens: 1500
    });

    let sql = completion.choices[0]?.message?.content || "";
    return cleanResponse(sql);
}

/**
 * OpenRouter acting as a robust fallback.
 */
async function generateSqlWithOpenRouter(prompt) {
    if (!OPENROUTER_API_KEY) throw new Error('OpenRouter API Key missing');

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'http://localhost:3000', 
            'X-Title': 'SAP O2C Local Graph System',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'meta-llama/llama-3.1-70b-instruct',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: 1500
        })
    });

    if (!response.ok) {
        throw new Error(`OpenRouter HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    let sql = data.choices[0]?.message?.content || "";
    return cleanResponse(sql);
}

/**
 * Helper to strip markdown formatting around SQL responses
 */
function cleanResponse(responseBody) {
    let sql = responseBody.trim();
    
    // Remove all standard block wrappers explicitly
    sql = sql.replace(/```sql/gi, '');
    sql = sql.replace(/```/g, '');
    
    return sql.trim();
}

/**
 * Builds a prompt for natural language answer generation from query results
 */
function buildNLAnswerPrompt(userQuestion, rows, rowCount) {
    // Limit rows sent to LLM to keep context window small
    const MAX_ROWS_FOR_NL = 10;
    const truncated = rows.slice(0, MAX_ROWS_FOR_NL);
    const rowsJson = JSON.stringify(truncated, null, 2);

    return `You are a data analyst for an SAP Order-to-Cash system.

The user asked: "${userQuestion}"

The query returned ${rowCount} row(s). Here are the results (up to ${MAX_ROWS_FOR_NL} shown):
${rowsJson}

Based ONLY on this data, write a concise natural language answer to the user's question.
Rules:
- Be direct and factual. Do not speculate or add information not present in the data.
- If the data contains IDs, amounts, dates, or counts, mention the specific values.
- If multiple rows are returned, summarize the key findings.
- Keep the answer to 1-3 sentences maximum.
- Do NOT use markdown formatting. Just plain text.
- Do NOT say "based on the data" or "according to the results". Just state the answer directly.`;
}

/**
 * Generates a natural language answer from query results via Groq
 */
async function generateNLAnswerWithGroq(prompt) {
    if (!process.env.GROQ_API_KEY) throw new Error('Groq API Key missing');

    const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
        max_tokens: 300
    });

    return (completion.choices[0]?.message?.content || "").trim();
}

/**
 * Generates a natural language answer from query results via OpenRouter
 */
async function generateNLAnswerWithOpenRouter(prompt) {
    if (!OPENROUTER_API_KEY) throw new Error('OpenRouter API Key missing');

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'SAP O2C Local Graph System',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'meta-llama/llama-3.1-70b-instruct',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 300
        })
    });

    if (!response.ok) {
        throw new Error(`OpenRouter HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return (data.choices[0]?.message?.content || "").trim();
}

/**
 * Orchestrates NL answer generation with Groq primary, OpenRouter fallback
 */
async function generateNLAnswer(userQuestion, rows, rowCount) {
    const prompt = buildNLAnswerPrompt(userQuestion, rows, rowCount);

    try {
        console.log(`[LLM-NL] Attempting Groq for NL answer...`);
        const result = await generateNLAnswerWithGroq(prompt);
        console.log(`[LLM-NL] Groq NL success.`);
        return result;
    } catch (groqErr) {
        console.error(`[LLM-NL] Groq NL failed:`, groqErr.message);
        try {
            console.log(`[LLM-NL] Falling back to OpenRouter for NL answer...`);
            const fallbackResult = await generateNLAnswerWithOpenRouter(prompt);
            console.log(`[LLM-NL] OpenRouter NL success.`);
            return fallbackResult;
        } catch (openRouterErr) {
            console.error(`[LLM-NL] OpenRouter NL failed:`, openRouterErr.message);
            return null; // Graceful degradation: return null, caller uses summary fallback
        }
    }
}

/**
 * Orchestrator implementing graceful degradation fallback logic
 */
async function getSqlFromLLM(prompt) {
    try {
        console.log(`[LLM] Attempting Groq (llama-3.1-70b-versatile)...`);
        const result = await generateSqlWithGroq(prompt);
        console.log(`[LLM] Groq success.`);
        return result;
    } catch (groqErr) {
        console.error(`[LLM] Groq failed:`, groqErr.message);
        console.log(`[LLM] Falling back to OpenRouter...`);
        try {
            const fallbackResult = await generateSqlWithOpenRouter(prompt);
            console.log(`[LLM] OpenRouter fallback success.`);
            return fallbackResult;
        } catch (openRouterErr) {
            console.error(`[LLM] OpenRouter failed:`, openRouterErr.message);
            throw new Error('Both Groq and OpenRouter instances failed to generate SQL.');
        }
    }
}

module.exports = {
    getSqlFromLLM,
    generateNLAnswer
};
