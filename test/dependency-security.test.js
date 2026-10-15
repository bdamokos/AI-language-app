import assert from 'node:assert/strict';
import test from 'node:test';
import shellQuote from 'shell-quote';
import sourceMap from 'source-map-js';

// A line terminator after a comment must never escape the quoted command.
test('shell quoting rejects command-breaking newlines after comment tokens', () => {
  for (const newline of ['\n', '\r', '\u2028', '\u2029']) {
    for (const between of [[], [{ op: ';' }]]) {
      assert.throws(() => shellQuote.quote(['echo', 'safe', { comment: 'note' }, ...between, `a${newline}printf SENTINEL;#`]), TypeError);
    }
  }
  const args = ['two words', "it's quoted", '$HOME', 'semi;colon', 'line\nbreak'];
  assert.deepEqual(shellQuote.parse(shellQuote.quote(args)), args);
});

const flatMap = { version: 3, sources: ['input.js'], names: [], mappings: 'AAAA', sourcesContent: ['x'] };
const indexedMap = (line, map = flatMap) => ({ version: 3, sections: [{ offset: { line, column: 0 }, map }] });

test('source maps reject oversized and malformed indexed offsets before expansion', () => {
  for (const line of [10000001, Infinity, NaN, 1.5, '2', -1]) {
    assert.throws(() => new sourceMap.SourceMapConsumer(indexedMap(line)));
  }
  assert.throws(() => new sourceMap.SourceMapConsumer(indexedMap(6000000, indexedMap(6000000))));
});

test('ordinary indexed source maps retain their mapping and generated code', () => {
  const consumer = new sourceMap.SourceMapConsumer(indexedMap(1));
  assert.deepEqual(consumer.originalPositionFor({ line: 2, column: 1 }), { source: 'input.js', line: 1, column: 0, name: null });
  assert.equal(sourceMap.SourceNode.fromStringWithSourceMap('\nx', consumer).toString(), '\nx');
});
