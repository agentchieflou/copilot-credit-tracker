import fs from 'node:fs';
import { asNumber, asString } from './args.js';

export function countWords(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Work out prompt length from whichever source the caller gave us:
 * explicit --chars/--words, inline --text, a --file, or piped stdin.
 * Returns { chars, words, source } with nulls when length is unknown, so
 * "not measured" never gets averaged in as a zero.
 */
export async function measurePrompt(flags) {
  const explicitChars = asNumber(flags.chars, null);
  const explicitWords = asNumber(flags.words, null);

  let text = asString(flags.text, null);
  let source = text ? 'text' : null;

  const file = asString(flags.file, null);
  if (!text && file) {
    text = fs.readFileSync(file, 'utf8');
    source = 'file';
  }

  if (!text && flags.stdin === true) {
    const piped = await readStdin();
    if (piped.trim()) {
      text = piped;
      source = 'stdin';
    }
  }

  if (text) {
    return {
      chars: explicitChars ?? text.length,
      words: explicitWords ?? countWords(text),
      source,
    };
  }

  if (explicitChars != null || explicitWords != null) {
    return { chars: explicitChars, words: explicitWords, source: 'explicit' };
  }

  return { chars: null, words: null, source: null };
}

export function truncate(str, max = 42) {
  const s = String(str ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
