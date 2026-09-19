interface Props {
  vtt: string;
  onChange: (v: string) => void;
  onLoadSample: () => void;
  onClear: () => void;
}

export function VttInput({ vtt, onChange, onLoadSample, onClear }: Props) {
  return (
    <section className="panel">
      <header className="panel-header">
        <h2>① 原始 WebVTT</h2>
        <div className="panel-actions">
          <button className="btn btn-ghost" onClick={onLoadSample}>
            载入示例
          </button>
          <button className="btn btn-ghost" onClick={onClear} disabled={!vtt}>
            清空
          </button>
        </div>
      </header>
      <p className="hint">
        粘贴带时间码的 VTT 内容。时间轴、NOTE / STYLE 块将原样保留，仅替换字幕文本。
      </p>
      <textarea
        className="vtt-editor"
        spellCheck={false}
        placeholder={'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n在此粘贴字幕文本……'}
        value={vtt}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="meta-row">字符数：{vtt.length}</div>
    </section>
  );
}
