import { useMemo, useRef, useState } from 'react';
import type { CueHit, Hit, HitSpan, PreviewResult } from '../types';
import { SafetyPanel } from './SafetyPanel';

interface Props {
  preview: PreviewResult | null;
  loading: boolean;
  onToggleHit: (key: string) => void;
  onClearException: (key: string) => void;
  onRevertAll: () => void;
  onApplyAll: () => void;
}

/** 命中在本 cue 内的覆盖区间（跨 cue 命中按 spans 定位本 cue 部分） */
function localSpan(hit: Hit, cueIndex: number): HitSpan {
  return (
    hit.spans.find((s) => s.cueIndex === cueIndex) ?? {
      cueIndex,
      start: hit.start,
      end: hit.end,
    }
  );
}

/** 将 cue 纯文本按命中切分为片段（跨 cue 命中按本 cue 覆盖区间切分） */
function segments(cue: CueHit): { text: string; hit?: Hit }[] {
  const out: { text: string; hit?: Hit }[] = [];
  let pos = 0;
  const sorted = cue.hits
    .map((h) => ({ h, span: localSpan(h, cue.index) }))
    .sort((a, b) => a.span.start - b.span.start);
  for (const { h, span } of sorted) {
    if (span.start > pos) out.push({ text: cue.text.slice(pos, span.start) });
    out.push({ text: cue.text.slice(span.start, span.end + 1), hit: h });
    pos = span.end + 1;
  }
  if (pos < cue.text.length) out.push({ text: cue.text.slice(pos) });
  return out;
}

function CueCard({
  cue,
  flash,
  linkedKey,
  onHoverHit,
  onToggleHit,
  onClearException,
}: {
  cue: CueHit;
  flash: boolean;
  /** 当前悬停命中的 key：同一跨 cue 命中在所有涉及 cue 联动高亮 */
  linkedKey: string | null;
  onHoverHit: (key: string | null) => void;
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
        {segs.map((s, i) => {
          if (!s.hit) return <span key={i}>{s.text}</span>;
          const hit = s.hit;
          const isCross = hit.spans.length > 1;
          const isAnchor = hit.spans[0].cueIndex === cue.index;
          const cueList = hit.spans.map((sp) => `#${sp.cueIndex + 1}`).join('、');
          return (
            <span
              key={i}
              className={`hit ${hit.reverted ? 'hit-reverted' : 'hit-applied'} ${
                hit.alias !== undefined ? 'hit-alias' : ''
              } ${isCross ? 'hit-cross' : ''} ${linkedKey === hit.key ? 'hit-linked' : ''}`}
              onMouseEnter={isCross ? () => onHoverHit(hit.key) : undefined}
              onMouseLeave={isCross ? () => onHoverHit(null) : undefined}
              title={
                (hit.alias !== undefined
                  ? `${hit.ruleName}（稳定化名，优先级 ${hit.priority}）\n原文：${hit.match}\n实体键：${hit.entityKey}\n化名：${hit.alias}`
                  : `${hit.ruleName}（优先级 ${hit.priority}）\n原文：${hit.match}\n替换：${hit.replacement}\n实体键：${hit.entityKey}`) +
                (isCross
                  ? `\n跨 cue 命中：涉及字幕 ${cueList}；替换写入 #${hit.spans[0].cueIndex + 1}，其余涉及字幕的被覆盖字符删除`
                  : '')
              }
            >
              <span className="hit-label">{hit.ruleName}</span>
              {isCross && (
                <span className="hit-cross-badge" title={`跨 cue 命中，涉及字幕 ${cueList}`}>
                  跨cue
                </span>
              )}
              {hit.decisionSource === 'entity' && (
                <span
                  className="hit-src hit-src-entity"
                  title="继承实体决定（可在左侧「实体决策」面板调整）"
                >
                  实体
                </span>
              )}
              {hit.decisionSource === 'exception' && (
                <span
                  className="hit-src hit-src-exception"
                  title="逐条例外：显式覆盖实体决定"
                >
                  例外
                </span>
              )}
              {hit.reverted ? (
                <span className="hit-original">{s.text}</span>
              ) : isAnchor ? (
                <span className="hit-replacement">{hit.replacement}</span>
              ) : (
                <span
                  className="hit-cross-tail"
                  title={`这些字符属于跨 cue 命中，替换文本已写入字幕 #${hit.spans[0].cueIndex + 1}，导出时此处字符删除`}
                >
                  {s.text}
                </span>
              )}
              <button
                className="hit-toggle"
                onClick={() => onToggleHit(hit.key)}
                title={
                  hit.reverted
                    ? '应用此替换（写入逐条例外）'
                    : '撤销此替换，恢复原文（写入逐条例外）'
                }
              >
                {hit.reverted ? '↩ 应用' : '↶ 撤销'}
              </button>
              {hit.decisionSource === 'exception' && (
                <button
                  className="hit-toggle hit-inherit"
                  onClick={() => onClearException(hit.key)}
                  title="清除此命中的例外，恢复继承实体决定（或默认应用）"
                >
                  ⟲ 继承
                </button>
              )}
            </span>
          );
        })}
      </div>
      {cue.suppressed.length > 0 && (
        <div className="suppressed">
          重叠抑制：
          {cue.suppressed.map((s, i) => (
            <span
              key={i}
              className="suppressed-chip"
              title={`原文：${s.match}${
                s.spans.length > 1
                  ? `（跨 cue，涉及字幕 ${s.spans.map((sp) => `#${sp.cueIndex + 1}`).join('、')}）`
                  : ''
              }`}
            >
              「{s.match}」被 {s.ruleName} 命中，已按优先级并入 {s.winnerRuleName}
              {s.spans.length > 1 && <em className="suppressed-cross">跨cue</em>}
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
  /** 悬停的跨 cue 命中 key：所有涉及 cue 的同一命中联动高亮 */
  const [linkedKey, setLinkedKey] = useState<string | null>(null);
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
            linkedKey={linkedKey}
            onHoverHit={setLinkedKey}
            onToggleHit={onToggleHit}
            onClearException={onClearException}
          />
        ))}
      </div>
    </section>
  );
}
