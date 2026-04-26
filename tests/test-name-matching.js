#!/usr/bin/env node
const { levenshtein } = require('../utils');
let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${actual}, expected ${expected}`);
  ok ? passed++ : failed++;
}

eq('identical strings', levenshtein('smith', 'smith'), 0);
eq('one substitution', levenshtein('smith', 'smyth'), 1);
eq('insertion', levenshtein('smith', 'smiths'), 1);
eq('deletion', levenshtein('smiths', 'smith'), 1);
eq('case-insensitive', levenshtein('Smith', 'smith'), 0);
eq('empty vs filled', levenshtein('', 'smith'), 5);
eq('totally different', levenshtein('bob', 'robert'), 4);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
