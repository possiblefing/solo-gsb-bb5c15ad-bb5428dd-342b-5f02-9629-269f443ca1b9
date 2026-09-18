import { describe, expect, it } from 'vitest';
import {
  checkProtectedPaths,
  parseProtectedRules,
  ProtectedRuleError,
  ruleHitsEntry,
  type ProtectedRule,
} from './protectedPaths';
import { buildDecisionTrace, type TraceEntry } from './decisionTrace';
import { buildMerged, threeWayMerge, type Resolutions } from './threeWayMerge';
import { ABSENT, type JsonValue } from './types';

function rules(...patterns: string[]): ProtectedRule[] {
  return parseProtectedRules(patterns.join('\n'));
}

/** 构造最小溯源条目（仅命中判定所需的字段） */
function entry(segments: string[], change: TraceEntry['change']): TraceEntry {
  return {
    pointer: segments.length === 0 ? '' : '/' + segments.join('/'),
    segments,
    source: 'ours-only',
    change,
    base: ABSENT,
    ours: ABSENT,
    theirs: ABSENT,
    final: ABSENT,
  };
}

describe('parseProtectedRules', () => {
  it('逐行解析，忽略空行与首尾空白', () => {
    const parsed = parseProtectedRules('  /a/b \n\n/secrets/*\n   \n/c/**');
    expect(parsed.map((r) => r.pattern)).toEqual(['/a/b', '/secrets/*', '/c/**']);
    expect(parsed[0].segments).toEqual([
      { type: 'literal', value: 'a' },
      { type: 'literal', value: 'b' },
    ]);
  });

  it('空配置得到空规则列表', () => {
    expect(parseProtectedRules('')).toEqual([]);
    expect(parseProtectedRules('\n  \n')).toEqual([]);
  });

  it('非法行抛出并带行号，聚合全部非法行', () => {
    try {
      parseProtectedRules('/ok\nno-slash\n/a~2b');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProtectedRuleError);
      const message = (err as Error).message;
      expect(message).toContain('第 2 行');
      expect(message).toContain('必须以 / 开头');
      expect(message).toContain('第 3 行');
      expect(message).toContain('非法 RFC 6901 转义');
    }
  });

  it('含非法行时整体失败，不产出部分规则（原子性）', () => {
    expect(() => parseProtectedRules('/valid\nbad')).toThrow(ProtectedRuleError);
  });
});

describe('ruleHitsEntry', () => {
  it('精确路径命中；无关路径不命中', () => {
    const [rule] = rules('/a/b');
    expect(ruleHitsEntry(rule.segments, entry(['a', 'b'], 'replace'))).toBe(true);
    expect(ruleHitsEntry(rule.segments, entry(['a', 'c'], 'replace'))).toBe(false);
    // 父路径新增不命中（整体替换 / 删除才命中后代规则，见专门用例）
    expect(ruleHitsEntry(rule.segments, entry(['a'], 'add'))).toBe(false);
  });

  it('子路径变更命中受保护父路径（新增 / 删除 / 修改均命中）', () => {
    const [rule] = rules('/a');
    expect(ruleHitsEntry(rule.segments, entry(['a', 'b'], 'add'))).toBe(true);
    expect(ruleHitsEntry(rule.segments, entry(['a', 'b'], 'remove'))).toBe(true);
    expect(ruleHitsEntry(rule.segments, entry(['a', 'b', 'c'], 'replace'))).toBe(true);
  });

  it('父路径整体替换 / 删除命中后代保护规则', () => {
    const [rule] = rules('/a/b/c');
    expect(ruleHitsEntry(rule.segments, entry(['a'], 'replace'))).toBe(true);
    expect(ruleHitsEntry(rule.segments, entry(['a', 'b'], 'remove'))).toBe(true);
  });

  it('父路径新增不命中后代保护规则（受保护路径在基线中本不存在）', () => {
    const [rule] = rules('/a/b/c');
    expect(ruleHitsEntry(rule.segments, entry(['a'], 'add'))).toBe(false);
  });

  it('兄弟路径不互相命中', () => {
    const [rule] = rules('/a/b');
    expect(ruleHitsEntry(rule.segments, entry(['a', 'c'], 'replace'))).toBe(false);
    expect(ruleHitsEntry(rule.segments, entry(['a', 'c'], 'remove'))).toBe(false);
  });

  it('* 与 ** 通配：受保护父路径含通配段时子路径变更同样命中', () => {
    const [star] = rules('/services/*');
    expect(ruleHitsEntry(star.segments, entry(['services', 'api'], 'replace'))).toBe(true);
    expect(ruleHitsEntry(star.segments, entry(['services', 'api', 'name'], 'replace'))).toBe(true);
    expect(ruleHitsEntry(star.segments, entry(['other', 'api'], 'replace'))).toBe(false);

    const [dstar] = rules('/config/**');
    expect(ruleHitsEntry(dstar.segments, entry(['config'], 'remove'))).toBe(true);
    expect(ruleHitsEntry(dstar.segments, entry(['config', 'db', 'host'], 'add'))).toBe(true);
  });

  it('含通配的后代规则：父路径整体替换命中模式真前缀覆盖的规则', () => {
    const [rule] = rules('/a/*/secret');
    expect(ruleHitsEntry(rule.segments, entry(['a'], 'replace'))).toBe(true);
    expect(ruleHitsEntry(rule.segments, entry(['a', 'b'], 'remove'))).toBe(true);
    expect(ruleHitsEntry(rule.segments, entry(['x'], 'replace'))).toBe(false);
  });

  it('根节点整体替换 / 删除命中全部规则', () => {
    const [rule] = rules('/any/thing');
    expect(ruleHitsEntry(rule.segments, entry([], 'replace'))).toBe(true);
    expect(ruleHitsEntry(rule.segments, entry([], 'remove'))).toBe(true);
  });

  it('/** 保护一切：任意路径变更均命中', () => {
    const [rule] = rules('/**');
    expect(ruleHitsEntry(rule.segments, entry(['a', 'b'], 'add'))).toBe(true);
    expect(ruleHitsEntry(rule.segments, entry([], 'replace'))).toBe(true);
  });

  it('RFC 6901 转义段按反转义值匹配', () => {
    const [rule] = rules('/a~1b');
    expect(ruleHitsEntry(rule.segments, entry(['a/b'], 'replace'))).toBe(true);
    expect(ruleHitsEntry(rule.segments, entry(['a/b', 'c'], 'add'))).toBe(true);
  });
});

describe('checkProtectedPaths', () => {
  it('命中项携带变更路径、类型、来源与规则序号；多条规则命中同一路径时合并为一条', () => {
    const entries: TraceEntry[] = [
      entry(['a', 'b'], 'replace'),
      entry(['c'], 'add'),
    ];
    const hits = checkProtectedPaths(rules('/a', '/a/b', '/x'), entries);
    expect(hits).toHaveLength(1);
    expect(hits[0].pointer).toBe('/a/b');
    expect(hits[0].change).toBe('replace');
    expect(hits[0].source).toBe('ours-only');
    expect(hits[0].rules).toEqual([
      { index: 1, pattern: '/a' },
      { index: 2, pattern: '/a/b' },
    ]);
  });

  it('无规则或无命中时返回空', () => {
    const entries: TraceEntry[] = [entry(['a'], 'replace')];
    expect(checkProtectedPaths([], entries)).toEqual([]);
    expect(checkProtectedPaths(rules('/zzz'), entries)).toEqual([]);
  });

  it('与真实三方合并集成：父对象整体替换命中后代保护规则，来源与类型取自决策溯源', () => {
    const base: JsonValue = { a: { x: 1, y: 2 }, keep: 1 };
    const ours: JsonValue = { a: { z: 9 }, keep: 1 };
    const merge = threeWayMerge(base, ours, base);
    const merged = buildMerged(merge.root, {} as Resolutions) as JsonValue;
    const trace = buildDecisionTrace(merge, {}, merged);
    // 父对象整体换成另一个对象：溯源只在 /a 记一条 replace
    expect(trace.map((t) => t.pointer)).toEqual(['/a']);

    const hits = checkProtectedPaths(rules('/a/x', '/keep'), trace);
    expect(hits).toHaveLength(1);
    expect(hits[0].pointer).toBe('/a');
    expect(hits[0].change).toBe('replace');
    expect(hits[0].rules.map((r) => r.pattern)).toEqual(['/a/x']);
  });

  it('与真实三方合并集成：删除父路径命中后代规则，子路径修改命中受保护父路径', () => {
    const base: JsonValue = { sec: { token: 't' }, cfg: { db: { host: 'h' } } };
    const ours: JsonValue = { cfg: { db: { host: 'h2' } } };
    const merge = threeWayMerge(base, ours, base);
    const merged = buildMerged(merge.root, {} as Resolutions) as JsonValue;
    const trace = buildDecisionTrace(merge, {}, merged);

    const hits = checkProtectedPaths(rules('/sec/token\n/cfg'), trace);
    // /sec 删除命中后代规则 /sec/token；/cfg/db/host 修改命中受保护父路径 /cfg
    expect(hits.map((h) => [h.pointer, h.change])).toEqual([
      ['/sec', 'remove'],
      ['/cfg/db/host', 'replace'],
    ]);
    expect(hits[0].rules.map((r) => r.index)).toEqual([1]);
    expect(hits[1].rules.map((r) => r.index)).toEqual([2]);
  });
});
