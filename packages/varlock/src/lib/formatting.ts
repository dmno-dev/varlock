import ansis, { type AnsiColors, type AnsiStyles } from 'ansis';
import _ from '@env-spec/utils/my-dash';

import { ConfigItem, VarlockError } from '../env-graph';
import { redactString } from '../runtime/lib/redaction';

type ColorMod = AnsiStyles | AnsiColors;
type ColorMods = ColorMod | Array<ColorMod>;

function applyMods(str: string, mods?: ColorMods) {
  if (!mods) return str;
  if (_.isArray(mods)) {
    let modStr = str;
    mods.forEach((mod) => {
      modStr = ansis[mod](modStr);
    });
    return modStr;
  }
  return ansis[mods](str);
}

export function formattedValue(val: any, showType = false) {
  let strVal: string = '';
  let strType: string = '';
  let mods: ColorMods | undefined;
  if (_.isBoolean(val)) {
    strVal = val.toString();
    mods = ['yellow', 'italic'];
    strType = 'boolean';
  } else if (_.isNumber(val)) {
    strVal = val.toString();
    mods = 'yellow';
    strType = 'number';
  } else if (_.isString(val)) {
    strVal = `"${val}"`;
    strType = 'string';
  } else if (_.isPlainObject(val)) {
    // TODO: can definitely make this better...
    strVal = JSON.stringify(val);
    strType = 'object';
  } else if (val === null) {
    strVal = 'null';
    mods = 'gray';
  } else if (val === undefined) {
    strVal = 'undefined';
    mods = 'gray';
  }
  return [
    applyMods(strVal, mods),
    showType && strType ? ansis.gray(` (${strType})`) : '',
  ].join('');
}


export function formatError(err: VarlockError) {
  let whenStr = '';
  if (err.type === 'SchemaError') {
    whenStr += 'during schema initialization';
  }
  if (err.type === 'ValidationError') {
    whenStr += 'during validation';
  }
  if (err.type === 'CoercionError') {
    whenStr += 'during coercion';
  }
  if (err.type === 'ResolutionError') {
    whenStr += 'during resolution';
  }

  let errStr = `${err.icon} ${err.message}`;
  if (err.isUnexpected) {
    errStr += ansis.gray.italic(`\n   (unexpected error${whenStr ? ` ${whenStr}` : ''})`);
    if ('stack' in err) errStr += err.stack;
  }
  return errStr;
}

export function joinAndCompact(strings: Array<string | number | boolean | undefined | null | false>, joinChar = ' ') {
  return strings.filter((s) => (
    // we'll not filter out empty strings - because it's useful to just add newlines
    s !== undefined && s !== null && s !== false
  )).join(joinChar);
}

const VALIDATION_STATE_COLORS = {
  error: 'red',
  warn: 'yellow',
  valid: 'cyan',
} as const;

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  return `${w}w`;
}

export function formatTimeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffS = Math.floor(diffMs / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export function getItemSummary(item: ConfigItem) {
  const summary: Array<string> = [];
  const itemErrors = item.errors;
  const icon = itemErrors.length ? itemErrors[0].icon : '✅';
  const isSensitive = item.isSensitive;
  const isRequired = item.isRequired;
  summary.push(joinAndCompact([
    icon,
    ansis[VALIDATION_STATE_COLORS[item.validationState]](item.key) + (isRequired ? ansis.magenta('*') : ''),

    // ansis.gray(`[type = ${item.type.typeLabel}]`),
    isSensitive && ` 🔐${ansis.gray.italic('sensitive')}`,

    // item.useAt ? ansis.gray.italic(`(${item.useAt?.join(', ')})`) : undefined,
  ]));

  let valAsStr = formattedValue(item.resolvedValue, false);
  if (isSensitive && item.resolvedValue && _.isString(item.resolvedValue)) {
    valAsStr = redactString(item.resolvedValue)!;
  }

  // build inline indicators to append after the value
  const indicators: Array<string> = [];
  if (item.isCacheHit) {
    const oldest = Math.min(...item._cacheHits.map((h) => h.cachedAt));
    indicators.push(ansis.gray(`📦 ${formatTimeAgo(oldest)}`));
  }
  if (item.isOverridden) {
    indicators.push(ansis.yellow('🟡 process.env'));
  }

  summary.push(joinAndCompact([
    ansis.gray('   └'),
    valAsStr,
    item.isCoerced && (
      ansis.gray.italic('< coerced from ')
      + (isSensitive ? formattedValue(item.resolvedRawValue) : formattedValue(item.resolvedRawValue, false))
    ),
    indicators.length > 0 && ansis.gray(' ') + indicators.join(' '),
  ]));

  itemErrors?.forEach((err) => {
    summary.push(ansis[err.isWarning ? 'yellow' : 'red'](`   - ${err.isWarning ? '[WARNING] ' : ''}${err.message}`));

    // TODO: standardize here how we show parse error locations and stack info?

    // summary.push(...err.cleanedStack || '');
    if (err.tip) {
      summary.push(...err.tip.split('\n').map((line) => `     ${line}`));
    }
  });

  // NO OBJECT/CHILDREN FOR NOW
  // for (const childItem of _.values(item.children)) {
  //   const childSummary = getItemSummary(childItem);
  //   summary.push(childSummary.split('\n').map((l) => `  ${l}`).join('\n'));
  // }

  return summary.join('\n');
}
