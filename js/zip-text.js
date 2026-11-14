const MAX_ENTRY = 400_000;
const MAX_TOTAL = 400_000;

export async function zipText(file, readable) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const u16 = offset => view.getUint16(offset, true);
  const u32 = offset => view.getUint32(offset, true);
  const utf8 = new TextDecoder();
  let end = bytes.length - 22;
  const floor = Math.max(0, end - 65535);
  while (end >= floor && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)) end--;
  if (end < floor || u16(end + 4) || u16(end + 6)) throw new Error('تعذّر قراءة أرشيف ZIP.');
  let offset = u32(end + 16);
  const sections = [];
  let used = 0;
  const skipped = [];
  for (let i = 0; i < u16(end + 10); i++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw new Error('جدول ملفات ZIP غير صالح.');
    const nameLength = u16(offset + 28);
    const name = utf8.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const flags = u16(offset + 8), method = u16(offset + 10), size = u32(offset + 24);
    const compressed = u32(offset + 20), local = u32(offset + 42);
    offset += 46 + nameLength + u16(offset + 30) + u16(offset + 32);
    if (name.endsWith('/')) continue;
    if (!readable(name) || flags & 1 || ![0, 8].includes(method) || size > MAX_ENTRY || used + size > MAX_TOTAL) {
      if (skipped.length < 100) skipped.push(name);
      continue;
    }
    if (local + 30 > end || u32(local) !== 0x04034b50) throw new Error('ملف داخل ZIP غير صالح.');
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (start + compressed > end) throw new Error('بيانات ZIP غير مكتملة.');
    const payload = bytes.subarray(start, start + compressed);
    let content = payload;
    if (method === 8) {
      const reader = new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const chunks = [];
      let count = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          count += value.length;
          if (count > size) throw new Error('حجم ملف ZIP الداخلي غير مطابق.');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      content = new Uint8Array(await new Blob(chunks).arrayBuffer());
    }
    if (content.length !== size) throw new Error('حجم ملف ZIP الداخلي غير مطابق.');
    used += size;
    sections.push(`[${name}]\n${utf8.decode(content)}`);
  }
  return [...sections, ...(skipped.length ? [`ملفات لم يُقرأ محتواها: ${skipped.join('، ')}`] : [])].join('\n\n');
}
