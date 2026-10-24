// Tolerant pre-pass. The env-spec parser rejects a whole file on one half-typed line, so while the user is typing
// we close brackets/quotes left open at the end of a decorator or value line and blank a bare `@`. Offsets the
// parser reports are mapped back to the original buffer with toOrig().
//
// A bracket left open on a line is only closed when the following continuation lines don't close it, so valid
// multi-line values and decorators (`X=if(` ... `)`, `@import(..., pick=[` ... `])`) are left alone. If repairing
// makes the buffer unparseable (`[redis)`), loadRepaired falls back to the buffer as typed.
// Also handled: CRLF (the parser normalizes to LF, so offsets are in LF coordinates and are mapped back), a
// `#tag` inside ( [ { is data rather than a trailing comment, and an empty buffer.

export type RepairInsert = { at: number, len: number, origAt: number, closer: string, line: number };
export type Repaired = {
  /** the buffer the parser sees */
  text: string,
  /** closers the pre-pass appended, in repaired coordinates */
  inserts: Array<RepairInsert>,
  /** original offsets of each bare `@` that was blanked */
  blanked: Array<number>,
  /** repaired offset to original offset */
  toOrig: (offset: number) => number,
};

type ScanState = { stack: Array<string>, quote: string | null };

// bracket/quote state after scanning `line` from `from`; a ` #` outside brackets ends the line (comment)
function scan(line: string, from: number, st: ScanState): ScanState {
  const stack = [...st.stack];
  let quote = st.quote;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    // trailing comment (inside brackets a `#tag` is data)
    if (c === '#' && /\s/.test(line[i - 1] ?? '') && !stack.length) break;
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '$' && line[i + 1] === '{') {
      stack.push('}');
      i++;
    } else if (c === '(') {
      stack.push(')');
    } else if (c === '[') {
      stack.push(']');
    } else if (c === '{') {
      stack.push('}');
    } else if ((c === ')' || c === ']' || c === '}') && stack.at(-1) === c) {
      stack.pop();
    }
  }
  return { stack, quote };
}

const isDecLine = (l: string) => /^\s*#\s*@/.test(l);
const isItemLine = (l: string) => /^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*=/.test(l);

export function repairContent(original: string, { closers = true } = {}): Repaired {
  const content = original.replace(/\r\n/g, '\n');
  // LF offsets of each `\n` that was `\r\n` in the original
  const crlfAt: Array<number> = [];
  if (content.length !== original.length) {
    for (let i = 0; i < original.length; i++) {
      if (original[i] === '\r' && original[i + 1] === '\n') crlfAt.push(i - crlfAt.length);
    }
  }
  const lines = content.split('\n');

  // a statement left open on line li is VALID if the following continuation lines close it (a multi-line
  // value, or a multi-line decorator call in comment lines); then nothing is repaired
  const closesLater = (li: number, st: ScanState, inComment: boolean) => {
    for (let j = li + 1; j < lines.length; j++) {
      const l = lines[j];
      if (isDecLine(l) || isItemLine(l) || /^\s*#\s*-{3,}/.test(l)) return -1; // a new statement starts
      if (inComment && !/^\s*#/.test(l)) return -1;
      st = scan(l, inComment ? l.indexOf('#') + 1 : 0, st);
      if (!st.stack.length && !st.quote) return j;
    }
    return -1;
  };

  let out = '';
  const inserts: Array<RepairInsert> = [];
  const blanked: Array<number> = [];
  let origOff = 0;
  let skipTo = -1;
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    let start = -1;
    const inContinuation = li <= skipTo;
    const dm = closers && !inContinuation ? /^\s*#\s*@/.exec(line) : null;
    if (dm) {
      start = dm[0].length - 1;
    } else if (closers && !inContinuation) {
      const vm = /^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*=/.exec(line);
      if (vm) start = vm[0].length;
    }
    let closer = '';
    // a bare `@` (no name yet) is a parse error for the whole file: blank it (same length, no offset shift);
    // the lowering puts a completion slot there instead
    if (dm) {
      const line2 = line.replace(/(^|[\s(,])@(?=[^A-Za-z]|$)/g, (_m0, pre) => `${pre} `);
      if (line2 !== line) {
        line = line2;
        blanked.push(origOff + line.length);
      }
    }
    if (start >= 0) {
      const st = scan(line, start, { stack: [], quote: null });
      if (st.stack.length || st.quote) {
        const j = closesLater(li, st, !!dm);
        if (j >= 0) skipTo = j;
        else closer = (st.quote ?? '') + [...st.stack].reverse().join('');
      }
    }
    out += line;
    if (closer) {
      inserts.push({
        at: out.length, len: closer.length, origAt: origOff + line.length, closer, line: li + 1,
      });
    }
    out += closer;
    if (li < lines.length - 1) out += '\n';
    origOff += line.length + 1;
  }

  const toLf = (o: number) => {
    let shift = 0;
    for (const ins of inserts) {
      if (o <= ins.at) break;
      if (o < ins.at + ins.len) return ins.at - shift; // inside inserted text: clamp to the insertion point
      shift += ins.len;
    }
    return o - shift;
  };
  // LF offset -> original offset: one extra char for every CRLF newline before it; never past the end
  const toOrig = (o: number) => {
    const lf = toLf(o);
    let lo = 0;
    let hi = crlfAt.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (crlfAt[mid] < lf) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(original.length, lf + lo);
  };
  return {
    text: out, inserts, toOrig, blanked,
  };
}

/**
 * load(repaired) -> { parseOk, ... }. Tries the repaired buffer, then the buffer as typed if repairing made it
 * unparseable.
 */
export async function loadRepaired<R extends { parseOk: boolean }>(
  content: string,
  load: (repaired: Repaired) => Promise<R>,
): Promise<R & { repaired: Repaired }> {
  const repaired = repairContent(content);
  const r = await load(repaired);
  if (r.parseOk || (!repaired.inserts.length && !repaired.blanked.length)) return { ...r, repaired };
  // e.g. closing `[redis` gave `[redis)` style breakage
  const raw = repairContent(content, { closers: false });
  const r2 = await load(raw);
  return r2.parseOk ? { ...r2, repaired: raw } : { ...r, repaired };
}

/** DotEnvFileDataSource treats overrideContents '' as "not given" and reads the file from disk instead */
export const overrideText = (t: string) => (t === '' ? '\n' : t);
