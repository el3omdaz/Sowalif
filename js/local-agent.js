import { settings, saveChat, saveProject, profileId } from './db.js?v=20';
import { mergeProjectFiles } from './project.js?v=20';
import { preparePersonalContext } from './memory.js?v=20';

let csrf = '';
const projectId = chat => profileId ? `${profileId}-${chat.id}` : chat.id;
export const localAgentOrigin = () => ['127.0.0.1', 'localhost'].includes(location.hostname) && location.port === '4781';
export const agentEngine = () => settings.get('codingEngine', 'off');
export function agentCredentials() {
  const engine = agentEngine();
  const provider = engine === 'codex' ? 'openai' : settings.get('codingProvider', 'openrouter');
  const keyName = provider === 'openai' ? 'codingOpenAIKey' : provider === 'anthropic' ? 'codingAnthropicKey' : 'openRouterKey';
  return { engine, provider, key: settings.get(keyName, ''), keyName, model: settings.get(engine === 'codex' ? 'codingCodexModel' : 'codingClaudeModel', '') };
}
async function api(path, data, signal) {
  if (!localAgentOrigin()) throw new Error('افتح نسخة الكمبيوتر: http://127.0.0.1:4781');
  const response = await fetch(`/api/agent/${path}`, {
    method: data === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-Sowalif-CSRF': csrf },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal,
  });
  const out = await response.json();
  if (!response.ok) throw new Error(out.error || 'تعذّر الاتصال بمحرك الكمبيوتر');
  return out;
}
export async function localStatus() {
  if (!localAgentOrigin()) return { local: false, ready: false };
  const state = await api('status', undefined, AbortSignal.timeout(20000));
  csrf = state.csrf;
  return state;
}
export const answerAgent = (runId, id, allow) => api(`runs/${encodeURIComponent(runId)}/approval`, { id, allow });
const pause = () => new Promise(resolve => setTimeout(resolve, 800));

export async function collectAgentRun(chat, reply, emit, signal) {
  if (!csrf) await localStatus();
  try {
    while (!signal?.aborted) {
      const run = await api(`runs/${encodeURIComponent(reply.agentRunId)}`, undefined, signal);
      emit('agent', run);
      const delta = run.text.slice(reply.text.length);
      reply.text = run.text;
      if (delta) emit('delta', { text: delta });
      if (run.state !== 'running') {
        reply.agentCompleted = true;
        reply.agentError = run.error;
        if (run.error) reply.error = run.error;
        if (run.state === 'stopped') reply.stopped = true;
        if (run.files) {
          const files = mergeProjectFiles([], run.files);
          const before = chat.project?.files || [];
          const paths = [...new Set([...before, ...files].map(f => f.path))];
          reply.agentChanges = paths.map(path => ({ path, before: before.find(f => f.path === path)?.content, after: files.find(f => f.path === path)?.content })).filter(f => f.before !== f.after);
          reply.agentBefore = before;
          const removed = before.filter(f => !files.some(next => next.path === f.path)).map(f => f.path);
          await saveProject(chat, { ...chat.project, files, removed: [...new Set([...(chat.project?.removed || []), ...removed])].filter(path => !files.some(f => f.path === path)), revision: (chat.project?.revision || 0) + 1, agentWorkspaceRevision: run.revision });
          reply.agentAppliedRevision = chat.project.revision;
        }
        if (!reply.text) reply.text = run.error ? '' : 'اكتمل التنفيذ. راجع الملفات وسجل الاختبارات.';
        emit('status', { text: '' });
        return reply;
      }
      emit('status', { text: run.approvals.length ? 'بانتظار موافقتك على أمر داخل المشروع…' : `يعمل محرك ${reply.agentEngine === 'codex' ? 'Codex' : 'Claude Code'} على الكمبيوتر…` });
      await pause();
    }
    await api(`runs/${encodeURIComponent(reply.agentRunId)}/stop`, {}).catch(() => {});
    reply.stopped = true;
    reply.error = 'أُرسل طلب الإيقاف. اضغط «متابعة التنفيذ» لجلب الملفات والنتيجة المحفوظة.';
    return reply;
  } catch (error) {
    if (signal?.aborted) {
      await api(`runs/${encodeURIComponent(reply.agentRunId)}/stop`, {}).catch(() => {});
      reply.stopped = true;
    }
    reply.error = 'تعذّر جلب النتيجة. التنفيذ محفوظ على الكمبيوتر؛ تابع نفس المهمة. ' + (signal?.aborted ? '' : error.message);
    return reply;
  }
}
export async function respondLocal(chat, emit, signal) {
  const reply = { role: 'assistant', model: chat.model, agentEngine: agentEngine(), text: '', at: Date.now() };
  const user = chat.messages.at(-1);
  try {
    const status = await localStatus();
    if (!status.ready) throw new Error('بيئة المحرك غير جاهزة؛ شغّل npm run agent:setup على الكمبيوتر');
    const config = agentCredentials();
    if (!config.key) throw new Error('أضف مفتاح محرك البرمجة في الإعدادات');
    if (user.files?.length) throw new Error('استورد ملفات المصدر من «ملفات المشروع» قبل طلب التنفيذ. المرفقات العادية ليست ملفات مشروع.');
    const personal = await preparePersonalContext(chat, user.text);
    const run = await api('runs', { projectId: projectId(chat), prompt: [personal.prompt, personal.expanded].filter(Boolean).join('\n\n'), files: chat.project?.files || [], workspaceRevision: chat.project?.agentWorkspaceRevision || 0,
      ...config, keyName: undefined, budget: settings.get('codingBudget', 2) }, signal);
    reply.agentRunId = run.id;
    // The job survives a reload; never create a second job automatically.
    await saveChat({ ...chat, messages: [...chat.messages, reply] });
    return await collectAgentRun(chat, reply, emit, signal);
  } catch (error) { reply.error = error.message + (!reply.agentRunId ? ' إذا انقطع الاتصال أثناء الإرسال، افحص «استرجاع ملفات الكمبيوتر» قبل إعادة الطلب.' : ''); return reply; }
  finally {
    chat.messages.push(reply);
    if (chat.title === 'محادثة جديدة') chat.title = user.text.slice(0, 50);
    await saveChat(chat);
  }
}
export async function recoverLocalProject(chat) {
  await localStatus();
  const status = await api(`project?id=${encodeURIComponent(projectId(chat))}`);
  if (status.activeRun) return status;
  const state = await api('recover', { projectId: projectId(chat) });
  await saveProject(chat, { ...chat.project, files: mergeProjectFiles([], state.files), revision: (chat.project?.revision || 0) + 1, agentWorkspaceRevision: state.revision });
  return state;
}
