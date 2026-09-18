// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import OutputStage from './OutputStage';
import { threeWayMerge, type MergeResult } from '../merge/threeWayMerge';
import type { JsonValue } from '../merge/types';
import type { ProtectedRule } from '../merge/protectedPaths';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeRenderer(container: HTMLElement) {
  const root = createRoot(container);
  return (node: ReactElement) => act(() => root.render(node));
}

const h = (container: ParentNode, sel: string) => container.querySelector(sel);
const all = (container: ParentNode, sel: string) => [...container.querySelectorAll(sel)];
const btnByText = (container: HTMLElement, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
const checkboxes = (container: ParentNode) =>
  all(container, '.protected-hit input[type="checkbox"]') as HTMLInputElement[];

/** React 受控组件需要用原生 setter 赋值后再派发 input 事件 */
function typeInto(container: HTMLElement, v: string) {
  const ta = h(container, '.protected-input') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(ta, v);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 挂载 OutputStage：protectedRules 由测试持有（模拟 App 的状态提升），目标分支不动 */
function setup(base: JsonValue, ours: JsonValue) {
  const firstResult = threeWayMerge(base, ours, base);
  let rules: ProtectedRule[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const render = makeRenderer(container);
  const rerender = (merged: JsonValue = ours, mergeResult: MergeResult = firstResult) =>
    render(
      <OutputStage
        base={base}
        merged={merged}
        patch={[]}
        mergeResult={mergeResult}
        resolutions={{}}
        schemaEnabled={false}
        schema={null}
        onSchemaEnabledChange={() => {}}
        onSchemaChange={() => {}}
        protectedRules={rules}
        onProtectedRulesChange={(r) => {
          rules = r;
          rerender(merged, mergeResult);
        }}
        onBack={() => {}}
        onRestart={() => {}}
      />,
    );
  rerender();
  return { container, rerender, getRules: () => rules };
}

describe('OutputStage 受保护路径检查', () => {
  it('命中项列出规则、变更路径、类型与来源；逐项确认前禁用下载，全部确认后恢复', () => {
    const { container } = setup(
      { secret: { token: 'old' }, name: 'a' } as JsonValue,
      { secret: { token: 'new' }, name: 'b' } as JsonValue,
    );

    // 初始无规则：下载可用
    expect(btnByText(container, '下载 merged.json')!.disabled).toBe(false);
    expect(btnByText(container, '下载 patch.json')!.disabled).toBe(false);

    act(() => typeInto(container, '/secret\n/name'));
    act(() => btnByText(container, '应用规则')!.click());

    const hits = all(container, '.protected-hit');
    expect(hits).toHaveLength(2);
    // 子路径 /secret/token 变更命中受保护父路径 /secret
    expect(hits[0].querySelector('.protected-hit-path')?.textContent).toBe('/secret/token');
    expect(hits[0].querySelector('.trace-change')?.textContent).toBe('修改');
    expect(hits[0].querySelector('.trace-source')?.textContent).toContain('仅当前分支');
    expect(hits[0].querySelector('.protected-hit-rules')?.textContent).toContain('#1 /secret');
    expect(hits[1].querySelector('.protected-hit-path')?.textContent).toBe('/name');
    expect(hits[1].querySelector('.protected-hit-rules')?.textContent).toContain('#2 /name');

    // 未全部确认：两个下载按钮都禁用并给出警示
    expect(btnByText(container, '下载 merged.json')!.disabled).toBe(true);
    expect(btnByText(container, '下载 patch.json')!.disabled).toBe(true);
    expect(all(container, '.download-warn').length).toBeGreaterThan(0);
    expect(h(container, '.protected-summary')?.textContent).toContain('0/2');

    // 逐项确认：确认一项后仍禁用，全部确认后恢复
    act(() => checkboxes(container)[0].click());
    expect(btnByText(container, '下载 merged.json')!.disabled).toBe(true);
    expect(h(container, '.protected-summary')?.textContent).toContain('1/2');
    act(() => checkboxes(container)[1].click());
    expect(btnByText(container, '下载 merged.json')!.disabled).toBe(false);
    expect(btnByText(container, '下载 patch.json')!.disabled).toBe(false);
    expect(h(container, '.protected-summary')?.textContent).toContain('已全部确认');
  });

  it('父路径整体替换命中后代保护规则', () => {
    const { container } = setup(
      { a: { x: 1, y: 2 } } as JsonValue,
      { a: { z: 9 } } as JsonValue,
    );
    act(() => typeInto(container, '/a/x'));
    act(() => btnByText(container, '应用规则')!.click());

    const hits = all(container, '.protected-hit');
    expect(hits).toHaveLength(1);
    expect(hits[0].querySelector('.protected-hit-path')?.textContent).toBe('/a');
    expect(hits[0].querySelector('.trace-change')?.textContent).toBe('修改');
    expect(hits[0].querySelector('.protected-hit-rules')?.textContent).toContain('/a/x');
    expect(btnByText(container, '下载 merged.json')!.disabled).toBe(true);
  });

  it('多条规则命中同一变更路径时按变更路径合并为一条展示', () => {
    const { container } = setup(
      { secret: { token: 'old' } } as JsonValue,
      { secret: { token: 'new' } } as JsonValue,
    );
    act(() => typeInto(container, '/secret\n/secret/**'));
    act(() => btnByText(container, '应用规则')!.click());

    const hits = all(container, '.protected-hit');
    expect(hits).toHaveLength(1);
    const codes = all(hits[0], '.protected-hit-rules code').map((c) => c.textContent);
    expect(codes).toEqual(['#1 /secret', '#2 /secret/**']);
  });

  it('配置非法时就地提示且不更新有效规则', () => {
    const { container, getRules } = setup({ name: 'a' } as JsonValue, { name: 'b' } as JsonValue);
    act(() => typeInto(container, '/name'));
    act(() => btnByText(container, '应用规则')!.click());
    expect(all(container, '.protected-hit')).toHaveLength(1);
    expect(getRules()).toHaveLength(1);

    // 输入非法配置并应用：就地报错，上一份有效规则继续生效
    act(() => typeInto(container, 'no-slash'));
    act(() => btnByText(container, '应用规则')!.click());
    expect(h(container, '.error-text')?.textContent).toContain('第 1 行');
    expect(h(container, '.error-text')?.textContent).toContain('必须以 / 开头');
    expect(getRules()).toHaveLength(1);
    expect(getRules()[0].pattern).toBe('/name');
    expect(all(container, '.protected-hit')).toHaveLength(1);
    expect(h(container, '.protected-status.bad')?.textContent).toContain('沿用上一份');
  });

  it('返回调整并重新生成结果后清空确认，下载再次禁用', () => {
    const base = { name: 'a' } as JsonValue;
    const { container, rerender } = setup(base, { name: 'b' } as JsonValue);
    act(() => typeInto(container, '/name'));
    act(() => btnByText(container, '应用规则')!.click());
    act(() => checkboxes(container)[0].click());
    expect(btnByText(container, '下载 merged.json')!.disabled).toBe(false);

    // 模拟返回调整后重新生成结果（新的合并结果与 merged 文档）
    const ours2 = { name: 'c' } as JsonValue;
    rerender(ours2, threeWayMerge(base, ours2, base));
    expect(btnByText(container, '下载 merged.json')!.disabled).toBe(true);
    expect(btnByText(container, '下载 patch.json')!.disabled).toBe(true);
    expect(h(container, '.protected-summary')?.textContent).toContain('0/1');
  });

  it('规则未命中任何变更时显示通过，下载保持可用', () => {
    const { container } = setup({ name: 'a' } as JsonValue, { name: 'b' } as JsonValue);
    act(() => typeInto(container, '/other'));
    act(() => btnByText(container, '应用规则')!.click());

    expect(h(container, '.protected-summary.ok')?.textContent).toContain('未命中');
    expect(btnByText(container, '下载 merged.json')!.disabled).toBe(false);
    expect(btnByText(container, '下载 patch.json')!.disabled).toBe(false);
  });
});
