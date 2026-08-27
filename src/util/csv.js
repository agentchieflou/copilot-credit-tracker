/**
 * A small RFC4180 reader, for pulling in a usage report someone exported from
 * GitHub (or from whatever they were tracking with before). Writing CSV is
 * easy; reading someone else's is the part that needs to be forgiving, so this
 * copes with quoted fields, embedded newlines, CRLF, a BOM, and the semicolon
 * or tab delimiters a spreadsheet may have saved instead of commas.
 */

/** Guess the delimiter from the header line rather than making the user say. */
export function detectDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  const best = counts.sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

export function parseCsv(text, delimiter = null) {
  const src = String(text).replace(/^\uFEFF/, '');
  const delim = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let dirty = false; // distinguishes a real empty last field from a trailing newline

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      dirty = true;
    } else if (ch === delim) {
      row.push(field);
      field = '';
      dirty = true;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      dirty = false;
    } else if (ch !== '\r') {
      field += ch;
      dirty = true;
    }
  }
  if (dirty || field.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '');
}

/** Header keys are matched loosely, so "Net Amount", "netAmount" and "net_amount" agree. */
export function normalizeHeader(h) {
  return String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Rows as objects keyed by normalized header. */
export function parseCsvRecords(text, delimiter = null) {
  const rows = parseCsv(text, delimiter);
  if (!rows.length) return [];
  const head = rows[0].map(normalizeHeader);
  return rows.slice(1).map((cells) => {
    const rec = {};
    head.forEach((key, i) => {
      if (key) rec[key] = cells[i] ?? '';
    });
    return rec;
  });
}
