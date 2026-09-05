/**
 * Sade Normalization
 */

export function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeText(value) {
  return safeString(value).toLocaleUpperCase("tr-TR");
}

export function normalize(name) {
  if (name === null || name === undefined) {
    console.warn(`[Normalizer] Missing value. Raw data:`, name);
    return '';
  }
  return safeString(name)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
}

