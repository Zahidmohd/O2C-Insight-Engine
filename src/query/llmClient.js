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
        model: 'llama-3.1-70b-versatile',
        temperature: 0,
        max_tokens: 500
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
            max_tokens: 500
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
    responseBody = responseBody.trim();
    if (responseBody.startsWith('```sql')) {
        responseBody = responseBody.replace(/^```sql/, '');
        responseBody = responseBody.replace(/```$/, '');
    } else if (responseBody.startsWith('```')) {
        responseBody = responseBody.replace(/^```/, '');
        responseBody = responseBody.replace(/```$/, '');
    }
    return responseBody.trim();
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
    getSqlFromLLM
};
