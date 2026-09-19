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

/** 本 cue 上一个命中片段（含跨 cue 命中在后续 cue 的覆盖部分） */
interface LocalHit {
  hit: Hit;
  /** 命中在本 cue 内的区间 */
  span: HitSpan;
  /** 该片段是跨 cue 命中的第几部分（0 起）；单 cue 命中为 0 */
  partIndex: number;
  /** 跨 cue 命中涉及的 cue 总数；单 cue 命中为 1 */
  partCount: number;
  /** 是否为首个涉及 cue（替换文本写入处） */
  isFirst: boolean;
}

function localHits(cue: CueHit): LocalHit[] {
  const out: LocalHit[] = [];
  const take = (hit: Hit): void => {
    const spans = hit.spans ?? [{ cueIndex: cue.index, start: hit.start, end: hit.end }];
    const partIndex = spans.findIndex((s) => s.cueIndex === cue.index);
    if (partIndex < 0) return;
    out.push({
      hit,
      span: spans[partIndex],
      partIndex,
      partCount: spans.length,
      isFirst: partIndex === 0,
    });
  };
  cue.hits.forEach(take);
  cue.coveringHits.forEach(take);
  return out.sort((a, b) => a.span.start - b.span.start);
}

/** 将 cue 纯文本按命中（含跨 cue 覆盖）切分为片段 */
function segments(cue: CueHit): { text: string; local?: LocalHit }[] {
  const out: { text: string; local?: LocalHit }[] = [];
  let pos = 0;
  for (const local of localHits(cue)) {
    if (local.span.start > pos) out.push({ text: cue.text.slice(pos, local.span.start) });
    out.push({
      text: cue.text.slice(local.span.start, local.span.end + 1),
      local,
    });
    pos = local.span.end + 1;
  }
  if (pos < cue.text.length) out.push({ text: cue.text.slice(pos) });
  return out;
}

function cueNoTitle(local: LocalHit): string {
  if (local.partCount <= 1) return '';
  return `（涉及 ${local.partCount} 条字幕：${local.hit
    .spans!.map((s) => `#${s.cueIndex + 1}`)
    .join(' → ')}）`;
}

function HitChip({
  cue,
  local,
  linkedKey,
  onLink,
  onToggleHit,
  onClearException,
}: {
  cue: CueHit;
  local: LocalHit;
  linkedKey: string | null;
  onLink: (key: string | null) => void;
  onToggleHit: (k: string) => void;
  onClearException: (k: string) => void;
}) {
  const { hit, span, partIndex, partCount, isFirst } = local;
  const cross = partCount > 1;
  const linked = linkedKey === hit.key;
  const bodyText = cue.text.slice(span.start, span.end + 1);
  return (
    <span
      className={[
        'hit',
        hit.reverted ? 'hit-reverted' : 'hit-applied',
        hit.alias !== undefined ? 'hit-alias' : '',
        cross ? 'hit-crosscue' : '',
        cross && !isFirst ? 'hit-covering' : '',
        linked ? 'hit-linked' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={
        (cross
          ? `跨 cue 命中（第 ${partIndex + 1}/${partCount} 部分）${cueNoTitle(local)}\n`
          : '') +
        (hit.alias !== undefined
          ? `${hit.ruleName}（稳定化名，优先级 ${hit.priority}）\n原文：${hit.match}\n实体键：${hit.entityKey}\n化名：${hit.alias}`
          : `${hit.ruleName}（优先级 ${hit.priority}）\n原文：${hit.match}\n替换：${hit.replacement}\n实体键：${hit.entityKey}`)
      }
      onMouseEnter={() => onLink(hit.key)}
      onMouseLeave={() => onLink(null)}
    >
      <span className="hit-label">{hit.ruleName}</span>
      {cross && (
        <span className="hit-cross-badge" title={cueNoTitle(local)}>
          跨cue {partIndex + 1}/{partCount}
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
        <span className="hit-src hit-src-exception" title="逐条例外：显式覆盖实体决定">
          例外
        </span>
      )}
      {hit.reverted ? (
        <span className="hit-original">{bodyText}</span>
      ) : isFirst ? (
        <span className="hit-replacement">{hit.replacement}</span>
      ) : (
        <span className="hit-deleted" title="跨 cue 命中：应用时此部分字符将从该 cue 删除">
          {bodyText}
          <em className="hit-delete-mark">⌫删除</em>
        </span>
      )}
      <button
        className="hit-toggle"
        onClick={() => onToggleHit(hit.key)}
        title={
          hit.reverted
            ? '应用此替换（写入逐条例外，作用于全部涉及 cue）'
            : '撤销此替换，全部涉及 cue 恢复原文（写入逐条例外）'
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
}

function CueCard({
  cue,
  flash,
  linkedKey,
  onLink,
  onToggleHit,
  onClearException,
}: {
  cue: CueHit;
  flash: boolean;
  linkedKey: string | null;
  onLink: (key: string | null) => void;
  onToggleHit: (k: string) => void;
  onClearException: (k: string) => void;
}) {
  const segs = useMemo(() => segments(cue), [cue]);
  /** 涉及本 cue 的跨 cue 命中（去重），用于底部联动导航 */
  const crossHits = useMemo(() => {
    const map = new Map<string, Hit>();
    for (const h of [...cue.hits, ...cue.coveringHits]) {
      if (h.spans && h.spans.length > 1 && !map.has(h.key)) map.set(h.key, h);
    }
    return Array.from(map.values());
  }, [cue]);

  return (
    <article id={`cue-card-${cue.index}`} className={`cue-card ${flash ? 'cue-flash' : ''}`}>
      <div className="cue-time mono">
        {cue.start}
        {' --> '}
        {cue.end}
      </div>
      <div className="cue-text">
        {segs.map((s, i) =>
          s.local ? (
            <HitChip
              key={i}
              cue={cue}
              local={s.local}
              linkedKey={linkedKey}
              onLink={onLink}
              onToggleHit={onToggleHit}
              onClearException={onClearException}
            />
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </div>
      {crossHits.length > 0 && (
        <div className="crosscue-links">
          {crossHits.map((h) => (
            <span key={h.key} className="crosscue-chip">
              🔗 「{h.match}」跨 {h.spans!.length} 条字幕：
              {h.spans!.map((sp, k) => (
                <button
                  key={sp.cueIndex}
                  className={`crosscue-jump ${linkedKey === h.key ? 'active' : ''} ${
                    sp.cueIndex === cue.index ? 'current' : ''
                  }`}
                  onMouseEnter={() => onLink(h.key)}
                  onMouseLeave={() => onLink(null)}
                  onClick={() =>
                    document
                      .getElementById(`cue-card-${sp.cueIndex}`)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }
                  title={
                    sp.cueIndex === cue.index
                      ? '当前字幕'
                      : `滚动到第 ${sp.cueIndex + 1} 条字幕（联动高亮同一命中）`
                  }
                >
                  #{sp.cueIndex + 1}
                  {k < h.spans!.length - 1 ? ' → ' : ''}
                </button>
              ))}
            </span>
          ))}
        </div>
      )}
      {cue.suppressed.length > 0 && (
        <div className="suppressed">
          重叠抑制：
          {cue.suppressed.map((s, i) => (
            <span
              key={i}
              className="suppressed-chip"
              title={`原文：${s.match}${s.spans ? `\n涉及 ${s.spans.length} 条字幕` : ''}`}
            >
              「{s.match}」被 {s.ruleName} 命中，已按优先级并入 {s.winnerRuleName}
              {s.spans && s.spans.length > 1 ? `（跨 ${s.spans.length} cue）` : ''}
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
  /** 当前联动高亮的命中 key（跨 cue 命中在全部涉及 cue 同步高亮） */
  const [linkedKey, setLinkedKey] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cues = useMemo(() => {
    if (!preview) return [];
    return onlyMatched
      ? preview.cues.filter((c) => c.hits.length > 0 || c.coveringHits.length > 0)
      : preview.cues;
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
          {preview.crossCueHits > 0 && (
            <span className="stat-crosscue" title="跨 cue 连续扫描命中（已计入上方总数）">
              跨cue {preview.crossCueHits}
            </span>
          )}
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
            onLink={setLinkedKey}
            onToggleHit={onToggleHit}
            onClearException={onClearException}
          />
        ))}
      </div>
    </section>
  );
}
