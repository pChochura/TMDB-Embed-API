/**
 * Polish title matching utility ported from GrzegorzWalewski/polish-movies-and-series-fetcher
 * (and zetta's ScraperService matching).
 *
 * Provides word-boundary matching, subtitle colon stripping, and ±1 year tolerance
 * to avoid false positives (e.g., "zdunek" for "dune") while accommodating festival vs.
 * theatrical release date discrepancies.
 */

/**
 * Replace Polish diacritics with plain Latin equivalents while preserving casing and structure
 */
function deburrPolish(str = '') {
  if (!str) return '';
  return String(str)
    .replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (c) => {
      const map = {
        'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n',
        'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
        'Ą': 'A', 'Ć': 'C', 'Ę': 'E', 'Ł': 'L', 'Ń': 'N',
        'Ó': 'O', 'Ś': 'S', 'Ź': 'Z', 'Ż': 'Z'
      };
      return map[c] || c;
    })
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * "Title: Subtitle" -> "Title" (strips subtitle after colon for broader searching)
 */
function cleanColonTitle(title = '') {
  if (!title) return '';
  return String(title).split(':')[0].trim();
}

/**
 * Normalize title string for diacritics-safe, symbol-stripped comparison
 */
function normalizePolish(title = '') {
  return String(title)
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/gi, (c) => {
      const map = {
        'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n',
        'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
        'Ą': 'a', 'Ć': 'c', 'Ę': 'e', 'Ł': 'l', 'Ń': 'n',
        'Ó': 'o', 'Ś': 's', 'Ź': 'z', 'Ż': 'z'
      };
      return map[c] || c;
    })
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Word-boundary-safe title match:
 * Checks exact equality, prefix, suffix, or space-bound containment — prevents
 * accidental substring hits (such as "zdunek" matching "dune").
 */
function matchesQuery(title = '', query = '') {
  const q = normalizePolish(query);
  const n = normalizePolish(title);
  if (!q || !n) return false;
  return (
    n === q ||
    n.startsWith(`${q} `) ||
    n.endsWith(` ${q}`) ||
    n.includes(` ${q} `) ||
    (q.includes(' ') && n.includes(q))
  );
}

/**
 * Pick best matches from candidate items:
 * - Filters items that match the title query (or colon-cleaned title query)
 * - If target year is provided, prioritizes exact year (rank 0), allows ±1 year (rank 1),
 *   and discards distant years (> 1 year)
 * - Breaks ties by shortest title length to prefer canonical releases over spinoffs
 */
function pickMatches(results = [], params = {}) {
  if (!Array.isArray(results) || results.length === 0) return [];
  const targetTitle = params.title || '';
  const cleanedTitle = cleanColonTitle(targetTitle);

  let matches = results.filter((r) => {
    const candidateTitle = r.title || r.name || '';
    return matchesQuery(candidateTitle, targetTitle) || matchesQuery(candidateTitle, cleanedTitle);
  });

  if (params.year && matches.length > 1) {
    const targetY = parseInt(params.year, 10);
    const yearOk = (m, yStr) => {
      const y = String(yStr);
      return (
        m.year === y ||
        String(m.releaseYear || '').includes(y) ||
        String(m.title || '').includes(y) ||
        String(m.url || '').includes(y)
      );
    };

    const rank = (m) => {
      if (yearOk(m, params.year)) return 0;
      if (Number.isFinite(targetY) && (yearOk(m, String(targetY - 1)) || yearOk(m, String(targetY + 1)))) {
        return 1;
      }
      return 2;
    };

    if (!matches.some((m) => rank(m) === 0)) {
      // No exact-year hit: keep ±1 year items if available
      const near = matches.filter((m) => rank(m) <= 1);
      if (near.length > 0) matches = near;
    } else {
      // Exact hit exists: drop items clearly off-year (> 1 year diff)
      matches = matches.filter((m) => rank(m) < 2);
    }

    return [...matches].sort((a, b) => {
      const rA = rank(a);
      const rB = rank(b);
      if (rA !== rB) return rA - rB;
      const lenA = (a.title || a.name || '').length;
      const lenB = (b.title || b.name || '').length;
      return lenA - lenB;
    });
  }

  return matches.sort((a, b) => {
    const lenA = (a.title || a.name || '').length;
    const lenB = (b.title || b.name || '').length;
    return lenA - lenB;
  });
}

module.exports = {
  deburrPolish,
  cleanColonTitle,
  normalizePolish,
  matchesQuery,
  pickMatches
};
