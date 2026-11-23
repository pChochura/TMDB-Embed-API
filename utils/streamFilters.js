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
  en: ['en', 'eng', 'english'],
  pl: ['pl', 'pol', 'polish', 'polski', 'lektor', 'napisy', 'dubbing'],
  hi: ['hi', 'hin', 'hindi'],
  ta: ['ta', 'tam', 'tamil'],
  te: ['te', 'tel', 'telugu'],
  kn: ['kn', 'kan', 'kannada'],
  ml: ['ml', 'mal', 'malayalam'],
  bn: ['bn', 'bengali'],
  pa: ['pa', 'punjabi'],
  mr: ['mr', 'marathi'],
  es: ['es', 'spa', 'spanish', 'espanol', 'español', 'castellano', 'latino'],
  fr: ['fr', 'fre', 'fra', 'french', 'francais', 'français', 'vff', 'vfq'],
  de: ['de', 'ger', 'deu', 'german', 'deutsch'],
  it: ['it', 'ita', 'italian', 'italiano'],
  pt: ['pt', 'por', 'portuguese', 'português'],
  ru: ['ru', 'rus', 'russian'],
  ja: ['ja', 'jpn', 'japanese', 'japan'],
  ko: ['ko', 'kor', 'korean', 'korea'],
  zh: ['zh', 'chi', 'zho', 'chinese', 'mandarin', 'cantonese'],
  ar: ['ar', 'ara', 'arabic'],
  tr: ['tr', 'tur', 'turkish'],
  multi: ['multi', 'multiaudio', 'multi-audio', 'dual', 'dual-audio', 'multi audio', 'dual audio']
};

function extractUrlText(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  try {
    let result = '';
    const key5Match = urlStr.match(/(?:KEY5|filename|file)=([^&]+)/i);
    if (key5Match) {
      try {
        result += ' ' + decodeURIComponent(key5Match[1]);
      } catch {
        result += ' ' + key5Match[1];
      }
    }
    const nestedUrlMatch = urlStr.match(/[?&]url=([^&]+)/i);
    if (nestedUrlMatch) {
      try {
        const decodedNested = decodeURIComponent(nestedUrlMatch[1]);
        result += ' ' + extractUrlText(decodedNested);
      } catch {
        result += ' ' + nestedUrlMatch[1];
      }
    }
    try {
      const parsed = new URL(urlStr, 'http://localhost');
      result += ' ' + decodeURIComponent(parsed.pathname);
    } catch {
      result += ' ' + urlStr;
    }
    return result;
  } catch {
    return urlStr;
  }
}

function getCanonicalLang(codeOrName) {
  if (!codeOrName) return null;
  const lower = String(codeOrName).toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(LANGUAGE_ALIASES)) {
    if (canonical === lower || aliases.includes(lower)) return canonical;
  }
  return lower;
}

function detectStreamLanguages(s) {
  if (!s || typeof s !== 'object') return { langs: ['unknown'], isMulti: false };
  const langs = new Set();
  let isMulti = false;

  // 1. Provider-level detection
  if (s.provider === 'polish') {
    langs.add('pl');
  }

  // 2. Explicit language / lang property
  const explicit = s.language || s.lang;
  if (typeof explicit === 'string') {
    const l = explicit.toLowerCase().trim();
    if (l !== 'auto' && l !== 'unknown') {
      const canon = getCanonicalLang(l);
      if (canon === 'multi') isMulti = true;
      else if (canon) langs.add(canon);
    }
  }

  // 3. Audio tracks array
  if (Array.isArray(s.audioTracks) && s.audioTracks.length > 0) {
    if (s.audioTracks.length > 1) isMulti = true;
    for (const track of s.audioTracks) {
      if (track) {
        const c1 = getCanonicalLang(track.language);
        if (c1) langs.add(c1);
        const c2 = getCanonicalLang(track.label);
        if (c2) langs.add(c2);
      }
    }
  }

  // 4. Text analysis of name, title, filename, and url (subtitles are excluded so text subtitles do not misrepresent audio)
  const urlText = extractUrlText(s.url);
  const rawText = `${s.name || ''} ${s.title || ''} ${s.filename || ''} ${urlText}`;
  const text = rawText.replace(/[._+]/g, ' ').toLowerCase();

  // Multi / Dual tags
  if (/\b(multi[- ]?audio|dual[- ]?audio|multi|dual)\b/i.test(text)) {
    isMulti = true;
  }

  // Bracketed language tags, e.g. [Hindi], [Tamil], [English], [Hindi-Tamil-Telugu], [PL Lektor]
  const bracketMatches = rawText.match(/\[([a-z0-9\s\-+/,.]+)\]/gi) || [];
  for (const b of bracketMatches) {
    const inside = b.replace(/\[|\]/g, '').toLowerCase();
    for (const [canon, aliases] of Object.entries(LANGUAGE_ALIASES)) {
      if (canon === 'multi') continue;
      if (aliases.some(a => new RegExp(`(^|[^a-z])${a}([^a-z]|$)`, 'i').test(inside))) {
        langs.add(canon);
      }
    }
  }

  // Scene release Italian tags in rawText
  if (
    /(?:^|[._\-\s])ita(?:[._\-\s]|$)/i.test(rawText) ||
    /(?:^|[._\-\s])ita-(?:eng|ita)/i.test(rawText) ||
    /(?:^|[._\-\s])(?:2160p|1080p|720p|4k|web|bluray|h264|h265|hevc)[._\-\s]it[._\-\s]/i.test(rawText)
  ) {
    langs.add('it');
  }

  // General text keywords across the name/title/url string
  for (const [canon, aliases] of Object.entries(LANGUAGE_ALIASES)) {
    if (canon === 'multi') continue;
    for (const a of aliases) {
      if (a.length <= 2) {
        const regex = new RegExp(`(\\[|\\b)${a}(\\]|[- ](audio|dub|dubbing|lektor|napisy))`, 'i');
        if (regex.test(text)) langs.add(canon);
      } else {
        const regex = new RegExp(`\\b${a}\\b`, 'i');
        if (regex.test(text)) langs.add(canon);
      }
    }
  }

  // AnimePahe specific: (Dub) is English dub
  if (/\bdub\b/i.test(text) && !langs.has('pl')) {
    langs.add('en');
  }

  if (langs.size > 1) {
    isMulti = true;
  }

  if (langs.size === 0) {
    return { langs: isMulti ? ['multi'] : ['unknown'], isMulti, isPolishProvider: s.provider === 'polish' };
  }

  return { langs: Array.from(langs), isMulti, isPolishProvider: s.provider === 'polish' };
}

function streamMatchesAllowed(streamInfo, allowedCanons) {
  const { langs, isMulti } = streamInfo;

  // Untagged streams: Western aggregators return original audio (predominantly English)
  if (langs.length === 1 && langs[0] === 'unknown') {
    return allowedCanons.has('en') || allowedCanons.has('unknown');
  }

  // If stream is marked multi with no other specific languages
  if (langs.length === 1 && langs[0] === 'multi') {
    return allowedCanons.has('multi');
  }

  // Stream has detected languages
  // Check if any detected language is a foreign language NOT in allowedCanons
  const foreignNonAllowed = langs.filter(l => !allowedCanons.has(l) && l !== 'multi' && l !== 'unknown');

  if (foreignNonAllowed.length > 0) {
    // If it has foreign languages not allowed (e.g. Hindi, Tamil):
    // Only allow if multi is explicitly allowed AND the stream also contains an allowed language
    if (isMulti && allowedCanons.has('multi') && langs.some(l => allowedCanons.has(l))) {
      return true;
    }
    return false;
  }

  // If stream is marked multi/dual, but multi is NOT allowed:
  // Only allow if ALL detected audio tracks are explicitly in allowedCanons (e.g. English + Polish)
  // If only one language is detected and it is marked multi/dual (e.g. "Dual YG", "Multi"),
  // then the second audio track is unknown/foreign, so multi must be explicitly allowed!
  if (isMulti && !allowedCanons.has('multi')) {
    if (streamInfo.isPolishProvider && allowedCanons.has('pl')) {
      return true;
    }
    const knownAllowed = langs.filter(l => allowedCanons.has(l));
    if (knownAllowed.length < 2) {
      return false;
    }
  }

  // All detected languages are allowed
  return langs.some(l => allowedCanons.has(l));
}

function streamMatchesExclude(streamInfo, excludeCanons) {
  const { langs } = streamInfo;
  return langs.some(l => excludeCanons.has(l));
}

function filterByLanguage(streams, allowedLanguages, excludeLanguages) {
  if (!Array.isArray(streams) || streams.length === 0) return streams;

  const hasAllowed = Array.isArray(allowedLanguages) && allowedLanguages.length > 0 && !allowedLanguages.includes('all');
  const hasExclude = Array.isArray(excludeLanguages) && excludeLanguages.length > 0;

  if (!hasAllowed && !hasExclude) return streams;

  const allowedCanons = new Set();
  if (hasAllowed) {
    for (const l of allowedLanguages) {
      const c = getCanonicalLang(l);
      if (c) allowedCanons.add(c);
    }
  }

  const excludeCanons = new Set();
  if (hasExclude) {
    for (const l of excludeLanguages) {
      const c = getCanonicalLang(l);
      if (c) excludeCanons.add(c);
    }
  }

  return streams.filter(s => {
    const streamInfo = detectStreamLanguages(s);

    if (hasExclude && streamMatchesExclude(streamInfo, excludeCanons)) {
      return false;
    }

    if (hasAllowed && !streamMatchesAllowed(streamInfo, allowedCanons)) {
      return false;
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
  detectStreamLanguages,
  getCanonicalLang
};
