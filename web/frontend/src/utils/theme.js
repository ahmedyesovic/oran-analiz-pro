export const THEME_STORAGE_KEY = 'oran-analiz-theme';
export const THEMES = [
  { id: 'default', label: 'Varsayılan tema' },
  { id: 'black', label: 'Siyah tema' },
  { id: 'white', label: 'Beyaz tema' }
];

export function normalizeTheme(value) {
  return THEMES.some(theme => theme.id === value) ? value : 'default';
}

export function readStoredTheme(storage) {
  try {
    return normalizeTheme((storage ?? globalThis.localStorage)?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'default';
  }
}

export function applyTheme(value, root = globalThis.document?.documentElement, storage) {
  const theme = normalizeTheme(value);
  root?.setAttribute('data-theme', theme);
  try {
    (storage ?? globalThis.localStorage)?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable; the chosen theme still applies to this page.
  }
  return theme;
}
