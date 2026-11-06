const test = require('node:test');
const assert = require('node:assert');
const LogFilter = require('../media/logcat/filter.js');

const entry = (o) => ({ tag: 'MyTag', pkg: 'com.example.app', lv: 'E', lvn: 6, lines: ['Something failed'], rx: Date.now(), ...o });
const run = (src, e, ctx = {}) => LogFilter.compile(src, () => ({ mine: [], ...ctx })).test(e);

test('free text matches tag, package and message, case-insensitively', () => {
  assert.ok(run('something', entry()));
  assert.ok(!run('absent', entry()));
});

test('level: is a minimum, level=: is exact', () => {
  assert.ok(run('level:warn', entry({ lv: 'E', lvn: 6 })));
  assert.ok(!run('level:error', entry({ lv: 'W', lvn: 5 })));
  assert.ok(!run('level=:warn', entry({ lv: 'E', lvn: 6 })));
});

test('package and tag keys, negation and combination', () => {
  assert.ok(run('package:com.example level:error', entry()));
  assert.ok(!run('-tag:MyTag', entry()));
  assert.ok(run('tag:Other | tag:MyTag', entry()));
});

test('match case option', () => {
  assert.ok(run('message:something', entry()));
  assert.ok(!run('message:something', entry(), { matchCase: true }));
});

test('invalid level is reported as an error', () => {
  assert.ok(LogFilter.compile('level:nope', () => ({ mine: [] })).error);
});
