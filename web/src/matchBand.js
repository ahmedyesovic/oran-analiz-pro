// A separate snapshot preserves precision/status without changing market display or exports.
const labels = ['MS1', 'MSX', 'MS2'];
const upperBounds = ['1.15', '1.35', '1.65', '2.10', '2.80', '4.00', '7.00'];
const decimal = value => {
    if (!['number', 'string'].includes(typeof value)) return null;
    const text = String(value).trim().replace(',', '.');
    return text.length <= 128 && /^\d+(?:\.\d+)?$/.test(text) ? text : null;
};

// Compare decimal strings directly: even 1.15000000000000001 must be above B0.
function compare(a, b) {
    const [ai, af = ''] = a.split('.');
    const [bi, bf = ''] = b.split('.');
    const left = ai.replace(/^0+(?=\d)/, '');
    const right = bi.replace(/^0+(?=\d)/, '');
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
    const width = Math.max(af.length, bf.length);
    return af.padEnd(width, '0') === bf.padEnd(width, '0') ? 0 : af.padEnd(width, '0') < bf.padEnd(width, '0') ? -1 : 1;
}

export function msOutcome(value, { closed = false, hidden = false } = {}) {
    if (closed) return { state: 'closed', value: null };
    if (hidden || value == null || String(value).trim() === '') return { state: 'missing', value: null };
    if (/^(?:-|—|kapalı|askıda|suspended)$/i.test(String(value).trim())) return { state: 'closed', value: null };
    const text = decimal(value);
    return text && compare(text, '0') > 0 ? { state: 'open', value: text } : { state: 'invalid', value: null };
}

export function emptyMsSet() {
    return Object.fromEntries(labels.map(label => [label, msOutcome(null)]));
}

// Repeated labels start another set; never let a later quote erase an earlier one.
export function collectMsSets(entries) {
    const sets = [];
    let set = emptyMsSet();
    let seen = new Set();
    for (const { label, outcome } of entries) {
        if (!label) continue;
        if (seen.has(label)) {
            sets.push(set);
            set = emptyMsSet();
            seen = new Set();
        }
        set[label] = outcome;
        seen.add(label);
    }
    sets.push(set);
    return sets;
}

export function msLabel(label) {
    return ({ '1': 'MS1', X: 'MSX', '0': 'MSX', '2': 'MS2' })[String(label).trim().toUpperCase()] || null;
}

export function isFullTimeMs(name) {
    return ['maç sonucu', 'ms', '1x2', '1 0 2', 'full time result', 'match result', 'match odds']
        .includes(String(name).trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' '));
}

export const msSnapshot = sets => ({ version: 1, sets });

export function validMsSnapshot(snapshot) {
    return snapshot?.version === 1 && Array.isArray(snapshot.sets) && snapshot.sets.every(set =>
        set && labels.every(label => {
            const outcome = set[label];
            return outcome && (outcome.state === 'open'
                ? typeof outcome.value === 'string' && decimal(outcome.value) === outcome.value && compare(outcome.value, '0') > 0
                : ['closed', 'missing', 'invalid'].includes(outcome.state) && outcome.value === null);
        }));
}

function bandFor(price) {
    const index = upperBounds.findIndex(upper => compare(price, upper) <= 0);
    return `B${index === -1 ? 7 : index}`;
}

function describe(set) {
    return labels.map(label => `${label} ${set[label].state === 'open' ? set[label].value
        : ({ closed: 'kapalı', missing: 'yok', invalid: 'okunamadı' })[set[label].state]}`).join(' · ');
}

function classifySet(raw) {
    const set = Object.fromEntries(labels.map(label => {
        const outcome = raw?.[label];
        return [label, outcome?.state === 'open' ? msOutcome(outcome.value)
            : { state: ['closed', 'missing', 'invalid'].includes(outcome?.state) ? outcome.state : 'missing', value: null }];
    }));
    const fail = (status, line) => ({ status, band: null, codes: [], sideBands: { MS1: null, MS2: null }, odds: set, lines: [line] });
    const one = set.MS1;
    const two = set.MS2;
    const open = outcome => outcome.state === 'open';
    if ((open(one) && open(two) && compare(one.value, '1.50') < 0 && compare(two.value, '1.50') < 0)
        || (labels.every(label => open(set[label]) && compare(set[label].value, '3.00') > 0))) {
        return fail('suspicious', `Okuma şüpheli: MS oranları tutarsız (${describe(set)}). Oran verisini kontrol edin.`);
    }
    let favorite;
    let band;
    let assumedClosed = false;
    if (open(one) && open(two)) {
        const order = compare(one.value, two.value);
        favorite = order < 0 ? 'MS1' : order > 0 ? 'MS2' : 'tie';
    } else if (one.state === 'closed' && open(two) || two.state === 'closed' && open(one)) {
        const openSide = open(one) ? 'MS1' : 'MS2';
        const price = set[openSide].value;
        if (compare(price, '1.50') <= 0) favorite = openSide;
        else if (compare(price, '7.00') > 0) {
            favorite = openSide === 'MS1' ? 'MS2' : 'MS1';
            band = 'B0';
            assumedClosed = true;
        }
    }
    if (!favorite) {
        const missing = ['MS1', 'MS2'].filter(label => !open(set[label])).map(label =>
            `${label} ${({ closed: 'kapalı', missing: 'veride yok', invalid: 'okunamadı' })[set[label].state]}`);
        return fail('unclassified', `Sınıflandırılamadı: ${missing.join(' · ')}. Maç Sonucu (1-X-2) oran verisi yetersiz.`);
    }
    const favoriteLabel = favorite === 'tie' ? 'MS1' : favorite;
    if (!assumedClosed && compare(set[favoriteLabel].value, '1.01') < 0) {
        return fail('suspicious', `Okuma şüpheli: ${favoriteLabel} ${set[favoriteLabel].value} bant dışı. Oran verisini kontrol edin.`);
    }
    band ||= bandFor(set[favoriteLabel].value);
    const codes = favorite === 'tie' ? [`Evb${band.slice(1)}`, `Depb${band.slice(1)}`]
        : [`${favorite === 'MS1' ? 'Ev' : 'Dep'}b${band.slice(1)}`];
    const sideBands = Object.fromEntries(['MS1', 'MS2'].map(label => {
        const inferred = assumedClosed && label === favorite;
        if (!open(set[label]) && !inferred) return [label, null];
        const sideBand = inferred ? band : bandFor(set[label].value);
        return [label, { band: sideBand, code: `${label === 'MS1' ? 'Ev' : 'Dep'}b${sideBand.slice(1)}`,
            ...(inferred ? { inferred: true } : {}) }];
    }));
    const other = sideBands[favorite === 'MS1' ? 'MS2' : 'MS1'];
    const otherLine = favorite !== 'tie' && other ? ` · ${other.band} aralığında ${other.code}` : '';
    return { status: 'classified', band, codes, sideBands, odds: set, lines: [
        `${favorite === 'tie' ? 'MS1 = MS2 (favori yok): ' : ''}${band} aralığında ${codes.join(' / ')}${otherLine}`,
        `${describe(set)}${assumedClosed ? ' · kapalı taraf ezici favori sayıldı' : ''}`
    ] };
}

export function classifyMatchBand(snapshot, verifiedProvider = true) {
    if (!verifiedProvider || snapshot?.version !== 1 || !Array.isArray(snapshot.sets)) {
        return { status: 'unavailable', band: null, codes: [], sideBands: { MS1: null, MS2: null }, odds: null,
            lines: ['Sınıflandırılamadı: doğrulanmış, orijinal Maç Sonucu verisi yok. MS verisinin yeniden alınması gerekiyor.'] };
    }
    if (!snapshot.sets.length) return classifySet(null);
    const results = snapshot.sets.map(classifySet);
    const first = results[0];
    if (results.some(result => result.status !== first.status || result.codes.join('/') !== first.codes.join('/')
        || JSON.stringify(result.sideBands) !== JSON.stringify(first.sideBands))) {
        return { status: 'conflict', band: null, codes: [], sideBands: { MS1: null, MS2: null }, odds: null,
            lines: ['Sınıflandırılamadı: Maç Sonucu setleri farklı sonuçlar veriyor.',
                ...results.map((result, index) => `Set ${index + 1}: ${describe(result.odds)}`),
                'Maç Sonucu setlerinden hangisinin geçerli olduğunu belirtin.'] };
    }
    return first;
}
