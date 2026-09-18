import { useRef, useState } from 'react';
import JsonInputPanel from './JsonInputPanel';
import type { JsonValue } from '../merge/types';
import { parseSnapshot, type SessionSnapshot } from '../merge/snapshot';
import { applyJsonPatch, parseJsonPatch, type PatchFailure } from '../merge/jsonPatch';
import {
  SAMPLE_BASE,
  SAMPLE_OURS,
  SAMPLE_OURS_PATCH,
  SAMPLE_THEIRS,
  SAMPLE_THEIRS_PATCH,
} from '../sampleData';

interface Props {
  onMerge: (base: JsonValue, ours: JsonValue, theirs: JsonValue) => void;
  onImportSnapshot: (snapshot: SessionSnapshot) => void;
}

type Field = 'base' | 'ours' | 'theirs';
type Mode = 'documents' | 'patch';

const DOC_PANELS: { field: Field; title: string; hint: string }[] = [
  { field: 'base', title: '基线 (Base)', hint: '三方共同的祖先版本' },
  { field: 'ours', title: '当前分支 (Ours)', hint: '当前分支上的修改版本' },
  { field: 'theirs', title: '目标分支 (Theirs)', hint: '需要合入的目标分支版本' },
];

const PATCH_PANELS: { field: Field; title: string; hint: string }[] = [
  { field: 'base', title: '基线 (Base)', hint: '两份补丁将分别应用到同一基线的独立副本上' },
  {
    field: 'ours',
    title: '当前分支补丁 (Ours Patch)',
    hint: '基线 → 当前分支的 RFC 6902 JSON Patch（add / remove / replace / move / copy / test）',
  },
  {
    field: 'theirs',
    title: '目标分支补丁 (Theirs Patch)',
    hint: '基线 → 目标分支的 RFC 6902 JSON Patch（add / remove / replace / move / copy / test）',
  },
];

const SIDE_LABEL: Record<'ours' | 'theirs', string> = {
  ours: '当前分支补丁',
  theirs: '目标分支补丁',
};

const EMPTY_ERRORS: Record<Field, string | null> = { base: null, ours: null, theirs: null };

/** 失败信息格式：标明失败侧、操作序号（从 1 开始）与原因 */
function formatFailure(side: 'ours' | 'theirs', failure: PatchFailure): string {
  return failure.opIndex === null
    ? `${SIDE_LABEL[side]}：${failure.reason}`
    : `${SIDE_LABEL[side]}第 ${failure.opIndex} 个操作失败：${failure.reason}`;
}

export default function InputStage({ onMerge, onImportSnapshot }: Props) {
  const [mode, setMode] = useState<Mode>('documents');
  const [texts, setTexts] = useState<Record<Field, string>>({ base: '', ours: '', theirs: '' });
  const [errors, setErrors] = useState<Record<Field, string | null>>({ ...EMPTY_ERRORS });
  // 补丁模式使用独立的输入与错误状态，切换模式不丢失任何一侧的内容
  const [patchTexts, setPatchTexts] = useState<Record<Field, string>>({
    base: '',
    ours: '',
    theirs: '',
  });
  const [patchErrors, setPatchErrors] = useState<Record<Field, string | null>>({ ...EMPTY_ERRORS });
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const snapshotFileRef = useRef<HTMLInputElement>(null);

  const setText = (field: Field) => (v: string) => {
    setTexts((t) => ({ ...t, [field]: v }));
    setErrors((e) => ({ ...e, [field]: null }));
  };

  const setPatchText = (field: Field) => (v: string) => {
    setPatchTexts((t) => ({ ...t, [field]: v }));
    setPatchErrors((e) => ({ ...e, [field]: null }));
  };

  const handleStartDocuments = () => {
    const parsed: Partial<Record<Field, JsonValue>> = {};
    const newErrors: Record<Field, string | null> = { ...EMPTY_ERRORS };
    let ok = true;
    for (const { field } of DOC_PANELS) {
      try {
        parsed[field] = JSON.parse(texts[field]) as JsonValue;
      } catch (err) {
        newErrors[field] = err instanceof Error ? err.message : String(err);
        ok = false;
      }
    }
    setErrors(newErrors);
    if (ok) {
      setSnapshotError(null);
      onMerge(parsed.base!, parsed.ours!, parsed.theirs!);
    }
  };

  // 补丁模式：两份补丁分别应用到同一基线的独立副本；任一操作失败即阻止进入合并，输入保持不变
  const handleStartPatch = () => {
    const newErrors: Record<Field, string | null> = { ...EMPTY_ERRORS };

    let base: JsonValue | null = null;
    try {
      base = JSON.parse(patchTexts.base) as JsonValue;
    } catch (err) {
      newErrors.base = `基线 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`;
    }

    const docs: Partial<Record<'ours' | 'theirs', JsonValue>> = {};
    for (const side of ['ours', 'theirs'] as const) {
      const parsed = parseJsonPatch(patchTexts[side]);
      if (!parsed.ok) {
        newErrors[side] = formatFailure(side, parsed.failure);
        continue;
      }
      if (base === null) continue; // 基线无效时无法应用，仅展示补丁自身的解析错误
      const applied = applyJsonPatch(base, parsed.ops);
      if (!applied.ok) {
        newErrors[side] = formatFailure(side, applied.failure);
        continue;
      }
      docs[side] = applied.document;
    }

    setPatchErrors(newErrors);
    if (base !== null && docs.ours !== undefined && docs.theirs !== undefined) {
      setSnapshotError(null);
      onMerge(base, docs.ours, docs.theirs);
    }
  };

  const loadSample = () => {
    if (mode === 'documents') {
      setTexts({ base: SAMPLE_BASE, ours: SAMPLE_OURS, theirs: SAMPLE_THEIRS });
      setErrors({ ...EMPTY_ERRORS });
    } else {
      setPatchTexts({ base: SAMPLE_BASE, ours: SAMPLE_OURS_PATCH, theirs: SAMPLE_THEIRS_PATCH });
      setPatchErrors({ ...EMPTY_ERRORS });
    }
    setSnapshotError(null);
  };

  // 快照非法时仅提示错误，不影响当前输入内容
  const handleSnapshotFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const snapshot = parseSnapshot(await file.text());
      setSnapshotError(null);
      onImportSnapshot(snapshot);
    } catch (err) {
      setSnapshotError(err instanceof Error ? err.message : String(err));
    }
  };

  const panels = mode === 'documents' ? DOC_PANELS : PATCH_PANELS;
  const activeTexts = mode === 'documents' ? texts : patchTexts;
  const activeErrors = mode === 'documents' ? errors : patchErrors;
  const canStart = panels.every(({ field }) => activeTexts[field].trim());

  return (
    <>
      <div className="mode-tabs">
        <button
          className={mode === 'documents' ? 'active' : ''}
          onClick={() => setMode('documents')}
        >
          三份文档
        </button>
        <button className={mode === 'patch' ? 'active' : ''} onClick={() => setMode('patch')}>
          RFC 6902 补丁
        </button>
        <span className="mode-hint">
          {mode === 'documents'
            ? '直接粘贴基线、当前分支、目标分支三份完整 JSON'
            : '粘贴基线 JSON 与两份 JSON Patch，应用结果自动进入三方合并'}
        </span>
      </div>
      <div className="input-grid">
        {panels.map(({ field, title, hint }) => (
          <JsonInputPanel
            key={`${mode}-${field}`}
            title={title}
            hint={hint}
            value={activeTexts[field]}
            error={activeErrors[field]}
            onChange={mode === 'documents' ? setText(field) : setPatchText(field)}
            errorPrefix={mode === 'documents' ? undefined : ''}
          />
        ))}
      </div>
      <div className="input-actions">
        <button onClick={loadSample}>加载示例数据</button>
        <button onClick={() => snapshotFileRef.current?.click()}>导入会话快照</button>
        <input
          ref={snapshotFileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleSnapshotFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <div className="spacer" />
        <button
          className="primary"
          onClick={mode === 'documents' ? handleStartDocuments : handleStartPatch}
          disabled={!canStart}
        >
          开始合并 →
        </button>
      </div>
      {snapshotError && <div className="error-text snapshot-error">快照导入失败：{snapshotError}</div>}
    </>
  );
}
