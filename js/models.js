// النماذج المتاحة عبر kie.ai (docs.kie.ai — نوفمبر 2026)
import { settings } from './db.js?v=14';
// api: anthropic = /claude/v1/messages · responses = صيغة OpenAI Responses · chat = صيغة Chat Completions
// tools: يقدر يستدعي أدوات البحث وتوليد الصور بنفسه · search: native = بحث Google مدمج، tool = أداتنا، pre = نبحث قبل السؤال

export const MODELS = [
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    maker: 'Anthropic',
    api: 'anthropic',
    tools: true,
    search: 'tool',
    badge: 'الأقوى',
    tagline: 'أقوى نموذج متاح — للمهام الصعبة والطويلة',
    features: ['أعمق تفكير وتحليل بين كل النماذج', 'أفضل كتابة عربية وإبداعية ونصوص إعلانية', 'برمجة ومهام معقدة متعددة الخطوات', 'يقرأ الصور والملفات ويبحث ويرسم بنفسه'],
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    maker: 'Anthropic',
    api: 'anthropic',
    tools: true,
    search: 'tool',
    tagline: 'قريب جداً من الأقوى وأسرع وأرخص بكثير',
    features: ['تحليل دقيق وكتابة عربية ممتازة', 'ممتاز في البرمجة والتخطيط', 'خيار ذكي للاستخدام اليومي الجاد', 'يقرأ الصور والملفات ويبحث ويرسم بنفسه'],
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    maker: 'Anthropic',
    api: 'anthropic',
    tools: true,
    search: 'tool',
    tagline: 'توازن بين السرعة والجودة',
    features: ['سريع وجودته عالية', 'مناسب للأسئلة اليومية والكتابة والتلخيص', 'يقرأ الصور والملفات ويبحث ويرسم بنفسه'],
  },
  {
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    maker: 'Anthropic',
    api: 'anthropic',
    tools: true,
    search: 'tool',
    badge: 'الأسرع',
    tagline: 'خفيف وسريع جداً ورخيص',
    features: ['ردود فورية تقريباً', 'للأسئلة البسيطة والترجمة والتصحيح', 'يقرأ الصور ويبحث ويرسم'],
  },
  {
    id: 'gpt-6-1-sol',
    name: 'GPT 6.1 Sol',
    maker: 'OpenAI',
    api: 'responses',
    url: '/codex/v1/responses',
    tools: true,
    search: 'tool',
    effort: ['low', 'high'],
    tagline: 'أحدث نموذج رئيسي من OpenAI',
    features: ['ذاكرة ضخمة: مليون توكن (كتب وملفات طويلة كاملة)', 'قوي في الرياضيات والمنطق والتحليل', 'تفكير قابل للتعميق', 'يقرأ الصور والملفات ويبحث ويرسم بنفسه'],
  },
  {
    id: 'gpt-6-1-terra',
    name: 'GPT 6.1 Terra',
    maker: 'OpenAI',
    api: 'responses',
    url: '/codex/v1/responses',
    tools: true,
    search: 'tool',
    effort: ['low', 'high'],
    tagline: 'GPT اقتصادي بنفس الذاكرة الضخمة',
    features: ['ذاكرة مليون توكن', 'سعره منخفض جداً للاستخدام الكثير', 'يقرأ الصور والملفات ويبحث ويرسم بنفسه'],
  },
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    maker: 'Google',
    api: 'chat',
    url: '/gemini-4-argon-openai/v1/chat/completions',
    tools: false,
    search: 'native',
    tagline: 'أقوى نماذج Google — بحث Google مدمج',
    features: ['بحث Google مباشر بمعلومات اليوم', 'يفهم الصور وPDF والفيديو والصوت', 'ممتاز في الأسئلة العامة والمعلومات الحديثة'],
  },
  {
    id: 'gemini-3-8-flash',
    name: 'Gemini 3.8 Flash',
    maker: 'Google',
    api: 'chat',
    url: '/gemini-3-8-flash-openai/v1/chat/completions',
    tools: false,
    search: 'native',
    tagline: 'سريع جداً مع بحث Google',
    features: ['سرعة عالية وسعر قليل', 'بحث Google مدمج', 'يفهم الصور وPDF'],
  },
  {
    id: 'grok-4-7',
    name: 'Grok 4.7',
    maker: 'xAI',
    api: 'responses',
    url: '/grok/v1/responses',
    tools: true,
    search: 'tool',
    effort: ['low', 'high'],
    tagline: 'أسلوب مباشر وصريح بدون لف ودوران',
    features: ['ردود جريئة ومباشرة', 'تفكير قابل للتعميق', 'يقرأ الصور ويبحث ويرسم بنفسه'],
  },
  {
    id: 'deepseek-v4-1-flash',
    name: 'DeepSeek V4.1 Flash',
    maker: 'DeepSeek',
    api: 'responses',
    url: '/openai/v1/responses',
    tools: false,
    search: 'pre',
    effort: ['low', 'high'],
    badge: 'الأرخص',
    tagline: 'رخيص جداً وذكي في الرياضيات والبرمجة',
    features: ['أرخص نموذج تقريباً', 'تفكير منطقي قوي', 'يقرأ الصور'],
  },
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    maker: 'Moonshot',
    api: 'responses',
    url: '/openai/v1/responses',
    tools: false,
    search: 'pre',
    effort: ['low', 'high'],
    tagline: 'قوي في النصوص الطويلة والبرمجة',
    features: ['يتعامل مع مستندات طويلة', 'جيد في البرمجة والتلخيص', 'يقرأ الصور'],
  },
];

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
// البحث في الإنترنت لأي نموذج يمر عبر Gemini Flash مع بحث Google
export const SEARCH_MODEL = 'gemini-3-8-flash';
export const IMAGE_MODEL = 'nano-banana-2-1';

export const OR_DEFAULT_MODEL = 'or:anthropic/claude-sonnet-5.5';
export const OR_AUDIO_MODEL = 'or:google/gemini-3.8-flash';
const starters = [
  ['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', ['text', 'image']],
  ['openai/gpt-6.1-sol', 'GPT 6.1 Sol', ['text', 'image']],
  ['openai/gpt-6.1-terra', 'GPT 6.1 Terra', ['text', 'image']],
  ['google/gemini-3.8-flash', 'Gemini 3.8 Flash', ['text', 'image', 'audio']],
].map(([id, name, input]) => ({ id, name, architecture: { input_modalities: input, output_modalities: ['text'] }, supported_parameters: ['reasoning', 'tools'] }));

export function registerOpenRouterModels(raw) {
  const fresh = (Array.isArray(raw) ? raw : []).filter((m) => typeof m.id === 'string' && /^[\w./:-]+$/.test(m.id) && !m.id.endsWith(':batch') && m.architecture?.output_modalities?.includes('text') && m.architecture?.input_modalities?.includes('text')).map((m) => {
    const input = m.architecture.input_modalities;
    return { id: `or:${m.id}`, remoteId: m.id, provider: 'openrouter', api: 'openrouter', name: String(m.name || m.id).replace(/^[^:]+: /, ''), maker: m.id.split('/')[0], search: 'openrouter', tools: false, reasoning: m.supported_parameters?.includes('reasoning'), vision: input.includes('image'), audio: input.includes('audio'), tagline: 'عبر OpenRouter', features: ['محادثة وبحث عبر OpenRouter', ...(input.includes('image') ? ['يفهم الصور المرفقة'] : []), ...(input.includes('audio') ? ['يدعم إدخال الصوت'] : [])] };
  });
  if (!fresh.length) return false;
  const seen = new Set(fresh.map((m) => m.id));
  // نحفظ وصف النماذج القديمة لعرض أسماء المحادثات حتى لو أُزيلت من الكتالوج.
  for (const m of fresh) {
    const index = MODELS.findIndex((old) => old.id === m.id);
    if (index < 0) MODELS.push(m);
    else MODELS[index] = m;
  }
  return seen.size;
}
registerOpenRouterModels(starters);
registerOpenRouterModels(settings.get('orCatalog', []));
export const providerOf = (id) => String(id || '').startsWith('or:') ? 'openrouter' : 'kie';
export const modelsFor = (provider) => MODELS.filter((m) => (m.provider || 'kie') === provider);

export const modelById = (id) => MODELS.find((m) => m.id === id) || (providerOf(id) === 'openrouter' ? { id, remoteId: String(id).slice(3), provider: 'openrouter', api: 'openrouter', name: String(id).slice(3), tagline: 'عبر OpenRouter', maker: 'OpenRouter', search: 'openrouter', tools: false, features: [] } : MODELS.find((m) => m.id === DEFAULT_MODEL));
