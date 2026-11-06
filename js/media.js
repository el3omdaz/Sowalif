import { settings } from './db.js?v=13';

export function mediaProvider() {
  const choice = settings.get('mediaProvider', 'auto');
  return ['piapi', 'kie'].includes(choice) ? choice : settings.get('piapiKey', '') ? 'piapi' : 'kie';
}
export function kieMediaSpec(kind, prompt, { reference, aspect = 'auto' } = {}) {
  const duration = settings.get('piapiDuration', 5) == 10 ? '10' : '5';
  if (kind === 'video') {
    const choice = settings.get('kieVideoModel', 'auto');
    if (!['auto', 'kling-2.6', 'wan-2.6', 'seedance-2.5'].includes(choice)) throw new Error('اختر نموذج فيديو kie.ai صالحاً');
    if (choice === 'seedance-2.5') {
      const ratio = ['16:9', '9:16', '1:1', '4:3', '3:4'].includes(aspect) ? aspect : '16:9';
      const input = { prompt, duration: Number(duration), resolution: '720p', aspect_ratio: ratio };
      if (reference) input.reference_image_urls = [reference];
      return { name: 'Seedance 2.5', body: { model: 'bytedance/seedance-2-5', input } };
    }
    if (choice === 'wan-2.6') {
      if (!reference) throw new Error('نموذج Wan المحدد يحتاج صورة؛ أرفق صورة أو اختر Kling / تلقائي');
      return { name: 'Wan 2.6', body: { model: 'wan/2-6-image-to-video', input: { prompt, image_urls: [reference], duration, resolution: '720p', multi_shots: false } } };
    }
    return { name: 'Kling 2.6', body: { model: `kling-2.6/${reference ? 'image' : 'text'}-to-video`, input: { prompt, duration, sound: false, ...(reference ? { image_urls: [reference] } : { aspect_ratio: ['1:1', '9:16', '16:9'].includes(aspect) ? aspect : '16:9' }) } } };
  }
  const choice = settings.get('kieImageModel', 'auto');
  if (!['auto', 'nano-banana-2-1', 'nano-banana-pro'].includes(choice)) throw new Error('اختر نموذج صور kie.ai صالحاً');
  const model = choice === 'auto' ? 'nano-banana-2-1' : choice;
  return { name: model === 'nano-banana-pro' ? 'Nano Banana Pro' : 'Nano Banana 2.1', body: { model, input: { prompt, aspect_ratio: aspect, resolution: '2K', output_format: 'png', ...(reference ? { image_input: [reference] } : {}) } } };
}
