export const CODING_ENGINES = {
  claude: { name: 'Claude Code', providers: ['openrouter', 'anthropic'], modelSetting: 'codingClaudeModel' },
  codex: { name: 'Codex', providers: ['openai', 'openrouter'], modelSetting: 'codingCodexModel',
    providerModels: { openrouter: { modelSetting: 'codingCodexOpenRouterModel', defaultModel: 'openai/gpt-5.3-codex' } } },
  antigravity: { name: 'Google Antigravity', providers: ['google'], modelSetting: 'codingAntigravityModel', defaultModel: 'gemini-4-carbon-high' },
  opencode: { name: 'OpenCode', providers: ['openrouter'], modelSetting: 'codingOpenCodeModel', defaultModel: 'openrouter/moonshotai/kimi-k3.1-pro' },
};

export const CODING_PROVIDERS = {
  openrouter: { key: 'openRouterKey', label: 'OpenRouter · مشترك مع الشات' },
  anthropic: { key: 'codingAnthropicKey', label: 'Anthropic API' },
  openai: { key: 'codingOpenAIKey', label: 'OpenAI API' },
  google: { key: 'codingGeminiKey', label: 'Gemini API · Google AI Studio' },
};

export const codingEngineById = id => Object.hasOwn(CODING_ENGINES, id) ? CODING_ENGINES[id] : null;
export const codingEngineName = id => codingEngineById(id)?.name || 'محرك الكمبيوتر';
export function codingModelConfig(engine, provider) {
  const spec = typeof engine === 'string' ? codingEngineById(engine) : engine;
  const config = spec?.providerModels?.[provider];
  return { modelSetting: config?.modelSetting || spec?.modelSetting, defaultModel: config?.defaultModel ?? spec?.defaultModel ?? '' };
}
