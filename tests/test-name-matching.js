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
eq('case-insensitive (levenshtein)', levenshtein('Smith', 'smith'), 0);
eq('empty vs filled', levenshtein('', 'smith'), 5);
eq('totally different', levenshtein('bob', 'robert'), 4);

// === isNicknameOf() ===
const { isNicknameOf } = require('../utils');

eq('Bob is nickname of Robert', isNicknameOf('Bob', 'Robert'), true);
eq('Robert is nickname of Bob (reverse)', isNicknameOf('Robert', 'Bob'), true);
eq('case-insensitive (nickname)', isNicknameOf('bob', 'ROBERT'), true);
eq('Liz is nickname of Elizabeth', isNicknameOf('Liz', 'Elizabeth'), true);
eq('Lupe is nickname of Guadalupe', isNicknameOf('Lupe', 'Guadalupe'), true);
eq('not a nickname', isNicknameOf('Bob', 'William'), false);
eq('same name not a nickname', isNicknameOf('Robert', 'Robert'), false);

// === scoreCandidate() ===
const { scoreCandidate } = require('../utils');

function near(name, actual, expected, tol = 0.05) {
  const ok = Math.abs(actual - expected) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${actual.toFixed(3)}, expected ~${expected}`);
  ok ? passed++ : failed++;
}

near('exact match', scoreCandidate(
  { firstName: 'Robert', lastName: 'Smith', age: 57 },
  { first_name: 'Robert', last_name: 'Smith', age: 57 }
), 1.0);

near('nickname match', scoreCandidate(
  { firstName: 'Bob', lastName: 'Smith', age: 57 },
  { first_name: 'Robert', last_name: 'Smith', age: 57 }
), 1.0);

near('last name typo', scoreCandidate(
  { firstName: 'Robert', lastName: 'Smyth', age: 57 },
  { first_name: 'Robert', last_name: 'Smith', age: 57 }
), 0.9);

near('age off by 5', scoreCandidate(
  { firstName: 'Robert', lastName: 'Smith', age: 62 },
  { first_name: 'Robert', last_name: 'Smith', age: 57 }
), 0.9);

near('totally wrong', scoreCandidate(
  { firstName: 'Bob', lastName: 'Smith', age: 30 },
  { first_name: 'Maria', last_name: 'Lopez', age: 70 }
), 0.0, 0.2);

near('voter age missing', scoreCandidate(
  { firstName: 'Robert', lastName: 'Smith', age: 57 },
  { first_name: 'Robert', last_name: 'Smith', age: null }
), 1.0);

near('contact age missing', scoreCandidate(
  { firstName: 'Robert', lastName: 'Smith' },
  { first_name: 'Robert', last_name: 'Smith', age: 57 }
), 1.0);

near('both ages missing', scoreCandidate(
  { firstName: 'Robert', lastName: 'Smith' },
  { first_name: 'Robert', last_name: 'Smith' }
), 1.0);

near('voter age missing, last name typo', scoreCandidate(
  { firstName: 'Robert', lastName: 'Smyth', age: 57 },
  { first_name: 'Robert', last_name: 'Smith', age: null }
), 0.875);  // 0.625 * 0.8 + 0.375 * 1.0 = 0.5 + 0.375 = 0.875

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
