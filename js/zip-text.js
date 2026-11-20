const MAX_EXPANDED_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BINARY_BYTES = 512 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export async function readZipEntries(file, readable, signal, { binary = false, maxExpandedBytes, tolerateErrors = false } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted?.();

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset) => view.getUint16(offset, true);
  const u32 = (offset) => view.getUint32(offset, true);
  const utf8 = new TextDecoder();

  const isReadable = typeof readable === 'function' ? readable : () => true;
  const budget = Number.isFinite(maxExpandedBytes) && maxExpandedBytes > 0
    ? maxExpandedBytes
    : (binary ? MAX_EXPANDED_BINARY_BYTES : MAX_EXPANDED_TEXT_BYTES);

  if (bytes.length < 22) {
    throw new Error('بيانات ZIP غير مكتملة. الملف الأصلي محفوظ ويمكن فتحه بأدوات الكمبيوتر.');
  }

  let end = bytes.length - 22;
  const floor = Math.max(0, end - 65535);
  while (end >= floor && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)) end--;

  if (end < floor || u16(end + 4) || u16(end + 6)) {
    throw new Error('تعذّر قراءة أرشيف ZIP.');
  }

  if (u16(end + 10) === 0xffff || u32(end + 16) === 0xffffffff) {
    throw new Error('أرشيف ZIP64 يحتاج أدوات الكمبيوتر لقراءته كاملًا. الملف الأصلي محفوظ.');
  }

  let offset = u32(end + 16);
  const entries = [];
  const skipped = [];
  const inventory = [];
  let used = 0;

  for (let i = 0; i < u16(end + 10); i++) {
    signal?.throwIfAborted?.();

    if (offset + 46 > end || u32(offset) !== 0x02014b50) {
      throw new Error('جدول ملفات ZIP غير صالح.');
    }

    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    if (offset + 46 + nameLength > end) throw new Error('أسماء ملفات ZIP غير مكتملة.');

    const name = utf8.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const expectedCrc = u32(offset + 16);
    const compressed = u32(offset + 20);
    const size = u32(offset + 24);
    const local = u32(offset + 42);

    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;

    // Binary controls the returned representation, not which members to extract.
    // Otherwise large unsupported files can exhaust the budget before readable documents.
    const unsupportedByReadable = !isReadable(name);
    const reason = unsupportedByReadable
      ? 'unsupported'
      : (flags & 1)
        ? 'encrypted'
        : ![0, 8].includes(method)
          ? 'compression'
          : (size === 0xffffffff || local === 0xffffffff)
            ? 'zip64'
            : (used + size > budget)
              ? 'budget'
              : '';

    const record = { name, size, readable: !reason, status: reason || 'read' };
    inventory.push(record);

    if (reason) {
      skipped.push(name);
      continue;
    }

    try {
      if (local + 30 > end || u32(local) !== 0x04034b50) {
        throw new Error('ملف داخل ZIP غير صالح.');
      }

      const localNameLength = u16(local + 26);
      const localExtraLength = u16(local + 28);
      const start = local + 30 + localNameLength + localExtraLength;

      if (start + compressed > bytes.length) {
        throw new Error('بيانات ZIP غير مكتملة.');
      }

      const payload = bytes.subarray(start, start + compressed);
      let content = payload;

      if (method === 8) {
        const ds = new DecompressionStream('deflate-raw');
        const reader = new Blob([payload]).stream().pipeThrough(ds).getReader();
        const chunks = [];
        let count = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            signal?.throwIfAborted?.();
            if (done) break;
            count += value.length;
            if (count > size) throw new Error('حجم ملف ZIP الداخلي غير مطابق.');
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }

        content = new Uint8Array(await new Blob(chunks).arrayBuffer());
      }

      if (content.length !== size) throw new Error('حجم ملف ZIP الداخلي غير مطابق.');
      if (crc32(content) !== expectedCrc) throw new Error(`بيانات الملف «${name}» داخل ZIP لا تطابق الأصل (CRC).`);

      used += size;
      entries.push([name, binary ? content : utf8.decode(content)]);
    } catch (error) {
      signal?.throwIfAborted?.();
      if (!tolerateErrors) throw error;
      record.status = 'corrupt';
      record.readable = false;
      record.error = String(error?.message || error).slice(0, 300);
      skipped.push(name);
    }
  }

  return { entries, skipped, inventory };
}

export async function zipText(file, readable, signal, opts = {}) {
  const { entries, skipped, inventory } = await readZipEntries(file, readable, signal, opts);
  const sections = entries.map(([name, content]) => `[${name}]\n${content}`);

  const skippedDetails = inventory.filter((x) => x.status !== 'read');
  const skippedLine = skipped.length
    ? `ملفات لم يُقرأ محتواها: ${skipped.join('، ')}`
    : '';
  const reasonLine = skippedDetails.length
    ? `تفاصيل سبب التخطي: ${skippedDetails.map((x) => `${x.name} (${x.status})`).join('، ')}`
    : '';

  return [...sections, ...[skippedLine, reasonLine].filter(Boolean)].join('\n\n');
}
