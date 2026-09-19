import { useMemo, useState } from 'react';
import type { AliasEntry, MaskRule } from '../types';

interface Props {
  rules: MaskRule[];
  aliases: AliasEntry[];
  onRename: (ruleId: string, entityKey: string, alias: string) => void;
  onReset: (ruleId: string, entityKey: string) => void;
}

/**
 * 稳定化名表：列出当前任务中所有已分配编号的实体（含暂时未命中的历史实体）。
 * 手动改名立即联动该实体所有未撤销命中；「恢复自动」交回 前缀+序号 生成。
 */
export function AliasPanel({ rules, aliases, onRename, onReset }: Props) {
  const [open, setOpen] = useState(true);
  const ruleName = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules]);

  // 仅展示属于化名规则（现存或已删除）的条目；按规则、编号排序
  const rows = useMemo(() => {
    return aliases
      .filter((a) => {
        const r = ruleName.get(a.ruleId);
        return !r || r.mode === 'alias';
      })
      .sort((a, b) =>
        a.ruleId === b.ruleId
          ? a.seq - b.seq
          : (ruleName.get(a.ruleId)?.name ?? a.ruleId).localeCompare(
              ruleName.get(b.ruleId)?.name ?? b.ruleId,
            ),
      );
  }, [aliases, ruleName]);

  if (rows.length === 0) return null;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>化名表（{rows.length}）</h2>
        <button className="btn btn-mini btn-ghost" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
        </button>
      </header>
      <p className="hint">
        编号按规则独立分配且不复用：增删其他字幕 / 命中不会重排已有编号。改名即时联动全部未撤销命中；
        撤销的命中仍恢复原文。
      </p>
      {open && (
        <ul className="alias-list">
          {rows.map((a) => {
            const r = ruleName.get(a.ruleId);
            return (
              <li
                key={`${a.ruleId} ${a.entityKey}`}
                className={`alias-item ${a.auto ? '' : 'alias-custom'}`}
              >
                <span className="alias-rule" title={r ? `规则：${r.name}` : '规则已删除'}>
                  {r?.name ?? '已删除规则'}
                </span>
                <span className="alias-seq mono">#{a.seq}</span>
                <span className="alias-entity" title={a.entityKey}>
                  {a.sourceText && a.sourceText !== a.entityKey
                    ? `${a.sourceText}（${a.entityKey}）`
                    : a.entityKey}
                </span>
                <span className="alias-arrow">→</span>
                <input
                  className="alias-input mono"
                  value={a.alias}
                  spellCheck={false}
                  onChange={(e) => onRename(a.ruleId, a.entityKey, e.target.value)}
                  title={a.auto ? '自动生成，可手动改名' : '手动改名'}
                />
                {!a.auto && (
                  <button
                    className="btn btn-mini"
                    onClick={() => onReset(a.ruleId, a.entityKey)}
                    title="恢复为 前缀+序号 自动化名"
                  >
                    恢复自动
                  </button>
                )}
                {!a.auto && <span className="alias-tag">已改名</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
