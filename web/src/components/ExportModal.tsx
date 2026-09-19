import type { AuditReport } from '../types';
import { download, stamp } from '../utils';

interface Props {
  vtt: string;
  audit: AuditReport;
  onClose: () => void;
}

export function ExportModal({ vtt, audit, onClose }: Props) {
  const prefix = `desensitized-${stamp()}`;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>导出确认</h3>
        <p className="hint">
          以下文件按当前预览的最终状态（实体决定 + 逐条例外）生成；时间轴保持原样。可分别下载：
        </p>
        <ul className="export-summary">
          <li>
            <code>{prefix}.vtt</code> — 脱敏后的 WebVTT（CRLF）
          </li>
          <li>
            <code>{prefix}.json</code> — 审计报告（规则、原文区间、替换结果、抑制记录、
            每条的决策来源与实体决定）
          </li>
        </ul>
        <div className="export-stats">
          <span>应用 {audit.stats.appliedHits}</span>
          <span>保留 {audit.stats.revertedHits}</span>
          <span>抑制 {audit.stats.suppressedHits}</span>
          <span>例外 {audit.stats.exceptionHits}</span>
          <span>记录 {audit.records.length} 条</span>
        </div>
        <div className="export-safety">
          ✓ 导出残留防线：二次扫描通过
          {audit.safetyScan.counts.kept > 0
            ? `（${audit.safetyScan.counts.kept} 处人工保留命中，仅提示并已记入审计）`
            : '（候选文本无残留命中）'}
        </div>
        <div className="modal-actions">
          <button
            className="btn"
            onClick={() => download(`${prefix}.vtt`, vtt, 'text/vtt;charset=utf-8')}
          >
            下载 VTT
          </button>
          <button
            className="btn"
            onClick={() =>
              download(
                `${prefix}.json`,
                JSON.stringify(audit, null, 2),
                'application/json;charset=utf-8',
              )
            }
          >
            下载审计 JSON
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
