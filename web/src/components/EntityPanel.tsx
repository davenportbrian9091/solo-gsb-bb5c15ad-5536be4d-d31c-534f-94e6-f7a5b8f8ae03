import { useMemo, useState } from 'react';
import type { EntityDecisionAction, EntitySummary } from '../types';

interface Props {
  entities: EntitySummary[];
  onDecide: (ruleId: string, entityKey: string, action: EntityDecisionAction | null) => void;
  onClearExceptions: (ruleId: string, entityKey: string) => void;
}

type Filter = 'all' | 'pending' | 'apply' | 'keep' | 'exception';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待定' },
  { key: 'apply', label: '始终应用' },
  { key: 'keep', label: '始终保留' },
  { key: 'exception', label: '有例外' },
];

/**
 * 实体决策列表：按「规则 + NFKC 归一实体」一次设为始终应用 / 始终保留。
 * 决定持久化，同实体新命中自动继承；逐条例外优先于决定，可在此清除。
 */
export function EntityPanel({ entities, onDecide, onClearExceptions }: Props) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(
    () => ({
      all: entities.length,
      pending: entities.filter((e) => !e.decision).length,
      apply: entities.filter((e) => e.decision === 'apply').length,
      keep: entities.filter((e) => e.decision === 'keep').length,
      exception: entities.filter((e) => e.exceptionHits > 0).length,
    }),
    [entities],
  );

  const rows = useMemo(
    () =>
      entities.filter((e) => {
        switch (filter) {
          case 'pending':
            return !e.decision;
          case 'apply':
            return e.decision === 'apply';
          case 'keep':
            return e.decision === 'keep';
          case 'exception':
            return e.exceptionHits > 0;
          default:
            return true;
        }
      }),
    [entities, filter],
  );

  if (entities.length === 0) return null;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>实体决策（{entities.length}）</h2>
        <button className="btn btn-mini btn-ghost" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
        </button>
      </header>
      <p className="hint">
        按「规则 + NFKC 归一实体」一次决定：<b>始终应用</b>替换或<b>始终保留</b>原文。
        决定持久化，同实体的新命中（含全角 / 半角写法）自动继承；逐条撤销 / 应用为例外，
        优先于实体决定，可清除例外恢复继承。被重叠抑制的命中不受决定影响。
      </p>
      {open && (
        <>
          <div className="entity-filters">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={`entity-filter ${filter === f.key ? 'active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="entity-filter-count">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <ul className="entity-list">
            {rows.length === 0 && <li className="empty-tip">该筛选下暂无实体。</li>}
            {rows.map((e) => (
              <li
                key={`${e.ruleId} ${e.entityKey}`}
                className={`entity-item ${e.decision ? `entity-${e.decision}` : ''}`}
              >
                <div className="entity-main">
                  <span
                    className="entity-rule"
                    title={e.ruleName ? `规则：${e.ruleName}` : '规则已删除'}
                  >
                    {e.ruleName || '已删除规则'}
                  </span>
                  <span className="entity-key" title={`实体键：${e.entityKey}`}>
                    {e.sourceText && e.sourceText !== e.entityKey
                      ? `${e.sourceText}（${e.entityKey}）`
                      : e.entityKey}
                  </span>
                  <span className="entity-stats">
                    命中 {e.totalHits}
                    {e.totalHits > 0 && (
                      <>
                        （应用 {e.appliedHits} · 保留 {e.revertedHits}）
                      </>
                    )}
                    {e.exceptionHits > 0 && (
                      <em className="entity-ex-tag">例外 {e.exceptionHits}</em>
                    )}
                  </span>
                </div>
                <div className="entity-actions">
                  <div className="decision-switch" role="group" aria-label="实体决定">
                    <button
                      className={e.decision === null ? 'active' : ''}
                      title="不做实体级决定（默认应用，可被逐条撤销）"
                      onClick={() => onDecide(e.ruleId, e.entityKey, null)}
                    >
                      待定
                    </button>
                    <button
                      className={e.decision === 'apply' ? 'active' : ''}
                      title="该实体所有命中始终应用替换（含未来新命中）"
                      onClick={() => onDecide(e.ruleId, e.entityKey, 'apply')}
                    >
                      始终应用
                    </button>
                    <button
                      className={e.decision === 'keep' ? 'active' : ''}
                      title="该实体所有命中始终保留原文（含未来新命中）"
                      onClick={() => onDecide(e.ruleId, e.entityKey, 'keep')}
                    >
                      始终保留
                    </button>
                  </div>
                  {e.exceptionHits > 0 && (
                    <button
                      className="btn btn-mini"
                      title="清除该实体全部逐条例外，恢复继承实体决定"
                      onClick={() => onClearExceptions(e.ruleId, e.entityKey)}
                    >
                      清除例外（{e.exceptionHits}）
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
