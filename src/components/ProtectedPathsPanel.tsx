import { useState } from 'react';
import {
  parseProtectedRules,
  ProtectedRuleError,
  type ProtectedHit,
  type ProtectedRule,
} from '../merge/protectedPaths';
import { SOURCE_LABEL, type ChangeKind } from '../merge/decisionTrace';

interface Props {
  /** 当前生效的保护规则（OutputStage 据此计算命中）；非法配置不会更新它 */
  rules: ProtectedRule[];
  /** 以决策溯源最终变更为输入算出的命中项（已按变更路径合并） */
  hits: ProtectedHit[];
  /** 已逐项确认的变更路径 */
  confirmed: ReadonlySet<string>;
  onToggleConfirm: (pointer: string) => void;
  onRulesChange: (rules: ProtectedRule[]) => void;
}

const CHANGE_LABEL: Record<ChangeKind, string> = {
  add: '新增',
  remove: '删除',
  replace: '修改',
};

/**
 * 输出阶段的「受保护路径检查」面板：逐行配置 RFC 6901 路径模式，
 * 列出命中受保护范围的最终变更（规则 / 变更路径 / 类型 / 来源），逐项确认。
 */
export default function ProtectedPathsPanel({
  rules,
  hits,
  confirmed,
  onToggleConfirm,
  onRulesChange,
}: Props) {
  const [text, setText] = useState(() => rules.map((r) => r.pattern).join('\n'));
  const [error, setError] = useState<string | null>(null);

  const appliedText = rules.map((r) => r.pattern).join('\n');
  const dirty = text !== appliedText;

  const apply = () => {
    try {
      const next = parseProtectedRules(text);
      onRulesChange(next);
      setError(null);
    } catch (err) {
      // 配置非法：就地提示，不更新当前生效的规则
      if (err instanceof ProtectedRuleError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    }
  };

  const clear = () => {
    setText('');
    setError(null);
    onRulesChange([]);
  };

  const confirmedCount = hits.filter((h) => confirmed.has(h.pointer)).length;
  const allConfirmed = hits.length > 0 && confirmedCount === hits.length;

  return (
    <section className="protected-panel">
      <div className="protected-header">
        <h3>受保护路径检查</h3>
        <span className="hint">
          逐行配置 RFC 6901 路径模式（整段 <code>*</code> 匹配一段、<code>**</code>{' '}
          匹配零或多段）；最终变更命中受保护路径时需逐项确认，全部确认前禁止下载
        </span>
      </div>
      <textarea
        className="protected-input"
        placeholder={'每行一条路径模式，如：\n/secrets/**\n/config/database'}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <div className="error-text">{error}</div>}
      <div className="panel-actions">
        <button
          type="button"
          className="small primary"
          onClick={apply}
          disabled={!dirty && !error}
          title={dirty ? '应用当前规则并重新检查' : '规则已是最新'}
        >
          应用规则
        </button>
        <button
          type="button"
          className="small"
          onClick={clear}
          disabled={text === '' && rules.length === 0}
        >
          清空
        </button>
        {rules.length > 0 && !error && (
          <span className="protected-status">已生效 {rules.length} 条规则</span>
        )}
        {error && <span className="protected-status bad">配置非法，沿用上一份有效规则</span>}
        {dirty && !error && <span className="protected-dirty">规则已修改，应用后重新检查</span>}
      </div>
      {rules.length > 0 &&
        (hits.length === 0 ? (
          <div className="protected-summary ok">✅ 本次变更未命中任何受保护路径</div>
        ) : (
          <>
            <div className={`protected-summary ${allConfirmed ? 'ok' : 'pending'}`}>
              {allConfirmed
                ? `✅ ${hits.length} 项命中已全部确认，可下载结果`
                : `⚠ 命中 ${hits.length} 项受保护变更，已确认 ${confirmedCount}/${hits.length}；全部确认后才能下载 merged.json / patch.json`}
            </div>
            <ul className="protected-hit-list">
              {hits.map((hit) => (
                <li
                  key={hit.pointer}
                  className={`protected-hit${confirmed.has(hit.pointer) ? ' confirmed' : ''}`}
                >
                  <label className="protected-hit-main">
                    <input
                      type="checkbox"
                      checked={confirmed.has(hit.pointer)}
                      onChange={() => onToggleConfirm(hit.pointer)}
                    />
                    <span className={`trace-change ${hit.change}`}>
                      {CHANGE_LABEL[hit.change]}
                    </span>
                    <span className="protected-hit-path">
                      {hit.pointer === '' ? '（根）' : hit.pointer}
                    </span>
                    <span className={`trace-source ${hit.source}`}>
                      {SOURCE_LABEL[hit.source]}
                    </span>
                  </label>
                  <div className="protected-hit-rules">
                    命中规则：
                    {hit.rules.map((r) => (
                      <code key={r.index} title={`规则 #${r.index}`}>
                        #{r.index} {r.pattern}
                      </code>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ))}
    </section>
  );
}
