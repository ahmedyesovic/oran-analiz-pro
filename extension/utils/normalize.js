/**
 * Sade Normalization (Extension)
 */

export function normalize(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
}

const TEAM_NAME_NOISE_TOKENS = new Set([
  'ac', 'afc', 'as', 'bk', 'cfc', 'cf', 'club', 'fc', 'fk', 'if', 'jk', 'kv',
  'sc', 'sk', 'sv', 'stade', 'the'
]);

const AMBIGUOUS_SINGLE_TOKENS = new Set([
  'athletic', 'city', 'dynamo', 'olympic', 'olympique', 'real', 'sporting', 'united'
]);

export function normalizeTeamName(value) {
  return typeof value === 'string'
    ? value
      .trim()
      .toLocaleLowerCase('tr-TR')
      .replace(/ı/g, 'i')
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ş/g, 's')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
    : '';
}

function meaningfulTeamTokens(value) {
  return normalizeTeamName(value)
    .split(' ')
    .filter(token => token.length >= 2)
    .filter(token => !/^\d+$/.test(token))
    .filter(token => !TEAM_NAME_NOISE_TOKENS.has(token));
}

function tokenMatches(left, right) {
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 5 && longer.startsWith(shorter);
}

function isAcronymOf(shortName, longTokens) {
  const compactShortName = normalizeTeamName(shortName).replace(/\s+/g, '');
  if (compactShortName.length < 2 || compactShortName.length > 6 || longTokens.length < 2) {
    return false;
  }
  return longTokens.map(token => token[0]).join('') === compactShortName;
}

export function teamNamesMatch(left, right) {
  const normalizedLeft = normalizeTeamName(left);
  const normalizedRight = normalizeTeamName(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const compactLeft = normalizedLeft.replace(/\s+/g, '');
  const compactRight = normalizedRight.replace(/\s+/g, '');
  if (compactLeft === compactRight) return true;

  const leftTokens = meaningfulTeamTokens(left);
  const rightTokens = meaningfulTeamTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  if (isAcronymOf(left, rightTokens) || isAcronymOf(right, leftTokens)) return true;

  const [shorterTokens, longerTokens] = leftTokens.length <= rightTokens.length
    ? [leftTokens, rightTokens]
    : [rightTokens, leftTokens];
  const allShorterTokensMatch = shorterTokens.every(shortToken =>
    longerTokens.some(longToken => tokenMatches(shortToken, longToken))
  );

  if (!allShorterTokensMatch) return false;
  if (shorterTokens.length > 1) return true;

  const singleToken = shorterTokens[0];
  return singleToken.length >= 4 && !AMBIGUOUS_SINGLE_TOKENS.has(singleToken);
}
