import * as assert from 'assert';
import { formatRanges, parseQuery, validateParams, validatePath, validateSha } from '../../src/validator';

const base = { repo: 'my-app', left: 'fcaac3532', right: 'f756bcd28', path: 'app/web/utils/hooks.ts' };
const entries = (o: Record<string, string>) => Object.entries(o) as Array<[string, string]>;

function rejects(o: Record<string, string>, param: string) {
  const r = validateParams(entries(o));
  assert.strictEqual(r.ok, false, `expected rejection for ${JSON.stringify(o)}`);
  if (!r.ok) assert.strictEqual(r.param, param);
}

describe('validator', () => {
  it('accepts a valid link', () => {
    const r = validateParams(entries({ ...base, line: '80' }));
    assert.deepStrictEqual(r, { ok: true, params: { ...base, line: 80 } });
  });

  it('line is optional', () => {
    const r = validateParams(entries(base));
    assert.ok(r.ok && r.params.line === undefined);
  });

  describe('sha', () => {
    for (const ok of ['abcdef0', 'a'.repeat(40), '0123456789abcdef']) {
      it(`accepts ${ok.length}-char ${ok.slice(0, 8)}`, () => assert.strictEqual(validateSha(ok), undefined));
    }
    const bad: Record<string, string> = {
      '6 chars': 'abcdef',
      '41 chars': 'a'.repeat(41),
      uppercase: 'ABCDEF0',
      'mixed case': 'abcDef0',
      'branch name': 'develop',
      'branch with slash': 'feature/x',
      'HEAD': 'HEAD',
      'ref expression': 'abcdef0~1',
      'leading dash': '-abcdef0',
      'shell metachar': 'abcdef0;rm',
      empty: '',
    };
    for (const [name, value] of Object.entries(bad)) {
      it(`rejects ${name}`, () => {
        rejects({ ...base, left: value }, 'left');
        rejects({ ...base, right: value }, 'right');
      });
    }
  });

  describe('path', () => {
    for (const ok of ['a.ts', 'app/web/utils/hooks.ts', 'pages/[id].tsx', 'app/(auth)/page.tsx', 'with space.md', 'a:b.txt', '.github/ci.yml', '%41.txt']) {
      it(`accepts ${ok}`, () => assert.strictEqual(validatePath(ok), undefined));
    }
    const bad: Record<string, string> = {
      '..': '../etc/passwd',
      'inner ..': 'a/../../b',
      'trailing ..': 'a/..',
      '.': './a',
      absolute: '/etc/passwd',
      'windows drive': 'C:/x',
      backslash: 'a\\b',
      NUL: 'a\u0000b',
      newline: 'a\nb',
      'double slash': 'a//b',
      'trailing slash': 'a/',
      empty: '',
      dollar: '$(id)',
      backtick: '`id`',
      semicolon: 'a;b',
      pipe: 'a|b',
      redirect: 'a>b',
      quote: "a'b",
    };
    for (const [name, value] of Object.entries(bad)) {
      it(`rejects ${name}`, () => rejects({ ...base, path: value }, 'path'));
    }
  });

  describe('repo', () => {
    it('rejects a path', () => rejects({ ...base, repo: 'a/b' }, 'repo'));
    it('rejects ..', () => rejects({ ...base, repo: '..' }, 'repo'));
    it('rejects metachar', () => rejects({ ...base, repo: 'x;y' }, 'repo'));
    it('rejects empty', () => rejects({ ...base, repo: '' }, 'repo'));
  });

  describe('line', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '01', '', '1e3', '99999999999']) {
      it(`rejects ${JSON.stringify(bad)}`, () => rejects({ ...base, line: bad }, 'line'));
    }
  });

  it('reports the first missing parameter', () => {
    for (const p of ['repo', 'left', 'right', 'path']) {
      const o: Record<string, string> = { ...base };
      delete o[p];
      rejects(o, p);
    }
  });

  it('rejects duplicated parameters', () => {
    const r = validateParams([...entries(base), ['left', 'abcdef0']]);
    assert.ok(!r.ok && r.param === 'left' && /more than once/.test(r.reason));
  });

  it('ignores unknown parameters', () => {
    assert.ok(validateParams([...entries(base), ['utm', 'x']]).ok);
  });

  it('error reasons never include the value', () => {
    const r = validateParams(entries({ ...base, path: '../secret' }));
    assert.ok(!r.ok && !r.reason.includes('secret'));
  });

  describe('parseQuery', () => {
    it('splits on & and the first =', () => {
      assert.deepStrictEqual(parseQuery('a=1&b=x=y&&c'), [['a', '1'], ['b', 'x=y'], ['c', '']]);
    });
    it('does not decode again', () => {
      assert.deepStrictEqual(parseQuery('path=%41+b'), [['path', '%41+b']]);
    });
  });
});

describe('[v1.1] lines', () => {
  const ok = (lines: string) => {
    const r = validateParams(entries({ ...base, lines }));
    assert.ok(r.ok, lines);
    return r.ok ? r.params.ranges : undefined;
  };
  it('single line and ranges', () => {
    assert.deepStrictEqual(ok('25'), [[25, 25]]);
    assert.deepStrictEqual(ok('25-30,120-160'), [[25, 30], [120, 160]]);
  });
  it('sorts and merges overlapping and adjacent ranges', () => {
    assert.deepStrictEqual(ok('120-160,25-30,28-40,41'), [[25, 41], [120, 160]]);
  });
  it('omitted lines → no ranges', () => {
    const r = validateParams(entries(base));
    assert.ok(r.ok && r.params.ranges === undefined);
  });
  it('can be combined with line', () => {
    const r = validateParams(entries({ ...base, line: '3', lines: '1-5' }));
    assert.ok(r.ok && r.params.line === 3 && r.params.ranges?.length === 1);
  });
  for (const bad of ['', '0', '0-3', '5-3', '1, 2', '1,,2', '1,', ',1', '1-', '-1', 'a-b', '1-2-3', '1;2', Array.from({ length: 51 }, (_, i) => `${i + 1}`).join(',')]) {
    it(`rejects ${JSON.stringify(bad.length > 20 ? '51 ranges' : bad)}`, () => rejects({ ...base, lines: bad }, 'lines'));
  }
  it('formatRanges', () => {
    assert.strictEqual(formatRanges([[25, 30], [120, 120]]), '25-30, 120');
    assert.strictEqual(formatRanges([[25, 30], [120, 120]], ','), '25-30,120');
  });
});
