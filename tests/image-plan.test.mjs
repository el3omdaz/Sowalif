import test from 'node:test';
import assert from 'node:assert/strict';
import { planImage, CHAT_MAX_SIDE, MEDIA_MAX_SIDE } from '../js/image-plan.js';

test('لقطة شاشة آيفون PNG في المحادثة تصير JPEG بحد 1600 وخلفية بيضاء', () => {
  const p = planImage({ type: 'image/png', width: 1290, height: 2796 });
  assert.equal(p.type, 'image/jpeg');
  assert.equal(p.height, CHAT_MAX_SIDE);
  assert.equal(p.width, Math.round(1290 * (CHAT_MAX_SIDE / 2796)));
  assert.equal(p.fill, '#ffffff');
});

test('الصورة الصغيرة ما تكبر', () => {
  const p = planImage({ type: 'image/jpeg', width: 800, height: 600 });
  assert.deepEqual([p.width, p.height], [800, 600]);
});

test('مراجع الصور والفيديو تبقى PNG بحد 2048 بدون تعبئة', () => {
  const p = planImage({ type: 'image/png', width: 4000, height: 3000, media: true });
  assert.equal(p.type, 'image/png');
  assert.equal(p.width, MEDIA_MAX_SIDE);
  assert.equal(p.fill, null);
});

test('GIF في المحادثة يتحول JPEG', () => {
  assert.equal(planImage({ type: 'image/gif', width: 500, height: 500 }).type, 'image/jpeg');
});
