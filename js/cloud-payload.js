const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, structuredClone(value[key])]));
export function cloudFile(file) {
  const result = pick(file, ['kind', 'name', 'type', 'size', 'originalName', 'originalStoragePath', 'deferredDocument', 'deferredPdf', 'extraction', 'text', 'url', 'urlAt', 'storagePath', 'model']);
  if (result.extraction) result.extraction = pick(result.extraction, ['format', 'complete', 'needsVision', 'pagesTotal', 'pagesRead', 'pagesWithText', 'unreadablePages', 'entriesTotal', 'entriesRead', 'entriesUnreadable']);
  // The original is in Storage. Do not duplicate huge extracted documents or
  // archive inventories inside the 4MB conversation metadata record.
  if (result.originalStoragePath && (result.deferredDocument || result.deferredPdf)) result.text = 'الملف الأصلي محفوظ كاملًا في حسابك؛ يُقرأ عند الطلب.';
  if (result.url && !/^https?:\/\//i.test(result.url)) delete result.url;
  return result;
}
export function cloudChat(chat) {
  const result = pick(chat, ['id', 'title', 'model', 'createdAt', 'updatedAt', 'pinned', 'mode', 'promptStudioMode']);
  result.messages = (chat.messages || []).filter(m => ['user', 'assistant'].includes(m.role)).map(message => {
    const value = pick(message, ['role', 'text', 'model', 'at', 'error', 'stopped', 'credits', 'searches', 'imagePrompt', 'mediaKind', 'mediaReferenceUrl', 'videoReferenceUrl', 'reuseMedia', 'contextSources', 'memoryAction', 'recallUnavailable', 'projectProposal', 'agentEngine', 'agentCompleted', 'promptStudio']);
    if (message.modelRecommendation) value.modelRecommendation = pick(message.modelRecommendation, ['id', 'name', 'reason', 'isCurrent']);
    if (message.documentSources) value.documentSources = message.documentSources.map(file => pick(file, ['name', 'format', 'complete', 'pagesTotal', 'pagesRead', 'pagesWithText', 'unreadablePages', 'entriesTotal', 'entriesRead', 'entriesUnreadable', 'readError']));
    for (const key of ['files', 'images', 'videos']) if (message[key]) value[key] = message[key].map(cloudFile);
    if (message.mediaTask) value.mediaTask = pick(message.mediaTask, ['id', 'provider', 'kind', 'name', 'prompt', 'done', 'submitting']);
    return value;
  });
  if (chat.project) result.project = pick(chat.project, ['files', 'revision', 'removed', 'instructions']);
  return result;
}
export function cloudMemory(memory) {
  return { instructions: String(memory.instructions || '').slice(0, 8000), notes: String(memory.notes || '').slice(0, 12000), enabled: memory.enabled !== false,
    rules: (Array.isArray(memory.rules) ? memory.rules : []).slice(0, 50).map(rule => pick(rule, ['id', 'trigger', 'action', 'search'])) };
}
