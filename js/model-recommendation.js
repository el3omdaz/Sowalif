const model = {
  fable52: 'claude-fable-5-2',
  opus: 'claude-opus-5-5',
  astra: 'gpt-6-astra',
  carbon: 'gemini-4-carbon',
  fable: 'claude-fable-5',
  sol: 'gpt-6-1-sol',
  sonnet: 'claude-sonnet-5-5',
  argon: 'gemini-4-argon',
  flash: 'gemini-3-8-flash',
};

const rankings = {
  markets: [model.fable52, model.opus, model.carbon, model.astra, model.sol, model.sonnet],
  code: [model.sol, model.astra, model.fable52, model.opus, model.sonnet, model.carbon],
  complexCode: [model.astra, model.fable52, model.sol, model.opus, model.carbon, model.sonnet],
  reasoning: [model.astra, model.fable52, model.sol, model.opus, model.carbon, model.fable],
  visual: [model.carbon, model.argon, model.fable52, model.astra, model.opus, model.sol, model.flash],
  writing: [model.fable52, model.opus, model.fable, model.sonnet, model.sol],
  quick: [model.flash, model.sonnet, model.sol],
  general: [model.sol, model.sonnet, model.opus, model.astra, model.carbon],
};

const reasons = {
  markets: 'مناسب لتحليل الأخبار والبيانات الاقتصادية ومقارنة سيناريوهات السوق.',
  code: 'مناسب لكتابة الكود وتعديله وتتبع الأخطاء.',
  complexCode: 'مناسب لتحليل المشاكل البرمجية المعقدة ومراجعة المنطق.',
  reasoning: 'مناسب للمسائل متعددة الخطوات ومراجعة الاستنتاجات.',
  visual: 'مناسب لقراءة الصور والرسوم والمستندات المصوّرة.',
  writing: 'مناسب لصياغة النصوص الطويلة وترتيب الحجج والأفكار.',
  quick: 'مناسب للأسئلة السريعة والمهام القصيرة.',
  general: 'خيار متوازن للمحادثة والتلخيص والتحليل العام.',
};

const marketTopic = /\b(?:xau\/?usd|(?:eur|gbp|aud|nzd)\/?usd|usd\/?(?:cad|chf|jpy)|forex|trading|fomc|nonfarm payrolls|(?:oil|gold|currency|stock|market) prices?|(?:market|macro) analysis|economic (?:calendar|news|data)|interest rates?)\b|فوركس|تداول|(?:سعر(?: صرف)?|اسعار|اتجاه|تحليل|حلل(?:\s*لي)?|حركه|توقع(?:ات)?|عقود|سوق|وضع)\s+(?:ال)?(?:ذهب|نفط|دولار|يورو)|(?:الذهب|النفط|الدولار|اليورو) اليوم|الاخبار الاقتصاديه|(?:سعر|اسعار) الفايده|(?:الفدرالي|الفيدرالي)|خطاب باول/iu;
const codeTopic = /\b(?:mql5|mq5|mt5|expert advisor|coding|code|programming|debug\w*|refactor\w*|typescript|javascript|python|sql|git(?:hub)?|api|unit tests?)\b|برمج|اكتب\s+(?:ال)?كود|عد[لّ]+\s+(?:ال)?كود|(?:ال)?كود\s+(?:يعلق|يعطي|ما يشتغل)|خطا\s+(?:برمجي|التجميع)/iu;
const reasoningTopic = /\b(?:complex|derive|prove|proof|logic|logical|reasoning|equation|calculate|edge cases?|tradeoffs?|multi.step|root cause|architecture)\b|برهن|اثبت|منطق|رياضيات|معادله|استنتاج|تناقض|معقد|متعدد الخطوات|السبب الجذري|تحليل معمق|تحليل عميق/iu;
const visualTopic = /\b(?:screenshot|ocr|scanned pdf|chart|diagram|graph|extract text from (?:a |the )?image)\b|لقط[هة] شاش[هة]|ملف مصور|مستند مصور|رسم بياني|استخرج النص من (?:ال)?صور[هة]|حلل (?:ال)?صور[هة]/iu;
const writingTopic = /\b(?:memo|brief|essay|draft|long.form|legal writing|report|creative writing|story|novel)\b|مذكر[هة]|صغ\s|صياغ[هة]|تقرير|رواي[هة]|(?:اكتب|الف)\s+(?:لي\s+)?قص[هة]|رتب\s+(?:ال)?حجج/iu;
const quickTopic = /^(?:(?:باختصار|مختصر|بسرعه|ترجم|quick(?:ly)?|briefly|translate)(?=\s|[:،]|$)|(?:هلا|مرحبا|السلام عليكم|صباح الخير|مساء الخير|اهلين|hi|hello|hey)[؟?!.,،]*$)/iu;
const followUp = /^(?:(?:اي|طيب|تمام|زين|و)\s+)?(?:كمل|تابع|وضح اكثر|اشرح اكثر|زيد التفاصيل|وماذا بعد|شرايك|ليه|ليش|why|how so|continue|go on|more details|explain more|and then)(?:[\s؟?!.,،]+)?$/iu;

function normalize(text) {
  return String(text ?? '').slice(0, 6000).normalize('NFKC')
    .replace(/[\u064b-\u065f\u0670\u0640]/gu, '')
    .replace(/[أإآ]/gu, 'ا')
    .replace(/ة/gu, 'ه').replace(/\s+/g, ' ')
    .trim();
}

function modelKey(item) {
  return (item.remoteId || item.id).split('/').at(-1).toLowerCase()
    .replace(/\./g, '-')
    .replace(/-20\d{2}(?:-?\d{2}){2}$/, '');
}

function classify(message, files, mode) {
  const reasoning = reasoningTopic.test(message);
  // The hardware/software task takes precedence when a market symbol is used in an EA request.
  if (mode === 'work' || codeTopic.test(message)) return reasoning ? 'complexCode' : 'code';
  if (marketTopic.test(message)) return 'markets';
  if (files.some(file => file?.kind === 'image') || visualTopic.test(message)) return 'visual';
  if (writingTopic.test(message)) return 'writing';
  if (reasoning) return 'reasoning';
  if (message.length < 100 && quickTopic.test(message)) return 'quick';
  return 'general';
}

export function recommendModel({ text, models, currentId, files = [], mode, history = [] }) {
  if (!models.length) return null;
  const message = normalize(text);
  let topic = classify(message, files, mode);
  if (topic === 'general' && followUp.test(message)) {
    // Inspect only recent user prompts. Assistant prose should not redirect the recommendation.
    for (const entry of history.slice(-12).reverse()) {
      if (entry?.role !== 'user') continue;
      const previous = normalize(entry.text);
      if ((!previous && !entry.files?.length) || followUp.test(previous)) continue;
      topic = classify(previous, entry.files || [], mode);
      break;
    }
  }
  const needsVision = topic === 'visual' || files.some(file => file?.kind === 'image');
  const eligible = needsVision ? models.filter(item => item.vision !== false) : models;
  if (!eligible.length) return null;
  const current = eligible.find(item => item.id === currentId);
  const ranked = rankings[topic].map(key => eligible.find(item => modelKey(item) === key)).find(Boolean);
  const chosen = ranked || current || eligible[0];
  return {
    id: chosen.id,
    name: chosen.name,
    reason: ranked ? reasons[topic] : 'خيار متاح عبر مزوّدك لهذه المحادثة.',
    isCurrent: chosen.id === currentId,
  };
}
