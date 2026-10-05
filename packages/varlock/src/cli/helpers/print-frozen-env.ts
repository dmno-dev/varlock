import { writeFileSync } from 'node:fs';
import ansis from 'ansis';

import type { SerializedEnvGraph } from '../../env-graph';
import { formattedValue } from '../../lib/formatting';
import { redactSensitiveDisplayValue } from '../../lib/sensitive-value';
import { injectedEnvStringForm } from '../../lib/injected-env-provenance';
import { getFrozenBootKeys } from '../../lib/frozen-boot-keys';
import { redactString } from '../../runtime/lib/redaction';
import { formatShellValue } from './shell-value';

/**
 * `varlock load` output for a frozen env (`--frozen`), built from the frozen graph alone: it
 * is complete on its own (boot-time values already applied), so no schema is loaded. Formats
 * match a normal load; `pretty` is a plain listing, since per-item validation details belong
 * to the freeze, not to this view.
 */
export function printFrozenEnv(graph: SerializedEnvGraph, opts: {
  format: string,
  agent: boolean,
  compact: boolean,
  summaryStderr: boolean,
  summaryFile?: string,
}) {
  const keys = Object.keys(graph.config);
  const bootKeys = getFrozenBootKeys(graph);

  const redact = (value: unknown) => {
    if (typeof value === 'string') return redactString(value);
    return value === undefined ? undefined : '[REDACTED]';
  };
  const summaryLine = (key: string) => {
    const item = graph.config[key];
    const display = item.isSensitive
      ? (redactSensitiveDisplayValue(item.value) ?? formattedValue(item.value, false))
      : formattedValue(item.value, false);
    return [
      `${key}${item.isSensitive ? ` 🔐${ansis.gray.italic('sensitive')}` : ''}${key in bootKeys ? ansis.gray.italic(' (boot)') : ''}`,
      `  └ ${display}`,
    ].join('\n');
  };

  if ((opts.summaryStderr || opts.summaryFile) && opts.format !== 'pretty') {
    const summaryStr = `${keys.map(summaryLine).join('\n')}\n`;
    if (opts.summaryStderr) process.stderr.write(summaryStr);
    if (opts.summaryFile) writeFileSync(opts.summaryFile, summaryStr);
  }

  if (opts.format === 'pretty') {
    console.error(ansis.bold.green('-- Frozen config --'));
    for (const key of keys) console.log(summaryLine(key));
  } else if (opts.format === 'json') {
    const env: Record<string, unknown> = {};
    for (const key of keys) {
      const item = graph.config[key];
      env[key] = opts.agent && item.isSensitive ? redact(item.value) : item.value;
    }
    console.log(JSON.stringify(env, null, 2));
  } else if (opts.format === 'json-full') {
    const output = structuredClone(graph);
    if (opts.agent) {
      for (const item of Object.values(output.config)) {
        if (item.isSensitive) item.value = redact(item.value);
      }
    }
    console.log(JSON.stringify(output, null, opts.compact ? 0 : 2));
  } else if (opts.format === 'env' || opts.format === 'shell') {
    const skipUndefined = opts.compact
      || (opts.format === 'shell' && !graph.settings?.injectUndefinedAsEmpty);
    const prefix = opts.format === 'shell' ? 'export ' : '';
    for (const key of keys) {
      const item = graph.config[key];
      if (item.value === undefined && skipUndefined) continue;
      let strValue: string;
      if (item.value === undefined) {
        strValue = '';
      } else if (typeof item.value === 'string' || typeof item.value === 'object') {
        const stringForm = injectedEnvStringForm(item) ?? '';
        strValue = opts.format === 'shell'
          ? formatShellValue(stringForm)
          : `"${stringForm.replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
      } else {
        // bare scalars (numbers/booleans) stay unquoted so re-reading infers the same type
        strValue = String(item.value);
      }
      console.log(`${prefix}${key}=${strValue}`);
    }
  } else {
    throw new Error(`Unknown format: ${opts.format}`);
  }
}
