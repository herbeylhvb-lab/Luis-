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

// === isNicknameOf() ===
const { isNicknameOf } = require('../utils');

eq('Bob is nickname of Robert', isNicknameOf('Bob', 'Robert'), true);
eq('Robert is nickname of Bob (reverse)', isNicknameOf('Robert', 'Bob'), true);
eq('case-insensitive', isNicknameOf('bob', 'ROBERT'), true);
eq('Liz is nickname of Elizabeth', isNicknameOf('Liz', 'Elizabeth'), true);
eq('Lupe is nickname of Guadalupe', isNicknameOf('Lupe', 'Guadalupe'), true);
eq('not a nickname', isNicknameOf('Bob', 'William'), false);
eq('same name not a nickname', isNicknameOf('Robert', 'Robert'), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
