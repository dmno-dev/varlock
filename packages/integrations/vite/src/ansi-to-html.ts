const ANSI_COLORS: Record<number, string> = {
  30: '#45475a',
  31: '#f38ba8',
  32: '#a6e3a1',
  33: '#f9e2af',
  34: '#89b4fa',
  35: '#f5c2e7',
  36: '#94e2d5',
  37: '#cdd6f4',
  90: '#585b70',
  91: '#f38ba8',
  92: '#a6e3a1',
  93: '#f9e2af',
  94: '#89b4fa',
  95: '#f5c2e7',
  96: '#94e2d5',
  97: '#cdd6f4',
};


const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, 'g');

/**
 * Convert a string with ANSI escape codes to HTML with inline styles.
 * Uses a "close all, re-open with active styles" approach so that
 * nested/overlapping ANSI sequences render correctly.
 */
export function ansiToHtml(str: string): string {
  // track active style state
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  let strikethrough = false;
  let color: string | undefined;
  let isOpen = false;

  function buildSpan(): string {
    const styles: Array<string> = [];
    if (bold) styles.push('font-weight:bold');
    if (dim) styles.push('opacity:0.6');
    if (italic) styles.push('font-style:italic');
    if (underline) styles.push('text-decoration:underline');
    if (strikethrough) styles.push('text-decoration:line-through');
    if (color) styles.push(`color:${color}`);
    if (!styles.length) return '';
    isOpen = true;
    return `<span style="${styles.join(';')}">`;
  }

  function closeIfOpen(): string {
    if (!isOpen) return '';
    isOpen = false;
    return '</span>';
  }

  let html = str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  html = html.replace(ANSI_RE, (_, codes: string) => {
    const parts = codes.split(';').filter(Boolean).map(Number);

    // full reset
    if (parts.length === 0 || parts.includes(0)) {
      bold = false;
      dim = false;
      italic = false;
      underline = false;
      strikethrough = false;
      color = undefined;
      return closeIfOpen();
    }

    // close current span, update state, re-open
    const close = closeIfOpen();
    for (const code of parts) {
      if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 3) italic = true;
      else if (code === 4) underline = true;
      else if (code === 9) strikethrough = true;
      else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 23) italic = false;
      else if (code === 24) underline = false;
      else if (code === 29) strikethrough = false;
      else if (code === 39) color = undefined;
      else if (ANSI_COLORS[code]) color = ANSI_COLORS[code];
    }
    return close + buildSpan();
  });

  html += closeIfOpen();
  return html;
}
