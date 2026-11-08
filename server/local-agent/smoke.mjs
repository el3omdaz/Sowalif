// Offline integration check: real Claude runtime + real tools, scripted local API.
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { runAgent } from './worker.mjs';
let step = 0;
const events = [];
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
  const input = JSON.parse(raw);
  const stages = [
    { type: 'tool_use', id: 'tool_write', name: 'Write', input: { file_path: '/workspace/smoke-value.js', content: 'export const value = 42;\n' } },
    { type: 'tool_use', id: 'tool_test', name: 'Bash', input: { command: 'node --test check.test.mjs', description: 'Run the smoke assertion' } },
    { type: 'text', text: 'تم تعديل الملف وتشغيل الاختبار.' },
  ];
  const block = stages[Math.min(step++, stages.length - 1)];
  const message = { id: 'msg_' + step, type: 'message', role: 'assistant', model: input.model, content: [block], stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  if (!input.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send('content_block_start', { index: 0, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
  send('content_block_delta', { index: 0, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  send('message_stop', {}); res.end();
});
await writeFile('/workspace/check.test.mjs', "import assert from 'node:assert/strict'; import {value} from './smoke-value.js'; assert.equal(value,42); console.log('SMOKE_TEST_PASSED');\n");
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  await runAgent({ key: 'fake-offline-key', provider: 'anthropic', model: 'claude-sonnet-4-6', smokeBaseUrl: `http://127.0.0.1:${server.address().port}`, prompt: 'Write smoke-value.js and run its test.' }, {
    send: (type, data) => { events.push({ type, ...data }); },
    approve: async () => true,
  });
  assert.match(await readFile('/workspace/smoke-value.js', 'utf8'), /42/);
  assert.ok(step >= 3, 'the official runtime must iterate through write, execution, and final answer');
  assert.ok(events.some(event => event.type === 'tool-result' && event.text.includes('SMOKE_TEST_PASSED')), 'the shell assertion must actually pass');
  console.log('CLAUDE_RUNTIME_SMOKE_OK: actual Write and Bash tools completed using an offline model stub.');
} finally { server.close(); }
