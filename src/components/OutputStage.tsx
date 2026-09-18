import { useEffect, useMemo, useRef, useState } from 'react';
import type { PatchOp } from '../merge/rfc6902';
import type { JsonValue } from '../merge/types';
import type { CompiledSchema } from '../merge/schema';
import { validateMerged } from '../merge/schema';
import type { MergeResult, Resolutions } from '../merge/threeWayMerge';
import { buildPointerLines, resolveLine } from '../merge/jsonLineMap';
import { buildDecisionTrace } from '../merge/decisionTrace';
import { checkProtectedPaths, type ProtectedRule } from '../merge/protectedPaths';
import { downloadText } from '../download';
import SchemaPanel from './SchemaPanel';
import ValidationIssues from './ValidationIssues';
import PatchAuditPanel from './PatchAuditPanel';
import DecisionTracePanel from './DecisionTracePanel';
import ProtectedPathsPanel from './ProtectedPathsPanel';

interface Props {
  base: JsonValue;
  merged: JsonValue;
  patch: PatchOp[];
  /** 合并树与冲突解决结果：决策溯源据此还原每一路径的基线 / 两侧值与来源类别 */
  mergeResult: MergeResult;
  resolutions: Resolutions;
  schemaEnabled: boolean;
  schema: CompiledSchema | null;
  onSchemaEnabledChange: (v: boolean) => void;
  onSchemaChange: (s: CompiledSchema | null) => void;
  /** 受保护路径规则（App 级状态，返回调整时保留，重新开始时清空） */
  protectedRules: ProtectedRule[];
  onProtectedRulesChange: (rules: ProtectedRule[]) => void;
  onBack: () => void;
  onRestart: () => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 带行号的 JSON 结果视图，支持按行高亮并滚动定位 */
function JsonResultView({
  text,
  highlightLine,
  lineRef,
}: {
  text: string;
  highlightLine: number | null;
  lineRef: React.MutableRefObject<(HTMLDivElement | null)[]>;
}) {
  const lines = useMemo(() => text.split('\n'), [text]);
  return (
    <div className="json-lines">
      {lines.map((line, i) => (
        <div
          key={i}
          ref={(el) => {
            lineRef.current[i] = el;
          }}
          className={`json-line${i === highlightLine ? ' hit' : ''}`}
        >
          <span className="ln">{i + 1}</span>
          <span className="code">{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}

export default function OutputStage({
  base,
  merged,
  patch,
  mergeResult,
  resolutions,
  schemaEnabled,
  schema,
  onSchemaEnabledChange,
  onSchemaChange,
  protectedRules,
  onProtectedRulesChange,
  onBack,
  onRestart,
}: Props) {
  const [toast, setToast] = useState<string | null>(null);
  const [hitLine, setHitLine] = useState<number | null>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);

  const mergedText = JSON.stringify(merged, null, 2);
  const patchText = JSON.stringify(patch, null, 2);

  const groups = useMemo(
    () => (schemaEnabled && schema ? validateMerged(schema, merged) : []),
    [schemaEnabled, schema, merged],
  );
  const errorCount = groups.reduce((n, g) => n + g.issues.length, 0);

  // 受保护路径检查：以决策溯源的最终变更为输入，命中项按变更路径合并
  const traceEntries = useMemo(
    () => buildDecisionTrace(mergeResult, resolutions, merged),
    [mergeResult, resolutions, merged],
  );
  const protectedHits = useMemo(
    () => checkProtectedPaths(protectedRules, traceEntries),
    [protectedRules, traceEntries],
  );
  const [confirmedPaths, setConfirmedPaths] = useState<ReadonlySet<string>>(() => new Set());

  // 命中集合变化（应用新规则，或返回调整后重新生成结果）时清空确认，需重新逐项确认
  useEffect(() => {
    setConfirmedPaths(new Set());
  }, [protectedHits]);

  const toggleConfirm = (pointer: string) => {
    setConfirmedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(pointer)) next.delete(pointer);
      else next.add(pointer);
      return next;
    });
  };

  const protectedPending = protectedHits.filter((h) => !confirmedPaths.has(h.pointer)).length;
  const downloadsBlocked = protectedPending > 0;

  // JSON Pointer → 渲染行号
  const pointerLines = useMemo(() => buildPointerLines(mergedText), [mergedText]);

  // Schema 变化或重新生成结果后清除旧高亮
  useEffect(() => {
    setHitLine(null);
  }, [schema, merged]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  const handleCopy = async (text: string, label: string) => {
    showToast((await copyText(text)) ? `${label}已复制到剪贴板` : '复制失败，请手动选择复制');
  };

  const handleLocate = (instancePath: string) => {
    const ln = resolveLine(pointerLines, instancePath);
    if (ln === null) return;
    setHitLine(ln);
    lineRefs.current[ln]?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  };

  const showValidation = schemaEnabled && schema !== null;

  return (
    <>
      <SchemaPanel
        enabled={schemaEnabled}
        schema={schema}
        onEnabledChange={onSchemaEnabledChange}
        onSchemaChange={onSchemaChange}
      />
      {showValidation && <ValidationIssues groups={groups} onLocate={handleLocate} />}
      <div className="output-grid">
        <div className="output-panel">
          <h3>合并结果 JSON</h3>
          <JsonResultView text={mergedText} highlightLine={hitLine} lineRef={lineRefs} />
          <div className="panel-actions">
            <button className="small" onClick={() => void handleCopy(mergedText, '合并结果 ')}>
              复制
            </button>
            <button
              className="small"
              disabled={downloadsBlocked}
              title={downloadsBlocked ? '受保护路径命中未全部确认，暂不可下载' : undefined}
              onClick={() => downloadText('merged.json', mergedText)}
            >
              下载 merged.json
            </button>
            {showValidation && errorCount > 0 && (
              <span
                className="download-warn"
                title="合并结果未通过 Schema 校验，仍可下载；点击错误路径可定位"
              >
                ⚠ {errorCount} 个校验错误
              </span>
            )}
            {downloadsBlocked && (
              <span
                className="download-warn"
                title="受保护路径检查存在未确认的命中项，全部确认后可下载"
              >
                ⚠ {protectedPending} 项受保护命中待确认
              </span>
            )}
          </div>
        </div>
        <div className="output-panel">
          <h3>RFC 6902 补丁（基线 → 合并结果）</h3>
          <pre>{patchText}</pre>
          <div className="panel-actions">
            <button className="small" onClick={() => void handleCopy(patchText, '补丁 ')}>
              复制
            </button>
            <button
              className="small"
              disabled={downloadsBlocked}
              title={downloadsBlocked ? '受保护路径命中未全部确认，暂不可下载' : undefined}
              onClick={() => downloadText('patch.json', patchText)}
            >
              下载 patch.json
            </button>
            {downloadsBlocked && (
              <span
                className="download-warn"
                title="受保护路径检查存在未确认的命中项，全部确认后可下载"
              >
                ⚠ {protectedPending} 项受保护命中待确认
              </span>
            )}
          </div>
        </div>
      </div>
      <ProtectedPathsPanel
        rules={protectedRules}
        hits={protectedHits}
        confirmed={confirmedPaths}
        onToggleConfirm={toggleConfirm}
        onRulesChange={onProtectedRulesChange}
      />
      <PatchAuditPanel base={base} merged={merged} autoPatch={patch} onCopy={handleCopy} />
      <DecisionTracePanel mergeResult={mergeResult} resolutions={resolutions} merged={merged} />
      <div className="output-actions">
        <button onClick={onBack}>← 返回继续调整</button>
        <button onClick={onRestart}>重新开始</button>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
