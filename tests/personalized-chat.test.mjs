import test from 'node:test';
import assert from 'node:assert/strict';
const local = new Map([['sc.kieKey', '"fake-kie"'], ['sc.openRouterKey', '"fake-or"']]);
globalThis.localStorage = { getItem: (key) => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) };
const chats = new Map([['old', { id: 'old', title: 'خطة متابعة الذهب', updatedAt: 10, messages: [{ role: 'user', text: 'في متابعة الذهب ركّز على حركة العائد الحقيقي والدولار', at: 10 }, { role: 'assistant', text: 'سأربط الأخبار بالعوائد والدولار.' }] }]]);
globalThis.indexedDB = { open() {
  const request = {};
  queueMicrotask(() => {
    request.result = { transaction() {
      const tx = { objectStore: () => ({
        getAll: () => ({ result: structuredClone([...chats.values()]) }),
        get: id => {
          const result = { result: structuredClone(chats.get(id)) };
          queueMicrotask(() => result.onsuccess?.());
          return result;
        },
        put: (value) => { chats.set(value.id, structuredClone(value)); return { result: value.id }; },
      }) };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    } };
    request.onsuccess();
  });
  return request;
} };
const { savePersonalization, saveRule } = await import('../js/memory.js?v=12');
const { respond } = await import('../js/chat.js?v=12');

test('work mode stages file changes and saves only after applying them', async () => {
  const { saveProject, recallChats } = await import('../js/db.js?v=12');
  const { applyProjectProposal } = await import('../js/project.js?v=12');
  const original = { path: 'index.html', content: '<h1>Before</h1>' };
  const change = { path: 'index.html', content: '<h1>After</h1>' };
  const chat = { id: 'work-project', mode: 'work', title: 'محادثة جديدة', messages: [{ role: 'user', text: 'عدّل الصفحة وأضف صورة تجريبية بالكود' }] };
  await saveProject(chat, { revision: 1, files: [original] });
  globalThis.fetch = async (url, init) => {
    assert.match(url, /^https:\/\/openrouter\.ai\//);
    const { messages } = JSON.parse(init.body);
    assert.match(messages[0].content, /Sowalif Work workspace/);
    assert.match(messages.at(-1).content[0].text, /<h1>Before<\/h1>/);
    const content = ['تم تجهيز التعديل.', '```sowalif-project', JSON.stringify([change]), '```'].join('\n');
    const event = { choices: [{ delta: { content }, finish_reason: 'stop' }] };
    return new Response('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  local.set('sc.openRouterKey', '"fake-or"');
  const reply = await respond(chat, { model: 'or:anthropic/claude-sonnet-5.5' }, () => {});
  assert.equal(reply.text, 'تم تجهيز التعديل.');
  assert.deepEqual(chats.get(chat.id).project.files, [original]);
  const stale = structuredClone(chat);
  const files = applyProjectProposal(chat.project, reply.projectProposal);
  await saveProject(chat, { revision: 2, files });
  assert.deepEqual(chats.get(chat.id).project.files, [change]);
  await assert.rejects(saveProject(stale, { revision: 2, files: [original] }), /نافذة ثانية/);
  assert.throws(() => applyProjectProposal(chat.project, reply.projectProposal), /نسخة|تغيّرت/);
  assert.equal((await recallChats()).some(item => item.id === chat.id), false);
});

test('custom instructions, cross-chat context and gold rule reach both providers without extra model requests', async () => {
  savePersonalization({ instructions: 'رد باللهجة الكويتية وبنقاط واضحة', notes: 'أفضل توقيت الكويت', enabled: true });
  saveRule({ trigger: 'ذهب', action: 'ابحث عن آخر أخبار الذهب وتأثير العوائد والدولار', search: true });
  const outgoing = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    outgoing.push({ url, body });
    return new Response(JSON.stringify(url.startsWith('https://openrouter.ai') ? { choices: [{ message: { content: 'أخبار محدثة مع المصادر' }, finish_reason: 'stop' }] } : { content: [{ type: 'text', text: 'أخبار محدثة مع المصادر' }] }), { headers: { 'content-type': 'application/json' } });
  };
  for (const model of ['claude-sonnet-5-5', 'or:anthropic/claude-sonnet-5.5']) {
    const chat = { id: `current-${model}`, title: 'محادثة جديدة', messages: [{ role: 'user', text: 'ذهب', at: Date.now() }] };
    const reply = await respond(chat, { model, search: false }, () => {});
    assert.equal(reply.error, undefined);
    assert.ok(reply.contextSources.some((c) => c.id === 'old'));
    assert.equal(chat.messages[0].text, 'ذهب');
  }
  assert.equal(outgoing.length, 2);
  const first = outgoing[0].body;
  assert.match(first.system, /باللهجة الكويتية/);
  assert.match(first.system, /توقيت الكويت/);
  assert.match(first.system, /العائد الحقيقي/);
  assert.ok(first.tools.some((t) => t.name === 'web_search'));
  assert.match(first.messages.at(-1).content.at(-1).text, /آخر أخبار الذهب/);
  const second = outgoing[1].body;
  assert.match(second.messages[0].content, /باللهجة الكويتية/);
  assert.match(second.messages[0].content, /العائد الحقيقي/);
  assert.deepEqual(second.tools, [{ type: 'openrouter:web_search' }]);
});

test('personalization backup excludes API keys and can be exported with chats', async () => {
  const { exportAll } = await import('../js/db.js?v=12');
  const text = await (await exportAll()).text();
  const backup = JSON.parse(text);
  assert.equal(backup.version, 2);
  assert.match(backup.personalization.instructions, /باللهجة الكويتية/);
  assert.equal(backup.personalization.rules[0].trigger, 'ذهب');
  assert.equal(text.includes('fake-kie'), false);
  assert.equal(text.includes('fake-or'), false);
});

test('OpenRouter chat routes video straight to PiAPI and resumes an existing task after polling failure', async () => {
  local.set('sc.piapiKey', '"fake-piapi"');
  local.delete('sc.kieKey');
  local.delete('sc.openRouterKey');
  const calls = [];
  let failPoll = true;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method });
    assert.match(url, /^https:\/\/api.piapi.ai\//);
    assert.equal(init.headers['X-API-Key'], 'fake-piapi');
    if (init.method === 'POST') {
      assert.equal(JSON.parse(init.body).model, 'kling');
      return Response.json({ code: 200, data: { task_id: 'persistent-video' } });
    }
    // The task ID must already survive a reload before the first status request.
    assert.equal(chats.get('media').messages.at(-1).mediaTask.id, 'persistent-video');
    if (failPoll) return Response.json({ message: 'status unavailable' }, { status: 503 });
    return Response.json({ code: 200, data: { status: 'completed', output: { video: 'https://cdn.test/result.mp4' } } });
  };
  const chat = { id: 'media', title: 'محادثة جديدة', messages: [{ role: 'user', text: 'سوي فيديو للبحر' }] };
  const reply = await respond(chat, { model: 'or:anthropic/claude-sonnet-5.5' }, () => {});
  assert.equal(reply.mediaTask.id, 'persistent-video');
  assert.match(reply.error, /status unavailable/);
  failPoll = false;
  const { resumeMedia } = await import('../js/chat.js?v=12');
  await resumeMedia(chat, reply, () => {});
  assert.equal(reply.error, undefined);
  assert.equal(reply.videos[0].url, 'https://cdn.test/result.mp4');
  assert.equal(reply.mediaTask.done, true);
  assert.deepEqual(calls.map(c => c.method), ['POST', 'GET', 'GET']);
  assert.equal(chat.messages.length, 2);
  const { exportAll } = await import('../js/db.js?v=12');
  assert.equal((await (await exportAll()).text()).includes('fake-piapi'), false);
});

test('kie.ai media works under OpenRouter and resumed jobs retain their original provider', async () => {
  local.set('sc.mediaProvider', '"kie"');
  local.set('sc.kieKey', '"fake-kie-media"');
  const calls = [];
  let failed = true;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method });
    assert.match(url, /^https:\/\/api.kie.ai\//);
    assert.equal(init.headers.Authorization, 'Bearer fake-kie-media');
    if (init.method === 'POST') {
      assert.equal(JSON.parse(init.body).model, 'kling-2.6/text-to-video');
      return Response.json({ code: 200, data: { taskId: 'kie-video' } });
    }
    if (failed) return Response.json({ msg: 'status unavailable' }, { status: 503 });
    return Response.json({ code: 200, data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.test/kie.mp4'] }) } });
  };
  const chat = { id: 'kie-media', title: 'محادثة جديدة', messages: [{ role: 'user', text: 'سوي فيديو عن البحر' }] };
  const reply = await respond(chat, { model: 'or:anthropic/claude-sonnet-5.5' }, () => {});
  assert.equal(reply.mediaTask.provider, 'kie');
  assert.ok(reply.error);
  local.set('sc.mediaProvider', '"piapi"');
  failed = false;
  const { resumeMedia } = await import('../js/chat.js?v=12');
  await resumeMedia(chat, reply, () => {});
  assert.equal(reply.error, undefined);
  assert.equal(reply.videos[0].url, 'https://cdn.test/kie.mp4');
  assert.deepEqual(calls.map(c => c.method), ['POST', 'GET', 'GET']);
});

test('media workspaces route short follow-ups with their own last reference and keep chat recall separate', async () => {
  local.set('sc.piapiKey', '"fake-piapi"');
  local.set('sc.mediaProvider', '"piapi"');
  const outgoing = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      outgoing.push(JSON.parse(init.body));
      return Response.json({ code: 200, data: { task_id: String(outgoing.length) } });
    }
    if (url.startsWith('https://cdn.test/')) return new Response(null, { status: 403 });
    return Response.json({ code: 200, data: {
      status: 'completed', output: { image_url: 'https://cdn.test/result.png', video: 'https://cdn.test/result.mp4' },
    } });
  };
  const image = { id: 'workspace-image', mode: 'image', title: 'صورة', messages: [
    { role: 'assistant', images: [{ kind: 'image', url: 'https://cdn.test/current.png' }] },
    { role: 'user', text: 'خلها أغمق' },
  ] };
  const video = { id: 'workspace-video', mode: 'video', title: 'فيديو', messages: [
    { role: 'assistant', videos: [{ kind: 'video', url: 'https://cdn.test/current.mp4' }] },
    { role: 'user', text: 'غيّر الألوان' },
  ] };
  for (const chat of [image, video]) {
    const reply = await respond(chat, { model: 'or:anthropic/claude-sonnet-5.5', search: true }, () => {});
    assert.equal(reply.error, undefined);
  }
  assert.equal(outgoing[0].task_type, 'kontext');
  assert.equal(outgoing[0].input.image, 'https://cdn.test/current.png');
  assert.deepEqual(outgoing[1].input.video_urls, ['https://cdn.test/current.mp4']);
  image.messages.push({ role: 'user', text: 'غيمة', reuseMedia: false });
  await respond(image, { model: 'or:anthropic/claude-sonnet-5.5' }, () => {});
  assert.equal(outgoing[2].task_type, 'txt2img');
  const { recallChats } = await import('../js/db.js?v=12');
  assert.ok((await recallChats()).every(chat => !chat.id.startsWith('workspace-')));
});
