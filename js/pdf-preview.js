// Select only a small, explicitly justified set of pages for visual model input.
// This is not a substitute for reading every page of a long PDF.
const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
const ascii = value => String(value).replace(/[٠-٩۰-۹]/g, char =>
  String((arabicDigits.indexOf(char) >= 0 ? arabicDigits.indexOf(char) : persianDigits.indexOf(char))));

export function asksForLayout(query = '') {
  return /بصري|بصرياً|بصريا|الشكل|تنسيق|تصميم|جدول|الجدول|خانات|تواقيع|التواقيع|أسفل الصفحة|اسفل الصفحة|شكل الصفحة|layout|visually|visual|table|signature|formatting|bottom of the page/i.test(query);
}

export function selectPdfPreviewPages(totalPages, query = '', isNewAttachment = false, maximum = 2) {
  if (!Number.isSafeInteger(totalPages) || totalPages < 1 || maximum < 1) return [];
  const normalized = ascii(query);
  const requested = new Set();
  for (const match of normalized.matchAll(/(?:الصفحة|صفحة|pages?|p\.)\s*[:#]?\s*(\d{1,5})/gi)) {
    const page = Number(match[1]);
    if (page > 0 && page <= totalPages) requested.add(page);
  }
  if (/(?:آخر|اخر)\s*صفحة|الصفحة\s*(?:الأخيرة|الاخيرة)|last\s+page|final\s+page/i.test(normalized)) requested.add(totalPages);
  if (requested.size) return [...requested].slice(0, maximum);
  if (totalPages <= 2 && (isNewAttachment || asksForLayout(query))) {
    return Array.from({ length: Math.min(totalPages, maximum) }, (_, index) => index + 1);
  }
  if (asksForLayout(query)) return [1];
  return [];
}
