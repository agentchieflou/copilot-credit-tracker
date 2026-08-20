/** Terminal formatting with no dependencies and no hard requirement on a TTY. */

let colorEnabled = null;

export function configureColor(mode) {
  if (mode === 'always') colorEnabled = true;
  else if (mode === 'never') colorEnabled = false;
  else colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function paint(code, text) {
  if (colorEnabled === null) configureColor('auto');
  return colorEnabled ? `[${code}m${text}[0m` : String(text);
}

export const c = {
  bold: (t) => paint('1', t),
  dim: (t) => paint('2', t),
  red: (t) => paint('31', t),
  green: (t) => paint('32', t),
  yellow: (t) => paint('33', t),
  blue: (t) => paint('34', t),
  magenta: (t) => paint('35', t),
  cyan: (t) => paint('36', t),
  gray: (t) => paint('90', t),
};

const ASCII = process.env.CCRED_ASCII === '1';
const GLYPH = ASCII
  ? { full: '#', empty: '.', up: '^', down: 'v', flat: '=', dot: '*' }
  : { full: '█', empty: '░', up: '▲', down: '▼', flat: '•', dot: '·' };

/** Strip ANSI so padding math stays right when a cell is coloured. */
export function visibleLength(str) {
  return String(str).replace(/\[[0-9;]*m/g, '').length;
}

export function pad(str, width, align = 'left') {
  const s = String(str);
  const gap = Math.max(width - visibleLength(s), 0);
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + s + ' '.repeat(gap - left);
  }
  return s + ' '.repeat(gap);
}

export function bar(value, max, width = 24) {
  if (!Number.isFinite(max) || max <= 0) return GLYPH.empty.repeat(width);
  const ratio = Math.max(0, Math.min(value / max, 1));
  const filled = Math.round(ratio * width);
  return GLYPH.full.repeat(filled) + GLYPH.empty.repeat(width - filled);
}

/** A bar that keeps rendering past 100%, with the overflow marked in red. */
export function budgetBar(value, max, width = 30) {
  if (!Number.isFinite(max) || max <= 0) return c.dim(GLYPH.empty.repeat(width));
  const ratio = value / max;
  if (ratio <= 1) {
    const filled = Math.round(ratio * width);
    const color = ratio > 0.9 ? c.red : ratio > 0.75 ? c.yellow : c.green;
    return color(GLYPH.full.repeat(filled)) + c.dim(GLYPH.empty.repeat(width - filled));
  }
  return c.red(GLYPH.full.repeat(width)) + c.red(` +${fmtNum(value - max)}`);
}

export function fmtNum(n, maxDecimals = 2) {
  if (n === null || n === undefined) return '-';
  const num = Number(n);
  if (!Number.isFinite(num)) return '-';
  if (Number.isInteger(num)) return num.toLocaleString('en-US');
  return num.toLocaleString('en-US', { maximumFractionDigits: maxDecimals });
}

export function plural(n, singular, pluralForm = `${singular}s`) {
  return Number(n) === 1 ? singular : pluralForm;
}

export function fmtPct(ratio, decimals = 0) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return '-';
  return `${(Number(ratio) * 100).toFixed(decimals)}%`;
}

export function fmtTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(Math.round(num));
}

export function fmtDate(value, { withTime = false } = {}) {
  if (!value) return '-';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (!withTime) return date;
  return `${date} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
}

export function fmtDuration(minutes) {
  const m = Math.round(Number(minutes) || 0);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function delta(n, { good = 'down', decimals = 2, suffix = '' } = {}) {
  const num = Number(n) || 0;
  if (Math.abs(num) < 10 ** -decimals) return c.dim(`${GLYPH.flat} flat`);
  const rising = num > 0;
  const isGood = good === 'up' ? rising : !rising;
  const text = `${rising ? GLYPH.up : GLYPH.down} ${rising ? '+' : ''}${fmtNum(num, decimals)}${suffix}`;
  return isGood ? c.green(text) : c.red(text);
}

export function heading(text) {
  return `\n${c.bold(text)}\n${c.dim('-'.repeat(visibleLength(text)))}`;
}

export function kv(label, value, width = 18) {
  return `  ${c.dim(pad(`${label}`, width))} ${value}`;
}

/**
 * @param {Array<Array<string>>} rows
 * @param {{head?: string[], align?: Array<'left'|'right'|'center'>, indent?: string}} opts
 */
export function table(rows, { head = null, align = [], indent = '  ' } = {}) {
  const all = head ? [head, ...rows] : rows;
  if (!all.length) return '';
  const cols = Math.max(...all.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(...all.map((r) => visibleLength(r[i] ?? ''))),
  );
  const line = (row, dimRow = false) =>
    indent +
    row
      .map((cell, i) => pad(cell ?? '', widths[i], align[i] || 'left'))
      .join('  ')
      .trimEnd()
      .replace(/^/, dimRow ? '' : '');

  const out = [];
  if (head) {
    out.push(c.dim(line(head)));
    out.push(c.dim(indent + widths.map((w) => '-'.repeat(w)).join('  ')));
  }
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

export const glyph = GLYPH;
