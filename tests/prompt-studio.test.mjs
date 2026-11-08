import test from 'node:test';
import assert from 'node:assert/strict';
import { extractImagePrompt } from '../js/prompt-studio.js?v=20';
test('prompt extraction accepts only replacements that identify one exact phrase', () => {
  const prompt = 'An adult man wearing a linen coat, in soft studio lighting.';
  const output = extractImagePrompt('وصف مقارب للصورة.\n```sowalif-prompt\n' + JSON.stringify({ prompt, changes: [
    { label: 'الشخصية', from: 'An adult man', to: 'An adult woman' },
    { label: 'الملمس', from: 'linen', to: 'silk' },
    { label: 'غير موجود', from: 'leather', to: 'metal' },
    { label: 'مكرر', from: ' ', to: '-' },
  ] }) + '\n```');
  assert.equal(output.studio.prompt, prompt);
  assert.equal(output.studio.original, prompt);
  assert.equal(output.studio.changes.length, 2);
  assert.equal(output.text, 'وصف مقارب للصورة.');
  assert.equal(extractImagePrompt('```sowalif-prompt\n{bad}\n```'), null);
});
