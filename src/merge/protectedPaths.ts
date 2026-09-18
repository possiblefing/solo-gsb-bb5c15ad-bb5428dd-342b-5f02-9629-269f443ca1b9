import { compilePattern, matchSegments, type PatternSegment } from './batchRules';
import type { ChangeKind, TraceEntry, TraceSource } from './decisionTrace';

/**
 * 输出阶段的「受保护路径检查」：用户逐行配置 RFC 6901 路径模式（语法与批量决策规则一致，
 * 整段 * 匹配一段、整段 ** 匹配零或多段），以决策溯源的最终变更清单为输入，
 * 找出落入受保护范围的变更，要求逐项确认后才允许下载结果。
 *
 * 命中判定（规则 R 与变更 C）：
 * 1. 受保护路径是变更路径本身或其祖先 —— 子路径变更命中受保护父路径
 *    （模式匹配变更路径的任一前缀，含完整路径与根）；
 * 2. 变更为整体替换 / 删除，且受保护路径位于被替换 / 删除的子树内 ——
 *    父路径整体替换或删除命中其任一后代保护规则（变更路径匹配模式的任一真前缀；
 *    根节点整体替换因此命中全部规则）。
 * 新增（add）整体子树不触发第 2 条：受保护路径在基线中本就不存在。
 */

/** 一条受保护路径规则（模式 + 编译结果） */
export interface ProtectedRule {
  /** 配置文本中一行的 JSON Pointer 模式（已去首尾空白） */
  pattern: string;
  /** 编译后的模式段 */
  segments: PatternSegment[];
}

/** 配置文本含非法模式时抛出（消息带行号，聚合全部非法行） */
export class ProtectedRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectedRuleError';
  }
}

/**
 * 逐行解析配置文本为规则列表；空行忽略。
 * 任一行非法即整体抛出（不在调用方产生部分规则），由编辑区就地报错并保留上一份有效规则。
 */
export function parseProtectedRules(text: string): ProtectedRule[] {
  const rules: ProtectedRule[] = [];
  const errors: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const pattern = raw.trim();
    if (pattern === '') return;
    try {
      rules.push({ pattern, segments: compilePattern(pattern) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`第 ${i + 1} 行：${message}`);
    }
  });
  if (errors.length > 0) throw new ProtectedRuleError(errors.join('；'));
  return rules;
}

/** 判断一条决策溯源变更是否命中某条保护规则（segments 为编译后的模式段） */
export function ruleHitsEntry(
  pattern: PatternSegment[],
  entry: Pick<TraceEntry, 'segments' | 'change'>,
): boolean {
  const target = entry.segments;
  // 1. 受保护路径为变更路径本身或其祖先：模式匹配变更路径的任一前缀
  for (let i = 0; i <= target.length; i++) {
    if (matchSegments(pattern, target.slice(0, i))) return true;
  }
  // 2. 父路径整体替换 / 删除：受保护路径在变更子树内（变更路径匹配模式的任一真前缀）
  if (entry.change === 'replace' || entry.change === 'remove') {
    for (let j = 0; j < pattern.length; j++) {
      if (matchSegments(pattern.slice(0, j), target)) return true;
    }
  }
  return false;
}

/** 一条命中项：按变更路径合并展示（同一路径命中多条规则时并列为一条） */
export interface ProtectedHit {
  /** 变更路径（RFC 6901 JSON Pointer，根为 ''） */
  pointer: string;
  /** 变更类型 */
  change: ChangeKind;
  /** 决策来源 */
  source: TraceSource;
  /** 命中该变更的规则（按配置顺序，序号为规则在有效规则列表中的位次，自 1 起） */
  rules: { index: number; pattern: string }[];
}

/**
 * 以决策溯源的最终变更清单为输入，计算受保护路径命中项。
 * 每个变更路径至多产生一条命中项（多条规则命中时合并到 rules 字段），
 * 顺序与溯源清单一致。
 */
export function checkProtectedPaths(rules: ProtectedRule[], entries: TraceEntry[]): ProtectedHit[] {
  const hits: ProtectedHit[] = [];
  for (const entry of entries) {
    const matched: ProtectedHit['rules'] = [];
    rules.forEach((rule, i) => {
      if (ruleHitsEntry(rule.segments, entry)) {
        matched.push({ index: i + 1, pattern: rule.pattern });
      }
    });
    if (matched.length > 0) {
      hits.push({
        pointer: entry.pointer,
        change: entry.change,
        source: entry.source,
        rules: matched,
      });
    }
  }
  return hits;
}
