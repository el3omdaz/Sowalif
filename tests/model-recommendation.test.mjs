import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendModel } from '../js/model-recommendation.js?v=40';

const openrouter = [
  { id: 'or:anthropic/claude-fable-5.2', name: 'Claude Fable 5.2', vision: true },
  { id: 'or:openai/gpt-6-astra', name: 'GPT-6 Astra', vision: true },
  { id: 'or:openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', vision: true },
  { id: 'or:google/gemini-4-carbon', name: 'Gemini 4 Carbon', vision: true },
  { id: 'or:google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', vision: true },
];
const kie = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'gpt-6-1-sol', name: 'GPT-6.1 Sol' },
  { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
];

test('uses the available provider catalog for market analysis and never changes the current model', () => {
  const text = 'حلل حركة الذهب بعد خطاب الفيدرالي';
  const inputs = Object.freeze({ text, models: Object.freeze(openrouter), currentId: openrouter[2].id });
  const recommended = recommendModel(inputs);
  assert.equal(recommended.name, 'Claude Fable 5.2');
  assert.equal(recommended.isCurrent, false);
  assert.equal(inputs.currentId, openrouter[2].id);
  assert.equal(recommendModel({ text, models: kie }).id, 'claude-opus-5-5');
  assert.equal(recommendModel({ text, models: openrouter, currentId: recommended.id }).isCurrent, true);
});

test('distinguishes coding a trading EA from analysing the market', () => {
  assert.equal(recommendModel({ text: 'اكتب كود MQL5 للذهب', models: kie }).id, 'gpt-6-1-sol');
  assert.equal(recommendModel({ text: 'حلل منطق EA معقد في MT5', models: kie }).id, 'gpt-6-astra');
  assert.equal(recommendModel({ text: 'Help with an equation', models: kie }).id, 'gpt-6-astra');
});

test('adapts to image inputs and never recommends a model known to be text-only', () => {
  const textOnly = { ...openrouter[3], vision: false };
  const files = [{ kind: 'image' }];
  assert.equal(recommendModel({ text: 'اقرأ المرفق', files, models: openrouter }).id, openrouter[3].id);
  assert.equal(recommendModel({ text: 'اقرأ المرفق', files, models: [textOnly, openrouter[1]] }).id, openrouter[1].id);
  assert.equal(recommendModel({ text: 'اقرأ المرفق', files, models: [textOnly] }), null);
});

test('keeps short follow-ups grounded in the latest topic and ignores assistant text', () => {
  const history = [
    { role: 'user', text: 'حلل سعر الذهب' },
    { role: 'assistant', text: 'Try debugging the code' },
  ];
  assert.equal(recommendModel({ text: 'كمّل', models: openrouter, history }).id, openrouter[0].id);
  assert.equal(recommendModel({ text: 'باختصار شنو فايدة الشاي', models: openrouter, history }).id, openrouter[4].id);
  history.push({ role: 'user', text: 'شنو فايدة الشاي' });
  assert.equal(recommendModel({ text: 'كمّل', models: openrouter, history }).id, openrouter[2].id);
});

test('uses a conservative current-model fallback for unknown catalog entries', () => {
  const unknown = { id: 'or:other/custom', name: 'Custom' };
  assert.equal(recommendModel({ text: 'مرحبا', models: [unknown], currentId: unknown.id }).isCurrent, true);
  assert.equal(recommendModel({ text: 'مرحبا', models: [] }), null);
});
