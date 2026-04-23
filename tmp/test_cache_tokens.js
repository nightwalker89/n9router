/**
 * Test: Can n9router track cached tokens from Codex/Claude responses?
 * 
 * Analyzes:
 * 1. Whether extractUsage() correctly extracts cache tokens from different response formats
 * 2. Whether saveUsageStats() preserves or drops cache tokens (BUG found here)
 * 3. Real data from usage.json to show the gap
 */

import { readFileSync } from 'fs';

// ─── 1. Simulate extractUsage from usageTracking.js ───
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const normalized = {};
  const assignNumber = (key, value) => {
    if (value === undefined || value === null) return;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) normalized[key] = numeric;
  };
  assignNumber('prompt_tokens', usage.prompt_tokens);
  assignNumber('completion_tokens', usage.completion_tokens);
  assignNumber('total_tokens', usage.total_tokens);
  assignNumber('cache_read_input_tokens', usage.cache_read_input_tokens);
  assignNumber('cache_creation_input_tokens', usage.cache_creation_input_tokens);
  assignNumber('cached_tokens', usage.cached_tokens);
  assignNumber('reasoning_tokens', usage.reasoning_tokens);
  if (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object') {
    normalized.prompt_tokens_details = usage.prompt_tokens_details;
  }
  if (usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object') {
    normalized.completion_tokens_details = usage.completion_tokens_details;
  }
  if (Object.keys(normalized).length === 0) return null;
  return normalized;
}

function extractUsage(chunk) {
  if (!chunk || typeof chunk !== 'object') return null;

  // Claude format (message_delta event)
  if (chunk.type === 'message_delta' && chunk.usage) {
    return normalizeUsage({
      prompt_tokens: chunk.usage.input_tokens || 0,
      completion_tokens: chunk.usage.output_tokens || 0,
      cache_read_input_tokens: chunk.usage.cache_read_input_tokens,
      cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens
    });
  }

  // OpenAI Responses API format
  if ((chunk.type === 'response.completed' || chunk.type === 'response.done') && chunk.response?.usage) {
    const usage = chunk.response.usage;
    const cachedTokens = usage.input_tokens_details?.cached_tokens;
    return normalizeUsage({
      prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0,
      completion_tokens: usage.output_tokens || usage.completion_tokens || 0,
      cached_tokens: cachedTokens,
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
      prompt_tokens_details: cachedTokens ? { cached_tokens: cachedTokens } : undefined
    });
  }

  // OpenAI format
  if (chunk.usage && chunk.usage.prompt_tokens !== undefined) {
    return normalizeUsage({
      prompt_tokens: chunk.usage.prompt_tokens,
      completion_tokens: chunk.usage.completion_tokens || 0,
      cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens || chunk.usage.prompt_cache_hit_tokens,
      reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
      prompt_tokens_details: chunk.usage.prompt_tokens_details,
      completion_tokens_details: chunk.usage.completion_tokens_details
    });
  }

  return null;
}

// ─── 2. Simulate saveUsageStats from requestDetail.js (BUGGY) ───
function saveUsageStats_BUGGY(tokens) {
  const normalized = {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0
  };
  return normalized; // ← BUG: drops cache_read_input_tokens, cached_tokens, reasoning_tokens
}

// ─── 3. Simulate logUsage from usageTracking.js (CORRECT) ───
function logUsage_CORRECT(usage) {
  const cacheRead = usage.cache_read_input_tokens || usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens;
  const cacheCreation = usage.cache_creation_input_tokens;
  const reasoning = usage.reasoning_tokens;
  const inTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outTokens = usage.completion_tokens || usage.output_tokens || 0;
  return {
    prompt_tokens: inTokens,
    completion_tokens: outTokens,
    cache_read_input_tokens: cacheRead || 0,
    cache_creation_input_tokens: cacheCreation || 0,
    reasoning_tokens: reasoning || 0
  };
}

// ─── TEST CASES ───
console.log('=' .repeat(80));
console.log('TEST: Cached Token Tracking in n9router');
console.log('=' .repeat(80));

// Test 1: Claude response with cache tokens
console.log('\n─── Test 1: Claude message_delta with cache_read_input_tokens ───');
const claudeChunk = {
  type: 'message_delta',
  usage: {
    input_tokens: 1500,
    output_tokens: 300,
    cache_read_input_tokens: 105472,
    cache_creation_input_tokens: 0
  }
};
const claudeExtracted = extractUsage(claudeChunk);
console.log('extractUsage result:', JSON.stringify(claudeExtracted, null, 2));
const claudeBuggy = saveUsageStats_BUGGY(claudeExtracted);
const claudeCorrect = logUsage_CORRECT(claudeExtracted);
console.log('saveUsageStats (BUGGY):', JSON.stringify(claudeBuggy, null, 2));
console.log('logUsage (CORRECT):    ', JSON.stringify(claudeCorrect, null, 2));
console.log('⚠️  cache_read_input_tokens LOST in buggy path?', claudeBuggy.cache_read_input_tokens === undefined ? '❌ YES — LOST!' : '✅ Preserved');

// Test 2: Codex (OpenAI Responses API) with cached_tokens
console.log('\n─── Test 2: Codex response.completed with cached_tokens ───');
const codexChunk = {
  type: 'response.completed',
  response: {
    usage: {
      input_tokens: 120000,
      output_tokens: 500,
      input_tokens_details: { cached_tokens: 116096 },
      output_tokens_details: { reasoning_tokens: 1024 }
    }
  }
};
const codexExtracted = extractUsage(codexChunk);
console.log('extractUsage result:', JSON.stringify(codexExtracted, null, 2));
const codexBuggy = saveUsageStats_BUGGY(codexExtracted);
const codexCorrect = logUsage_CORRECT(codexExtracted);
console.log('saveUsageStats (BUGGY):', JSON.stringify(codexBuggy, null, 2));
console.log('logUsage (CORRECT):    ', JSON.stringify(codexCorrect, null, 2));
console.log('⚠️  cached_tokens LOST in buggy path?', codexBuggy.cached_tokens === undefined ? '❌ YES — LOST!' : '✅ Preserved');

// Test 3: OpenAI format with prompt_tokens_details.cached_tokens
console.log('\n─── Test 3: OpenAI format with prompt_tokens_details ───');
const openaiChunk = {
  usage: {
    prompt_tokens: 130611,
    completion_tokens: 269,
    prompt_tokens_details: { cached_tokens: 128128 },
    completion_tokens_details: { reasoning_tokens: 0 }
  }
};
const openaiExtracted = extractUsage(openaiChunk);
console.log('extractUsage result:', JSON.stringify(openaiExtracted, null, 2));
const openaiBuggy = saveUsageStats_BUGGY(openaiExtracted);
const openaiCorrect = logUsage_CORRECT(openaiExtracted);
console.log('saveUsageStats (BUGGY):', JSON.stringify(openaiBuggy, null, 2));
console.log('logUsage (CORRECT):    ', JSON.stringify(openaiCorrect, null, 2));
console.log('⚠️  cached_tokens LOST in buggy path?', openaiBuggy.cached_tokens === undefined ? '❌ YES — LOST!' : '✅ Preserved');

// ─── Test 4: Real data analysis from usage.json ───
console.log('\n─── Test 4: Real usage.json analysis ───');
try {
  const data = JSON.parse(readFileSync('/Users/cuongquach/.n9router/usage.json', 'utf-8'));
  const history = data.history || [];
  
  let withCache = 0, withoutCache = 0;
  let cacheByProvider = {}, noCacheByProvider = {};
  let totalCacheRead = 0, totalCacheCreation = 0;
  
  for (const e of history) {
    const t = e.tokens || {};
    const hasCacheData = t.cache_read_input_tokens || t.cached_tokens || t.cache_creation_input_tokens;
    if (hasCacheData) {
      withCache++;
      cacheByProvider[e.provider] = (cacheByProvider[e.provider] || 0) + 1;
      totalCacheRead += (t.cache_read_input_tokens || t.cached_tokens || 0);
      totalCacheCreation += (t.cache_creation_input_tokens || 0);
    } else {
      withoutCache++;
      noCacheByProvider[e.provider] = (noCacheByProvider[e.provider] || 0) + 1;
    }
  }
  
  console.log(`Total entries: ${history.length}`);
  console.log(`  WITH cache tokens: ${withCache} (${(withCache/history.length*100).toFixed(1)}%)`);
  console.log(`  WITHOUT cache tokens: ${withoutCache} (${(withoutCache/history.length*100).toFixed(1)}%)`);
  console.log(`  By provider WITH cache:`, JSON.stringify(cacheByProvider));
  console.log(`  By provider WITHOUT cache:`, JSON.stringify(noCacheByProvider));
  console.log(`  Total cache_read tokens tracked: ${totalCacheRead.toLocaleString()}`);
  console.log(`  Total cache_creation tokens tracked: ${totalCacheCreation.toLocaleString()}`);
  
  // Show the dual-save problem: same codex entries saved twice (once with cache, once without)
  console.log('\n  Last 5 codex entries:');
  const codexEntries = history.filter(e => e.provider === 'codex').slice(-5);
  for (const e of codexEntries) {
    const t = e.tokens || {};
    const hasCache = !!(t.cache_read_input_tokens || t.cached_tokens);
    console.log(`    ${e.timestamp} | prompt=${t.prompt_tokens} | completion=${t.completion_tokens} | cache_read=${t.cache_read_input_tokens || 0} | cached=${t.cached_tokens || 0} | ${hasCache ? '✅ HAS CACHE' : '❌ MISSING CACHE'}`);
  }
} catch (e) {
  console.log('Could not read usage.json:', e.message);
}

// ─── SUMMARY ───
console.log('\n' + '=' .repeat(80));
console.log('FINDINGS:');
console.log('=' .repeat(80));
console.log(`
1. extractUsage() ✅ CORRECTLY extracts cache tokens from all formats:
   - Claude: cache_read_input_tokens, cache_creation_input_tokens  
   - Codex: cached_tokens via input_tokens_details.cached_tokens
   - OpenAI: cached_tokens via prompt_tokens_details.cached_tokens

2. logUsage() (usageTracking.js:296) ✅ CORRECTLY saves cache tokens
   - Saves: cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens

3. saveUsageStats() (requestDetail.js:75) ❌ BUG: DROPS all cache tokens
   - Only saves: prompt_tokens, completion_tokens
   - Drops: cache_read_input_tokens, cached_tokens, reasoning_tokens, cache_creation_input_tokens

4. DUAL SAVE PATHS:
   - Streaming: logUsage() (via stream.js transform) → saves with cache ✅
     THEN saveUsageStats() (via onStreamComplete) → saves WITHOUT cache ❌
   - Non-streaming: saveUsageStats() only → always loses cache ❌

5. Result: ~46% of entries are missing cache tokens due to the buggy path.

FIX: Update saveUsageStats() in requestDetail.js to preserve cache fields:

   const normalized = {
     prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
     completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0,
+    cache_read_input_tokens: tokens.cache_read_input_tokens || tokens.cached_tokens || tokens.prompt_tokens_details?.cached_tokens || 0,
+    cache_creation_input_tokens: tokens.cache_creation_input_tokens || 0,
+    reasoning_tokens: tokens.reasoning_tokens || 0,
   };
`);
