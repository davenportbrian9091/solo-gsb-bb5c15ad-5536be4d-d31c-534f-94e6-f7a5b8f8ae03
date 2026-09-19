import { useMemo, useRef, useState } from 'react';
import type { CueHit, Hit, PreviewResult } from '../types';
import { SafetyPanel } from './SafetyPanel';

interface Props {
  preview: PreviewResult | null;
  loading: boolean;
  onToggleHit: (key: string) => void;
  onClearException: (key: string) => void;
  onRevertAll: () => void;
  onApplyAll: () => void;
}

/** 将 cue 纯文本按命中切分为片段 */
function segments(cue: CueHit): { text: string; hit?: Hit }[] {
  const out: { text: string; hit?: Hit }[] = [];
  let pos = 0;
  const sorted = [...cue.hits].sort((a, b) => a.start - b.start);
  for (const h of sorted) {
    if (h.start > pos) out.push({ text: cue.text.slice(pos, h.start) });
    out.push({ text: cue.text.slice(h.start, h.end + 1), hit: h });
    pos = h.end + 1;
  }
  if (pos < cue.text.length) out.push({ text: cue.text.slice(pos) });
  return out;
}

function CueCard({
  cue,
  flash,
  onToggleHit,
  onClearException,
}: {
  cue: CueHit;
  flash: boolean;
  onToggleHit: (k: string) => void;
  onClearException: (k: string) => void;
}) {
  const segs = useMemo(() => segments(cue), [cue]);
  return (
    <article id={`cue-card-${cue.index}`} className={`cue-card ${flash ? 'cue-flash' : ''}`}>
      <div className="cue-time mono">
        {cue.start}
        {' --> '}
        {cue.end}
      </div>
      <div className="cue-text">
        {segs.map((s, i) =>
          s.hit ? (
            <span
              key={i}
              className={`hit ${s.hit.reverted ? 'hit-reverted' : 'hit-applied'} ${
                s.hit.alias !== undefined ? 'hit-alias' : ''
              }`}
              title={
                s.hit.alias !== undefined
                  ? `${s.hit.ruleName}（稳定化名，优先级 ${s.hit.priority}）\n原文：${s.hit.match}\n实体键：${s.hit.entityKey}\n化名：${s.hit.alias}`
                  : `${s.hit.ruleName}（优先级 ${s.hit.priority}）\n原文：${s.hit.match}\n替换：${s.hit.replacement}\n实体键：${s.hit.entityKey}`
              }
            >
              <span className="hit-label">{s.hit.ruleName}</span>
              {s.hit.decisionSource === 'entity' && (
                <span
                  className="hit-src hit-src-entity"
                  title="继承实体决定（可在左侧「实体决策」面板调整）"
                >
                  实体
                </span>
              )}
              {s.hit.decisionSource === 'exception' && (
                <span
                  className="hit-src hit-src-exception"
                  title="逐条例外：显式覆盖实体决定"
                >
                  例外
                </span>
              )}
              {s.hit.reverted ? (
                <span className="hit-original">{s.text}</span>
              ) : (
                <span className="hit-replacement">{s.hit.replacement}</span>
              )}
              <button
                className="hit-toggle"
                onClick={() => onToggleHit(s.hit!.key)}
                title={
                  s.hit.reverted
                    ? '应用此替换（写入逐条例外）'
                    : '撤销此替换，恢复原文（写入逐条例外）'
                }
              >
                {s.hit.reverted ? '↩ 应用' : '↶ 撤销'}
              </button>
              {s.hit.decisionSource === 'exception' && (
                <button
                  className="hit-toggle hit-inherit"
                  onClick={() => onClearException(s.hit!.key)}
                  title="清除此命中的例外，恢复继承实体决定（或默认应用）"
                >
                  ⟲ 继承
                </button>
              )}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </div>
      {cue.suppressed.length > 0 && (
        <div className="suppressed">
          重叠抑制：
          {cue.suppressed.map((s, i) => (
            <span key={i} className="suppressed-chip" title={`原文：${s.match}`}>
              「{s.match}」被 {s.ruleName} 命中，已按优先级并入 {s.winnerRuleName}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export function Preview({
  preview,
  loading,
  onToggleHit,
  onClearException,
  onRevertAll,
  onApplyAll,
}: Props) {
  const [onlyMatched, setOnlyMatched] = useState(false);
  /** 残留防线「定位」闪烁的 cue 序号 */
  const [flashCue, setFlashCue] = useState<number | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cues = useMemo(() => {
    if (!preview) return [];
    return onlyMatched ? preview.cues.filter((c) => c.hits.length > 0) : preview.cues;
  }, [preview, onlyMatched]);

  /** 定位到指定 cue：滚动到卡片并短暂闪烁 */
  const locateCue = (cueIndex: number) => {
    // 问题所在 cue 必有命中，不会被「仅看命中」过滤；此处仍兜底展开
    setOnlyMatched(false);
    setFlashCue(cueIndex);
    requestAnimationFrame(() => {
      document
        .getElementById(`cue-card-${cueIndex}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(
      () => setFlashCue((cur) => (cur === cueIndex ? null : cur)),
      1800,
    );
  };

  return (
    <section className="panel panel-grow">
      <header className="panel-header">
        <h2>③ 替换预览与逐条撤销</h2>
        <div className="panel-actions">
          <label className="filter-check">
            <input
              type="checkbox"
              checked={onlyMatched}
              onChange={(e) => setOnlyMatched(e.target.checked)}
            />
            仅看命中
          </label>
          <button className="btn btn-ghost" onClick={onApplyAll} disabled={!preview}>
            全部应用
          </button>
          <button className="btn btn-ghost" onClick={onRevertAll} disabled={!preview}>
            全部撤销
          </button>
        </div>
      </header>

      {loading && <div className="status">正在计算预览…</div>}

      {preview?.parseErrors.map((e, i) => (
        <div key={i} className="banner">
          ⚠ {e}
        </div>
      ))}

      {preview && (
        <div className="stat-bar">
          <span>字幕 {preview.cueCount} 条</span>
          <span className="stat-applied">将脱敏 {preview.appliedHits}</span>
          <span className="stat-reverted">已保留 {preview.revertedHits}</span>
          <span className="stat-suppressed">重叠抑制 {preview.suppressedHits}</span>
          {preview.exceptionHits > 0 && (
            <span className="stat-exception">逐条例外 {preview.exceptionHits}</span>
          )}
          {preview.safety.blocked ? (
            <span className="stat-safety-blocked">
              残留阻断 {preview.safety.artifact + preview.safety.crossBoundary}
            </span>
          ) : preview.safety.kept > 0 ? (
            <span className="stat-safety-kept">残留提示 {preview.safety.kept}</span>
          ) : (
            <span className="stat-safety-ok">残留检查通过</span>
          )}
        </div>
      )}

      {preview && <SafetyPanel safety={preview.safety} onLocate={locateCue} />}

      <div className="cue-list">
        {preview && cues.length === 0 && <div className="empty-tip">没有可显示的字幕。</div>}
        {cues.map((c) => (
          <CueCard
            key={c.index}
            cue={c}
            flash={flashCue === c.index}
            onToggleHit={onToggleHit}
            onClearException={onClearException}
          />
        ))}
      </div>
    </section>
  );
}
