import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseArgv, asNumber, asList } from '../src/util/args.js';
import { visibleLength, pad, budgetBar, configureColor } from '../src/util/fmt.js';
import { countWords, measurePrompt } from '../src/util/text.js';
import { monthsBetween, usagePath, isPremiumRequestItem } from '../src/commands/sync.js';

test('parseArgv handles the shapes the CLI actually uses', () => {
  const { flags, positionals } = parseArgv(
    ['log', 'opus', 'fix', 'the', 'thing', '--chars=1200', '--in', '400', '--solo', '--no-color'],
    { booleans: ['solo', 'color'] },
  );
  assert.deepEqual(positionals, ['log', 'opus', 'fix', 'the', 'thing']);
  assert.equal(flags.chars, '1200');
  assert.equal(flags.in, '400');
  assert.equal(flags.solo, true);
  assert.equal(flags.color, false);
});

test('parseArgv keeps negative numbers as values, not flags', () => {
  const { flags } = parseArgv(['--drift', '-5']);
  assert.equal(flags.drift, '-5');
});

test('parseArgv stops at a bare double dash', () => {
  const { flags, positionals } = parseArgv(['export', '--format', 'csv', '--', '--not-a-flag']);
  assert.equal(flags.format, 'csv');
  assert.deepEqual(positionals, ['export', '--not-a-flag']);
});

test('a flag with no value is a boolean', () => {
  const { flags } = parseArgv(['sync', '--dry-run'], { booleans: ['dry-run'] });
  assert.equal(flags['dry-run'], true);
});

test('asNumber and asList coerce safely', () => {
  assert.equal(asNumber('12'), 12);
  assert.equal(asNumber(true, 1), 1, 'a bare boolean flag is not a number');
  assert.equal(asNumber('abc', 7), 7);
  assert.deepEqual(asList('a,b , c'), ['a', 'b', 'c']);
  assert.deepEqual(asList(undefined), []);
});

test('padding accounts for ANSI colour codes', () => {
  configureColor('always');
  const colored = budgetBar(5, 10, 10);
  assert.ok(visibleLength(colored) >= 10);
  configureColor('never');
  assert.equal(pad('ab', 5).length, 5);
});

test('the budget bar overflows visibly past the allowance', () => {
  configureColor('never');
  const over = budgetBar(150, 100, 10);
  assert.match(over, /\+50/);
});

test('countWords ignores runs of whitespace', () => {
  assert.equal(countWords('  one   two\nthree '), 3);
  assert.equal(countWords('   '), 0);
});

test('measurePrompt reads a file and derives both dimensions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccred-text-'));
  const file = path.join(dir, 'prompt.md');
  fs.writeFileSync(file, 'refactor the parser to stream input');
  const measured = await measurePrompt({ file });
  assert.equal(measured.chars, 35);
  assert.equal(measured.words, 6);
  assert.equal(measured.source, 'file');
});

test('measurePrompt returns nulls when nothing was supplied', async () => {
  const measured = await measurePrompt({});
  assert.equal(measured.chars, null);
  assert.equal(measured.words, null);
});

test('explicit --chars wins over the measured text', async () => {
  const measured = await measurePrompt({ text: 'short', chars: '900' });
  assert.equal(measured.chars, 900);
  assert.equal(measured.words, 1);
});

test('monthsBetween covers a cycle that straddles two calendar months', () => {
  const months = monthsBetween(new Date(2026, 7, 14), new Date(2026, 8, 13));
  assert.deepEqual(months, [
    { year: 2026, month: 8 },
    { year: 2026, month: 9 },
  ]);
});

test('usagePath differs for personal, org and enterprise setups', () => {
  const base = { github: { scope: 'personal', username: 'octocat', org: null, enterprise: null } };
  assert.equal(usagePath(base), '/users/octocat/settings/billing/usage');
  assert.equal(
    usagePath({ github: { ...base.github, scope: 'organization', org: 'acme' } }),
    '/organizations/acme/settings/billing/usage',
  );
  assert.equal(
    usagePath({ github: { ...base.github, scope: 'enterprise', enterprise: 'acme-inc' } }),
    '/enterprises/acme-inc/settings/billing/usage',
  );
});

test('usagePath explains what is missing instead of building a broken URL', () => {
  assert.throws(
    () => usagePath({ github: { scope: 'enterprise', enterprise: null } }),
    /enterprise slug/,
  );
  assert.throws(() => usagePath({ github: { scope: 'personal', username: null } }), /username/);
});

test('only Copilot premium request line items count toward the reconciliation', () => {
  assert.ok(isPremiumRequestItem({ product: 'Copilot', sku: 'copilot_premium_requests' }));
  assert.ok(!isPremiumRequestItem({ product: 'Actions', sku: 'actions_linux' }));
  assert.ok(!isPremiumRequestItem({ product: 'Copilot', sku: 'copilot_business_seat' }));
});
