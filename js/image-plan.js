// مقاس ونوع الصورة قبل الحفظ والإرسال
// صور المحادثة: JPEG بحد 1600 بكسل، لأن لقطات الآيفون PNG كبيرة تتجاوز حد الصور عند المزوّد (5MB لـ Claude)
// وتقطع الاتصال على الجوال. مراجع الصور والفيديو تبقى PNG بحد 2048 للحفاظ على الشفافية والتفاصيل.
export const CHAT_MAX_SIDE = 1600;
export const MEDIA_MAX_SIDE = 2048;

export function planImage({ type, width, height, media = false }) {
  const max = media ? MEDIA_MAX_SIDE : CHAT_MAX_SIDE;
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    type: media && type === 'image/png' ? 'image/png' : 'image/jpeg',
    quality: media ? 0.9 : 0.85,
    // JPEG ما فيه شفافية: نملأ الخلفية بالأبيض بدل الأسود
    fill: media && type === 'image/png' ? null : '#ffffff',
  };
}
