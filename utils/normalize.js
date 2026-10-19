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

const TEAM_NAME_NOISE_TOKENS = new Set([
  'ac', 'afc', 'as', 'bk', 'cfc', 'cf', 'club', 'fc', 'fk', 'if', 'jk', 'kv',
  'sc', 'sk', 'sv', 'stade', 'the'
]);

const AMBIGUOUS_SINGLE_TOKENS = new Set([
  'athletic', 'city', 'dynamo', 'olympic', 'olympique', 'real', 'sporting', 'united'
]);

export function normalizeTeamName(value) {
  return safeString(value)
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
    .trim();
}

const TEAM_ALIASES = new Map([
    ['psv', 'psv eindhoven'],
    ['psv eindhoven', 'psv eindhoven'],
    ['sevilla', 'sevilla'],
    ['sevillia', 'sevilla'],
    ['manchester city', 'manchester city'],
    ['man city', 'manchester city'],
    ['athletic bilbao', 'athletic bilbao'],
    ['athletico bilbao', 'athletic bilbao'],
    ['bilbao', 'athletic bilbao'],
    ['ath bilbao', 'athletic bilbao'],
    ['a bilbao', 'athletic bilbao'],
    ['athletic de bilbao', 'athletic bilbao']
]);

function teamIdentity(value) {
    const qualifiers = new Set();
    const rawName = (typeof value === 'string' ? value.trim() : '').replace(/\(\s*([bk])\s*\)/gi, (_, token) => {
        qualifiers.add(token.toLowerCase() === 'k' ? 'women' : 'b');
        return ' ';
    });
    const name = normalizeTeamName(rawName).replace(
        /\b(?:u\s?\d{1,2}|ii|iii|iv|kadin|women(?: s|s)?|ladies|res|reserve|reserves)\b/g,
        token => {
            if (/^(?:kadin|women(?: s|s)?|ladies)$/.test(token)) qualifiers.add('women');
            else if (/^(?:res|reserve|reserves)$/.test(token)) qualifiers.add('reserves');
            else qualifiers.add(token.replaceAll(' ', ''));
            return ' ';
        }
    ).replace(/\s+/g, ' ').trim().replace(/(?:\s+[bk])+$/, suffix => {
        for (const token of suffix.trim().split(/\s+/)) {
            qualifiers.add(token === 'k' ? 'women' : 'b');
        }
        return '';
    });
    return { name, qualifiers: [...qualifiers].sort().join(' ') };
}

function knownTeam(value) {
    const name = value.split(' ').filter(token => !TEAM_NAME_NOISE_TOKENS.has(token)).join(' ');
    return TEAM_ALIASES.get(name);
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

/**
 * Nesine, Mackolik ve kullanıcı girdisindeki takım adı varyasyonlarını
 * kontrollü biçimde eşleştirir.
 */
export function teamNamesMatch(left, right) {
  const leftIdentity = teamIdentity(left);
  const rightIdentity = teamIdentity(right);
  if (leftIdentity.qualifiers !== rightIdentity.qualifiers) return false;
  const normalizedLeft = leftIdentity.name;
  const normalizedRight = rightIdentity.name;
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const compactLeft = normalizedLeft.replace(/\s+/g, '');
  const compactRight = normalizedRight.replace(/\s+/g, '');
  if (compactLeft === compactRight) return true;

  const leftTokens = meaningfulTeamTokens(normalizedLeft);
  const rightTokens = meaningfulTeamTokens(normalizedRight);
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;

  if (isAcronymOf(normalizedLeft, rightTokens) || isAcronymOf(normalizedRight, leftTokens)) {
    return true;
  }

  const leftTeam = knownTeam(normalizedLeft);
  const rightTeam = knownTeam(normalizedRight);
  if (leftTeam || rightTeam) return Boolean(leftTeam && leftTeam === rightTeam);

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
