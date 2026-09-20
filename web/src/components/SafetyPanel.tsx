import type { SafetyScanIssue, SafetyScanSegment, SafetyScanSummary } from '../types';

interface Props {
  safety: SafetyScanSummary;
  /** 定位到问题所在 cue（滚动 + 闪烁） */
  onLocate: (cueIndex: number) => void;
}

const KIND_META: Record<SafetyScanIssue['kind'], { label: string; cls: string }> = {
  kept: { label: '人工保留', cls: 'safety-kept' },
  artifact: { label: '替换产物', cls: 'safety-artifact' },
  crossBoundary: { label: '跨边界新命中', cls: 'safety-cross' },
};

const SOURCE_LABEL: Record<SafetyScanSegment['source'], string> = {
  original: '未命中原文',
  reverted: '人工保留',
  replacement: '替换产物',
};

function IssueDetail({ issue }: { issue: SafetyScanIssue }) {
  const crossNote =
    issue.cueIndexes.length > 1
      ? `该命中横跨字幕 ${issue.cueIndexes.map((c) => `#${c + 1}`).join('、')}（跨 cue 连续扫描窗口）。`
      : '';
  if (issue.kind === 'artifact') {
    return (
      <div className="safety-detail">
        {crossNote}
        完全落在来源规则「{issue.sourceRule?.name ?? '未知'}」的替换产物内，被目标规则「
        {issue.rule.name}」再次命中。请调整来源规则的替换模板 / 化名，或撤销该处替换改为人为保留。
      </div>
    );
  }
  if (issue.kind === 'crossBoundary') {
    return (
      <div className="safety-detail">
        {crossNote}
        <div>命中跨越 {issue.segments.length} 个来源片段（替换改变了边界上下文）：</div>
        <div className="safety-segments">
          {issue.segments.map((s, i) => (
            <span
              key={i}
              className={`safety-seg safety-seg-${s.source}`}
              title={`${SOURCE_LABEL[s.source]}${s.ruleName ? ` · 规则「${s.ruleName}」` : ''} · ${
                s.cueIndex !== undefined ? `字幕 #${s.cueIndex + 1} · ` : ''
              }候选文本 [${s.start}, ${s.end})`}
            >
              <em>
                {s.cueIndex !== undefined ? `#${s.cueIndex + 1} ` : ''}
                {SOURCE_LABEL[s.source]}
              </em>
              {s.text === '' ? '（空）' : `「${s.text}」`}
            </span>
          ))}
        </div>
      </div>
    );
  }
  const keptRules = Array.from(
    new Set(issue.segments.map((s) => s.ruleName).filter(Boolean)),
  ) as string[];
  return (
    <div className="safety-detail">
      {crossNote}
      命中与人工保留的原文重叠（{keptRules.map((n) => `「${n}」`).join('、') || '保留命中'}
      ），残留源于显式保留决定，仅提示、不阻断导出。
    </div>
  );
}

/**
 * 导出残留防线：按 cue 展示二次扫描发现的问题清单。
 * 人工保留仅提示；替换产物 / 跨边界新命中阻断导出。
 */
export function SafetyPanel({ safety, onLocate }: Props) {
  if (safety.issues.length === 0) {
    return (
      <div className="safety-panel safety-ok">
        <span className="safety-ok-icon">✓</span>
        导出残留防线：候选文本二次扫描无残留命中，可安全导出。
      </div>
    );
  }

  const byCue = new Map<number, SafetyScanIssue[]>();
  for (const issue of safety.issues) {
    const list = byCue.get(issue.cueIndex) ?? [];
    list.push(issue);
    byCue.set(issue.cueIndex, list);
  }

  return (
    <div className={`safety-panel ${safety.blocked ? 'safety-blocked' : 'safety-warn'}`}>
      <div className="safety-head">
        {safety.blocked ? (
          <>
            ⛔ 导出残留防线：发现 {safety.artifact + safety.crossBoundary} 处阻断项
            {safety.artifact > 0 && `（替换产物 ${safety.artifact}）`}
            {safety.crossBoundary > 0 && `（跨边界新命中 ${safety.crossBoundary}）`}
            {safety.kept > 0 && `，另有 ${safety.kept} 处人工保留提示`}——处理前无法导出。
          </>
        ) : (
          <>⚠ 导出残留防线：{safety.kept} 处人工保留命中（仅提示，不阻断导出）。</>
        )}
      </div>
      <ul className="safety-list">
        {Array.from(byCue.entries()).map(([cueIndex, issues]) => (
          <li key={cueIndex} className="safety-cue">
            <div className="safety-cue-head">
              <button
                className="btn btn-mini safety-locate"
                onClick={() => onLocate(cueIndex)}
                title="滚动到该字幕并高亮"
              >
                ⌖ 定位
              </button>
              <span className="mono">
                字幕 #{cueIndex + 1} · {issues[0].time.start} → {issues[0].time.end}
              </span>
              {issues.some((i) => i.cueIndexes.length > 1) && (
                <span
                  className="safety-cross-tag"
                  title="含跨 cue 连续扫描发现的命中：敏感串横跨多条相邻字幕"
                >
                  跨cue
                </span>
              )}
            </div>
            {issues.map((issue, i) => {
              const meta = KIND_META[issue.kind];
              return (
                <div key={i} className={`safety-issue ${meta.cls}`}>
                  <div className="safety-issue-head">
                    <span className={`safety-kind ${meta.cls}`}>{meta.label}</span>
                    <span className="safety-rule">目标规则「{issue.rule.name}」</span>
                    <code className="safety-match" title={`候选文本 [${issue.start}, ${issue.end})`}>
                      {issue.match}
                    </code>
                  </div>
                  <IssueDetail issue={issue} />
                </div>
              );
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
