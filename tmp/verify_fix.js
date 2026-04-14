/**
 * Verify: saveUsageStats fix now preserves cache tokens
 */
// Simulate the FIXED saveUsageStats normalization
function saveUsageStats_FIXED(tokens) {
  const cacheRead = tokens.cache_read_input_tokens || tokens.cached_tokens || tokens.prompt_tokens_details?.cached_tokens || 0;
  const cacheCreation = tokens.cache_creation_input_tokens || 0;
  const reasoning = tokens.reasoning_tokens || tokens.completion_tokens_details?.reasoning_tokens || 0;
  const normalized = {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0,
    ...(cacheRead > 0 && { cache_read_input_tokens: cacheRead }),
    ...(cacheCreation > 0 && { cache_creation_input_tokens: cacheCreation }),
    ...(reasoning > 0 && { reasoning_tokens: reasoning }),
  };
  return normalized;
}

// Test all 3 provider formats
const tests = [
  { name: "Claude", tokens: { prompt_tokens: 1500, completion_tokens: 300, cache_read_input_tokens: 105472 } },
  { name: "Codex", tokens: { prompt_tokens: 120000, completion_tokens: 500, cached_tokens: 116096, reasoning_tokens: 1024 } },
  { name: "OpenAI", tokens: { prompt_tokens: 130611, completion_tokens: 269, prompt_tokens_details: { cached_tokens: 128128 } } },
];

let allPass = true;
for (const t of tests) {
  const result = saveUsageStats_FIXED(t.tokens);
  const hasCacheField = result.cache_read_input_tokens > 0;
  console.log(`${hasCacheField ? '✅' : '❌'} ${t.name}: cache_read=${result.cache_read_input_tokens || 0}, reasoning=${result.reasoning_tokens || 0}`);
  if (!hasCacheField) allPass = false;
}
console.log(allPass ? '\n✅ ALL PASS — cache tokens preserved' : '\n❌ FAILED');
