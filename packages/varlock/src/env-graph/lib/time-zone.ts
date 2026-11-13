/*
  Time zone name validation for the `timeZone` data type.

  We lean on the runtime's own tz database via `Intl` so we ship no zone list, but accept only one
  spelling per zone: the runtime's canonical names (`Intl.supportedValuesOf('timeZone')`), with
  the old spellings CLDR froze for stability swapped for their current IANA names. Engines are
  much looser than that (they match case-insensitively, accept legacy aliases like `US/Eastern`
  and UTC offsets like `+05:00`) and they disagree with each other on all of it, while most
  consumers (e.g. the `TZ` env var on Linux) are case-sensitive and may not know every alias.

  NOTE: copied to packages/vscode-plugin/src/time-zone.ts - keep them in sync.
*/

// CLDR keeps these old spellings as canonical ids, so Node reports them instead of the current
// IANA names (Bun reports the name it was given). See https://github.com/tc39/proposal-canonical-tz
const LEGACY_TIME_ZONE_NAMES: Record<string, string> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

// fixed-offset zones, which Node leaves out of supportedValuesOf
const ETC_GMT_OFFSET_REGEX = /^Etc\/GMT[+-]\d{1,2}$/;
const UTC_ALIAS_REGEX = /^(?:Etc\/)?(?:UTC|UCT|GMT[+-]?0?|Greenwich|Universal|Zulu)$/i;

let standardNamesByLowercase: Map<string, string> | undefined;
function getStandardNamesByLowercase() {
  if (!standardNamesByLowercase) {
    const supported = (Intl as any).supportedValuesOf?.('timeZone') as Array<string> | undefined;
    const names = [...supported ?? [], 'UTC', ...Object.values(LEGACY_TIME_ZONE_NAMES)]
      .filter((name) => !(name in LEGACY_TIME_ZONE_NAMES));
    standardNamesByLowercase = new Map(names.map((name) => [name.toLowerCase(), name]));
  }
  return standardNamesByLowercase;
}

/** returns an error message, or undefined if `val` is a standard IANA time zone name */
export function checkTimeZoneName(val: string): string | undefined {
  if (/^[+-]\d/.test(val)) return 'Value must be an IANA time zone name, not a UTC offset';
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: val }).resolvedOptions().timeZone;
  } catch {
    return `"${val}" is not a known IANA time zone`;
  }
  const standardNames = getStandardNamesByLowercase();
  if (standardNames.get(val.toLowerCase()) === val || ETC_GMT_OFFSET_REGEX.test(val)) return;

  // wrong case, or else the zone the engine resolved the alias to (Node resolves aliases like
  // `US/Eastern`, Bun keeps them as given, so there may be nothing to suggest)
  const suggestion = standardNames.get(val.toLowerCase())
    ?? (UTC_ALIAS_REGEX.test(resolved) ? 'UTC' : undefined)
    ?? LEGACY_TIME_ZONE_NAMES[resolved]
    ?? standardNames.get(resolved.toLowerCase());
  return suggestion
    ? `"${val}" is not a standard IANA time zone name, use "${suggestion}"`
    : `"${val}" is not a standard IANA time zone name`;
}
