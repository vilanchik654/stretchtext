import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/core.js');

test('parseSegments keeps plain text intact', () => {
  const segs = C.parseSegments('The tower is tall.');
  assert.deepEqual(segs, [{ type: 'text', text: 'The tower is tall.' }]);
});

test('parseSegments finds phrases and their ids', () => {
  const segs = C.parseSegments('It was finished {{in 1889|1}} and stayed tallest {{until 1930|2}} for a while.');
  assert.deepEqual(segs, [
    { type: 'text', text: 'It was finished ' },
    { type: 'phrase', id: 1, label: 'in 1889' },
    { type: 'text', text: ' and stayed tallest ' },
    { type: 'phrase', id: 2, label: 'until 1930' },
    { type: 'text', text: ' for a while.' },
  ]);
});

test('parseSegments tolerates whitespace around the separator', () => {
  const segs = C.parseSegments('a {{  the fair  |  7  }} b');
  assert.deepEqual(segs[1], { type: 'phrase', id: 7, label: 'the fair' });
});

test('parseSegments shows the label of a half-streamed marker without offering a click', () => {
  const segs = C.parseSegments('It was finished {{in 18');
  assert.deepEqual(segs, [
    { type: 'text', text: 'It was finished in 18' },
    { type: 'pending' },
  ]);
});

test('parseSegments hides the id of a half-streamed marker', () => {
  const segs = C.parseSegments('x {{fair|2');
  assert.deepEqual(segs, [
    { type: 'text', text: 'x fair' },
    { type: 'pending' },
  ]);
});

test('parseSegments rejects malformed markers by rendering them as text', () => {
  assert.deepEqual(C.parseSegments('a {{nope}} b'), [
    { type: 'text', text: 'a nope b' },
  ]);
  assert.deepEqual(C.parseSegments('a {{label|abc}} b'), [
    { type: 'text', text: 'a label b' },
  ]);
  assert.deepEqual(C.parseSegments('a {{|3}} b'), [{ type: 'text', text: 'a  b' }]);
  assert.deepEqual(C.parseSegments('a {{x|0}} b'), [{ type: 'text', text: 'a x b' }]);
  assert.deepEqual(C.parseSegments('a {{x|100}} b'), [{ type: 'text', text: 'a x b' }]);
});

test('parseSegments keeps only the first use of an id', () => {
  const segs = C.parseSegments('{{one|1}} and {{two|1}} and {{three|2}}');
  const phrases = segs.filter((s) => s.type === 'phrase');
  assert.deepEqual(phrases.map((p) => [p.id, p.label]), [[1, 'one'], [2, 'three']]);
  assert.ok(segs.some((s) => s.type === 'text' && s.text.includes('two')));
});

test('parseSegments does not choke on a stray closing brace', () => {
  assert.deepEqual(C.parseSegments('a }} b'), [{ type: 'text', text: 'a }} b' }]);
});

test('stripMarkers removes the markup and keeps the prose', () => {
  assert.equal(C.stripMarkers('It was finished {{in 1889|1}} in June.'), 'It was finished in 1889 in June.');
  assert.equal(C.stripMarkers('no markers here'), 'no markers here');
  assert.equal(C.stripMarkers('open {{tail'), 'open tail');
});

test('countWords counts latin and cyrillic words', () => {
  assert.equal(C.countWords('one two three'), 3);
  assert.equal(C.countWords('один два три четыре'), 4);
  assert.equal(C.countWords('   '), 0);
  assert.equal(C.countWords("don't stop"), 2);
});

test('cleanModelText unwraps fences, labels and quotes', () => {
  assert.equal(C.cleanModelText('  hello  '), 'hello');
  assert.equal(C.cleanModelText('```text\nhello\n```'), 'hello');
  assert.equal(C.cleanModelText('Short version: hello there'), 'hello there');
  assert.equal(C.cleanModelText('"hello"'), 'hello');
  assert.equal(C.cleanModelText('«привет»'), 'привет');
  assert.equal(C.cleanModelText('**bold**'), 'bold');
  assert.equal(C.cleanModelText(''), '');
});

test('normalizeDetail makes an insertion grammatical', () => {
  assert.equal(C.normalizeDetail(', which took nine years'), ', which took nine years');
  assert.equal(C.normalizeDetail('which took nine years'), ', which took nine years');
  assert.equal(C.normalizeDetail('— a gift from France'), ' — a gift from France');
  assert.equal(C.normalizeDetail('... and more'), ', and more');
  assert.equal(C.normalizeDetail(''), '');
});

test('splitLongText respects the limit and keeps whole sentences', () => {
  const sentence = 'This is a sentence that is reasonably long. ';
  const text = sentence.repeat(20).trim();
  const chunks = C.splitLongText(text, 200);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 200, 'chunk too long: ' + chunk.length);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
  assert.deepEqual(C.splitLongText('short', 200), ['short']);
  assert.deepEqual(C.splitLongText('', 200), []);
});

test('splitLongText hard-splits a single huge sentence', () => {
  const chunks = C.splitLongText('x'.repeat(450), 200);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join('').length, 450);
});

test('compress prompt carries the passage, the target and the marker rules', () => {
  const text = 'The Eiffel Tower was completed in 1889. '.repeat(10);
  const messages = C.buildCompressMessages({ text, ratio: 16, language: 'auto' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.ok(messages[1].content.includes(text.trim()));
  const words = C.countWords(text);
  const target = Math.max(10, Math.round((words * 16) / 100));
  assert.ok(messages[0].content.includes('near ' + target + ' words'), messages[0].content);
  assert.ok(messages[0].content.includes('{{the 1889 World Fair|1}}'));
  assert.ok(messages[0].content.includes('Write in the same language'));
});

test('compress prompt honours an explicit language and clamps the ratio', () => {
  const messages = C.buildCompressMessages({ text: 'hello world', ratio: 900, language: 'Russian' });
  assert.ok(messages[0].content.includes('Write in Russian.'));
  assert.ok(!messages[0].content.includes('near 900'));
});

test('detail prompt includes the phrase and both texts', () => {
  const messages = C.buildDetailMessages({
    original: 'Original passage text.',
    kernel: 'Short version.',
    phrase: 'in 1889',
    language: 'auto',
  });
  assert.ok(messages[1].content.includes('Original passage text.'));
  assert.ok(messages[1].content.includes('Short version.'));
  assert.ok(messages[1].content.includes('"in 1889"'));
  assert.ok(messages[0].content.includes('insert immediately after that phrase'));
});

test('buildChatBody keeps the knobs it was given', () => {
  const body = C.buildChatBody({ model: 'm', messages: [], stream: true, maxTokens: 42, temperature: 0.1 });
  assert.deepEqual(body, { model: 'm', messages: [], temperature: 0.1, max_tokens: 42, stream: true });
  assert.equal(C.buildChatBody({ model: 'm', messages: [] }).stream, false);
});

test('parseSSE reads complete events and keeps the tail', () => {
  const buffer =
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":" wor';
  const { events, rest } = C.parseSSE(buffer);
  assert.deepEqual(events, [{ text: 'Hel' }, { text: 'lo' }]);
  assert.ok(rest.startsWith('data: {"choices":[{"delta":{"content":" wor'));
});

test('parseSSE handles [DONE], errors and junk', () => {
  const { events } = C.parseSSE(
    'data: [DONE]\n\n' +
      'data: {"error":{"message":"nope"}}\n\n' +
      'not json at all\n\n' +
      'data: {"choices":[{"message":{"content":"final"}}]}\n\n'
  );
  assert.deepEqual(events, [{ done: true }, { error: 'nope' }, { text: 'final' }]);
});

test('parseSSE tolerates CRLF chunk boundaries', () => {
  const { events, rest } = C.parseSSE('data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\ndata: {"cho');
  assert.deepEqual(events, [{ text: 'a' }]);
  assert.equal(rest, 'data: {"cho');
});

test('extractText copes with delta, message and text shapes', () => {
  assert.equal(C.extractText({ choices: [{ delta: { content: 'd' } }] }), 'd');
  assert.equal(C.extractText({ choices: [{ message: { content: 'm' } }] }), 'm');
  assert.equal(C.extractText({ text: 't' }), 't');
  assert.equal(C.extractText({}), '');
  assert.equal(C.extractText(null), '');
});

test('errorMessage unwraps the Pollinations error body', () => {
  const body = JSON.stringify({
    success: false,
    error: { message: 'A valid API key is required.', code: 'UNAUTHORIZED' },
  });
  assert.equal(C.errorMessage(body, 401), 'A valid API key is required.');
  assert.equal(C.errorMessage('plain text', 500), 'plain text');
  assert.equal(C.errorMessage('', 502), 'Request failed with HTTP 502');
});

test('cacheKey is stable and order sensitive', () => {
  assert.equal(C.cacheKey(['a', 'b']), C.cacheKey(['a', 'b']));
  assert.notEqual(C.cacheKey(['a', 'b']), C.cacheKey(['b', 'a']));
  assert.match(C.cacheKey(['a']), /^[0-9a-z]+$/);
});

