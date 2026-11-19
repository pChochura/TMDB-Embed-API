function parseQuality(qualityString) {
  if (!qualityString || typeof qualityString !== 'string') return 0;
  const q = qualityString.toLowerCase();
  if (q.includes('auto')) return 1080;
  if (q.includes('4k') || q.includes('2160')) return 2160;
  if (q.includes('1440')) return 1440;
  if (q.includes('1080')) return 1080;
  if (q.includes('720')) return 720;
  if (q.includes('576')) return 576;
  if (q.includes('480')) return 480;
  if (q.includes('360')) return 360;
  if (q.includes('240')) return 240;
  const kbps = q.match(/(\d+)k/); if (kbps) return parseInt(kbps[1],10)/1000;
  if (q.includes('hd')) return 720;
  if (q.includes('sd')) return 480;
  if (q.includes('cam')) return 100;
  if (q.includes('ts')) return 200;
  if (q.includes('scr')) return 300;
  if (q.includes('dvdscr')) return 350;
  if (q.includes('r5') || q.includes('r6')) return 400;
  if (q.includes('org')) return 4320;
  return 0;
}

function filterByMinQuality(streams, minQualitySetting) {
  if (!minQualitySetting || minQualitySetting.toLowerCase() === 'all') return streams;
  const minNumeric = parseQuality(minQualitySetting);
  if (minNumeric === 0 && minQualitySetting.toLowerCase() !== 'all') return streams;
  return streams.filter(s => parseQuality(s.quality) >= minNumeric);
}

function filterByCodecs(streams, exclude) {
  if (!exclude || (!exclude.excludeDV && !exclude.excludeHDR)) return streams;
  return streams.filter(s => {
    if (!Array.isArray(s.codecs)) return true;
    if (exclude.excludeDV && s.codecs.includes('DV')) return false;
    if (exclude.excludeHDR && s.codecs.some(c => ['HDR','HDR10','HDR10+'].includes(c))) return false;
    return true;
  });
}

const LANGUAGE_ALIASES = {
  en: ['en', 'eng', 'english', 'orig', 'original'],
  multi: ['multi', 'multiaudio', 'multi-audio', 'dual', 'dual-audio', 'multi audio', 'dual audio'],
  pl: ['pl', 'pol', 'polish', 'polski', 'lektor', 'napisy', 'dubbing'],
  es: ['es', 'spa', 'spanish', 'espanol', 'español', 'castellano', 'latino'],
  fr: ['fr', 'fre', 'fra', 'french', 'francais', 'français', 'vff', 'vfq'],
  de: ['de', 'ger', 'deu', 'german', 'deutsch'],
  it: ['it', 'ita', 'italian', 'italiano'],
  pt: ['pt', 'por', 'portuguese', 'português'],
  hi: ['hi', 'hin', 'hindi'],
  ja: ['ja', 'jpn', 'japanese', 'japan'],
  ko: ['ko', 'kor', 'korean', 'korea'],
  zh: ['zh', 'chi', 'zho', 'chinese'],
  ru: ['ru', 'rus', 'russian']
};

function detectStreamLanguages(s) {
  if (!s || typeof s !== 'object') return ['unknown'];
  const langs = new Set();

  // 1. Provider-level detection
  if (s.provider === 'polish') {
    langs.add('pl');
    langs.add('polish');
  }

  // 2. Explicit language / lang property
  if (s.language && typeof s.language === 'string') {
    const l = s.language.toLowerCase().trim();
    langs.add(l);
    if (l.includes('multi')) langs.add('multi');
    if (l.includes('eng')) langs.add('en');
    if (l.includes('pol')) langs.add('pl');
    if (l.includes('hin')) langs.add('hi');
    if (l.includes('spa') || l.includes('esp')) langs.add('es');
    if (l.includes('fre') || l.includes('fra')) langs.add('fr');
    if (l.includes('ger') || l.includes('deu')) langs.add('de');
    if (l.includes('ita')) langs.add('it');
    if (l.includes('rus')) langs.add('ru');
    if (l.includes('jap')) langs.add('ja');
  }
  if (s.lang && typeof s.lang === 'string') {
    langs.add(s.lang.toLowerCase().trim());
  }

  // 3. Audio tracks array
  if (Array.isArray(s.audioTracks)) {
    for (const track of s.audioTracks) {
      if (track) {
        if (track.language) langs.add(String(track.language).toLowerCase().trim());
        if (track.label) langs.add(String(track.label).toLowerCase().trim());
      }
    }
  }

  // 4. Subtitles (marked as subtitle indicators)
  if (Array.isArray(s.subtitles)) {
    for (const sub of s.subtitles) {
      if (sub) {
        const subLang = sub.lang || sub.language;
        if (subLang) langs.add(`sub:${String(subLang).toLowerCase().trim()}`);
      }
    }
  }

  // 5. String search in title and name
  const text = `${s.name || ''} ${s.title || ''}`.toLowerCase();

  if (/\b(multi[- ]?audio|dual[- ]?audio)\b/i.test(text)) langs.add('multi');
  if (/\b(original|orig)\b/i.test(text)) langs.add('original');
  if (/\b(english|eng|eng[- ]?dub|dubbed)\b/i.test(text) || /\[eng(lish)?\]/i.test(text)) langs.add('en');
  if (/\b(polish|polski|lektor|napisy|dubbing)\b/i.test(text) || /\[pl\b/i.test(text) || /\bpl[- ]/i.test(text)) langs.add('pl');
  if (/\b(spanish|espanol|español|castellano|latino)\b/i.test(text) || /\[es(p)?\]/i.test(text)) langs.add('es');
  if (/\b(french|francais|français|vff|vfq)\b/i.test(text) || /\[fr(a)?\]/i.test(text)) langs.add('fr');
  if (/\b(german|deutsch)\b/i.test(text) || /\[de(u)?\]/i.test(text)) langs.add('de');
  if (/\b(italian|italiano)\b/i.test(text) || /\[it(a)?\]/i.test(text)) langs.add('it');
  if (/\b(hindi)\b/i.test(text) || /\[hin?(di)?\]/i.test(text)) langs.add('hi');
  if (/\b(japanese|anime)\b/i.test(text) || /\[ja(p)?\]/i.test(text)) langs.add('ja');
  if (/\b(korean)\b/i.test(text) || /\[kor?\]/i.test(text)) langs.add('ko');
  if (/\b(russian)\b/i.test(text) || /\[rus?\]/i.test(text)) langs.add('ru');
  if (/\b(portuguese|português)\b/i.test(text) || /\[pt|por\]/i.test(text)) langs.add('pt');

  // AnimePahe specific tags
  if (/\bdub\b/i.test(text)) langs.add('en');
  if (/\bsub\b/i.test(text)) {
    langs.add('ja');
    langs.add('sub:en');
  }

  if (langs.size === 0) {
    langs.add('unknown');
  }

  return Array.from(langs);
}

function matchesAnyLanguage(detectedLangs, targetLangs, allowUnknownFallback = false) {
  if (!Array.isArray(targetLangs) || targetLangs.length === 0) return false;

  const normalizedTargets = targetLangs.map(l => String(l).toLowerCase().trim()).filter(Boolean);
  if (normalizedTargets.length === 0 || normalizedTargets.includes('all')) return true;

  const targetAliases = new Set();
  for (const t of normalizedTargets) {
    targetAliases.add(t);
    for (const [key, aliases] of Object.entries(LANGUAGE_ALIASES)) {
      if (key === t || aliases.includes(t)) {
        targetAliases.add(key);
        aliases.forEach(a => targetAliases.add(a));
      }
    }
  }

  // Untagged/unknown content in general aggregators is treated as English/Original
  if (allowUnknownFallback && detectedLangs.includes('unknown')) {
    const englishOrUnknown = ['en', 'eng', 'english', 'orig', 'original', 'unknown'];
    if (englishOrUnknown.some(e => targetAliases.has(e))) {
      return true;
    }
  }

  // Multi-audio streams include English audio
  if (detectedLangs.includes('multi')) {
    if (['en', 'eng', 'english', 'multi', 'multiaudio'].some(e => targetAliases.has(e))) {
      return true;
    }
  }

  for (const detected of detectedLangs) {
    const norm = String(detected).toLowerCase().trim();
    if (targetAliases.has(norm)) return true;
    if (norm.startsWith('sub:')) {
      const subCode = norm.slice(4);
      if (targetAliases.has(subCode)) return true;
    }
  }

  return false;
}

function filterByLanguage(streams, allowedLanguages, excludeLanguages) {
  if (!Array.isArray(streams) || streams.length === 0) return streams;

  const hasAllowed = Array.isArray(allowedLanguages) && allowedLanguages.length > 0 && !allowedLanguages.includes('all');
  const hasExclude = Array.isArray(excludeLanguages) && excludeLanguages.length > 0;

  if (!hasAllowed && !hasExclude) return streams;

  return streams.filter(s => {
    const detected = detectStreamLanguages(s);

    // Check exclude rules first
    if (hasExclude && matchesAnyLanguage(detected, excludeLanguages, false)) {
      return false;
    }

    // Check allow rules
    if (hasAllowed) {
      return matchesAnyLanguage(detected, allowedLanguages, true);
    }

    return true;
  });
}

function applyFilters(streams, providerName, minQualitiesConfig, excludeCodecsConfig, allowedLanguagesConfig, excludeLanguagesConfig) {
  let minQuality = null;
  if (minQualitiesConfig) {
    if (typeof minQualitiesConfig === 'string') minQuality = minQualitiesConfig;
    else if (minQualitiesConfig.default) minQuality = minQualitiesConfig.default;
  }
  let filtered = filterByMinQuality(streams, minQuality);
  filtered = filterByCodecs(filtered, excludeCodecsConfig);
  filtered = filterByLanguage(filtered, allowedLanguagesConfig, excludeLanguagesConfig);
  return filtered;
}

module.exports = {
  applyFilters,
  parseQuality,
  filterByMinQuality,
  filterByCodecs,
  filterByLanguage,
  detectStreamLanguages
};
