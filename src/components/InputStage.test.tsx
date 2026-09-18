// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import InputStage from './InputStage';
import type { JsonValue } from '../merge/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const all = (container: HTMLElement, sel: string) => [...container.querySelectorAll(sel)];
const btnByText = (container: HTMLElement, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
const panels = (container: HTMLElement) => all(container, '.input-panel') as HTMLElement[];
const textareaOf = (panel: HTMLElement) => panel.querySelector('textarea')!;

/** React 受控组件需要用原生 setter 赋值后再派发事件 */
function typeInto(textarea: HTMLTextAreaElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, v);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

interface MergeCall {
  base: JsonValue;
  ours: JsonValue;
  theirs: JsonValue;
}

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const merges: MergeCall[] = [];
  const render = (node: ReactElement) => act(() => root.render(node));
  render(
    <InputStage
      onMerge={(base, ours, theirs) => merges.push({ base, ours, theirs })}
      onImportSnapshot={() => {}}
    />,
  );
  return { container, merges };
}

/** 依次在三个面板中输入内容 */
function fillPanels(container: HTMLElement, values: [string, string, string]) {
  const ps = panels(container);
  act(() => {
    values.forEach((v, i) => typeInto(textareaOf(ps[i]), v));
  });
}

const BASE = '{ "a": 1, "list": [1, 2] }';
const OURS_PATCH = `[
  { "op": "test", "path": "/a", "value": 1 },
  { "op": "replace", "path": "/a", "value": 10 },
  { "op": "add", "path": "/list/-", "value": 3 }
]`;
const THEIRS_PATCH = `[
  { "op": "copy", "from": "/a", "path": "/b" },
  { "op": "move", "from": "/list", "path": "/items" }
]`;

describe('InputStage 三份文档模式', () => {
  it('解析失败就地报错且不触发合并；成功后调用 onMerge', () => {
    const { container, merges } = setup();
    fillPanels(container, ['{bad', '{"x":1}', '{"x":2}']);
    act(() => btnByText(container, '开始合并')!.click());
    expect(merges).toHaveLength(0);
    expect(container.textContent).toContain('JSON 解析失败');

    fillPanels(container, ['{"x":0}', '{"x":1}', '{"x":2}']);
    act(() => btnByText(container, '开始合并')!.click());
    expect(merges).toEqual([{ base: { x: 0 }, ours: { x: 1 }, theirs: { x: 2 } }]);
  });
});

describe('InputStage RFC 6902 补丁模式', () => {
  const switchToPatch = (container: HTMLElement) =>
    act(() => btnByText(container, 'RFC 6902 补丁')!.click());

  it('两份补丁分别应用到同一基线副本后进入合并流程', () => {
    const { container, merges } = setup();
    switchToPatch(container);
    fillPanels(container, [BASE, OURS_PATCH, THEIRS_PATCH]);
    act(() => btnByText(container, '开始合并')!.click());

    expect(merges).toHaveLength(1);
    expect(merges[0].base).toEqual({ a: 1, list: [1, 2] });
    expect(merges[0].ours).toEqual({ a: 10, list: [1, 2, 3] });
    expect(merges[0].theirs).toEqual({ a: 1, b: 1, items: [1, 2] });
  });

  it('任一操作失败：阻止合并、标明失败侧/操作序号/原因，且输入保持不变', () => {
    const { container, merges } = setup();
    switchToPatch(container);
    // 当前分支补丁第 2 个操作 test 失败；目标分支补丁第 1 个操作路径不存在
    const badOurs = `[
      { "op": "replace", "path": "/a", "value": 10 },
      { "op": "test", "path": "/a", "value": 999 }
    ]`;
    const badTheirs = '[{ "op": "remove", "path": "/nope" }]';
    fillPanels(container, [BASE, badOurs, badTheirs]);
    act(() => btnByText(container, '开始合并')!.click());

    expect(merges).toHaveLength(0);
    const ps = panels(container);
    expect(ps[1].querySelector('.error-text')?.textContent).toContain('当前分支补丁第 2 个操作失败');
    expect(ps[1].querySelector('.error-text')?.textContent).toContain('test');
    expect(ps[2].querySelector('.error-text')?.textContent).toContain('目标分支补丁第 1 个操作失败');
    expect(ps[2].querySelector('.error-text')?.textContent).toContain('路径不存在');
    // 输入保持不变
    expect(textareaOf(ps[0]).value).toBe(BASE);
    expect(textareaOf(ps[1]).value).toBe(badOurs);
    expect(textareaOf(ps[2]).value).toBe(badTheirs);

    // 修正后可继续合并
    fillPanels(container, [BASE, OURS_PATCH, THEIRS_PATCH]);
    act(() => btnByText(container, '开始合并')!.click());
    expect(merges).toHaveLength(1);
  });

  it('补丁整体格式错误（非数组 / 非法操作）时标明原因', () => {
    const { container, merges } = setup();
    switchToPatch(container);
    fillPanels(container, [BASE, '{"op":"add"}', '[{"op":"delete","path":"/a"}]']);
    act(() => btnByText(container, '开始合并')!.click());

    expect(merges).toHaveLength(0);
    const ps = panels(container);
    expect(ps[1].querySelector('.error-text')?.textContent).toContain('当前分支补丁');
    expect(ps[1].querySelector('.error-text')?.textContent).toContain('数组');
    expect(ps[2].querySelector('.error-text')?.textContent).toContain('目标分支补丁第 1 个操作失败');
  });

  it('两种模式的输入互不影响，切换后各自保留', () => {
    const { container } = setup();
    fillPanels(container, ['{"x":0}', '{"x":1}', '{"x":2}']);
    switchToPatch(container);
    fillPanels(container, [BASE, OURS_PATCH, THEIRS_PATCH]);
    // 切回文档模式：原文档输入仍在
    act(() => btnByText(container, '三份文档')!.click());
    expect(textareaOf(panels(container)[0]).value).toBe('{"x":0}');
    // 再切回补丁模式：补丁输入仍在
    switchToPatch(container);
    expect(textareaOf(panels(container)[1]).value).toBe(OURS_PATCH);
  });
});
