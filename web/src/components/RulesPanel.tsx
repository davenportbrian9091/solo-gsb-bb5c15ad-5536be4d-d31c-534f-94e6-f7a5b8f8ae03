import { useState } from 'react';
import type { MaskRule, Preset } from '../types';
import { uid, validateRegex, DEFAULT_CROSS_CUE_GAP_MS } from '../utils';

interface Props {
  rules: MaskRule[];
  presets: Preset[];
  onChange: (rules: MaskRule[]) => void;
}

export function RulesPanel({ rules, presets, onChange }: Props) {
  const [openId, setOpenId] = useState<string | null>(rules[0]?.id ?? null);

  const update = (id: string, patch: Partial<MaskRule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => onChange(rules.filter((r) => r.id !== id));
  const addBlank = () => {
    const r: MaskRule = {
      id: uid(),
      name: '新规则',
      pattern: '',
      flags: 'g',
      replacement: '***',
      priority: 10,
      enabled: true,
      mode: 'template',
      aliasPrefix: '化名',
      crossCue: false,
      crossCueMaxGapMs: DEFAULT_CROSS_CUE_GAP_MS,
    };
    onChange([...rules, r]);
    setOpenId(r.id);
  };
  const addPreset = (p: Preset) => {
    const r: MaskRule = { id: uid(), ...p.rule };
    onChange([...rules, r]);
    setOpenId(r.id);
  };

  const availablePresets = presets.filter(
    (p) => !rules.some((r) => r.name === p.rule.name && r.pattern === p.rule.pattern),
  );

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>② 脱敏规则</h2>
        <div className="panel-actions">
          <select
            className="preset-select"
            value=""
            onChange={(e) => {
              const p = presets.find((x) => x.name === e.target.value);
              if (p) addPreset(p);
            }}
          >
            <option value="">+ 添加预设…</option>
            {availablePresets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn" onClick={addBlank}>
            + 自定义规则
          </button>
        </div>
      </header>

      <p className="hint">
        数值越大优先级越高；重叠命中由高优先级（同优先级取更长匹配）吞并，被吞并项仅进入审计。
        模板替换支持 <code>$1</code>、<code>$&amp;</code>、<code>$KEEP:3</code>、
        <code>$MASKALL</code>、<code>$RULE</code>；切到「稳定化名」后同一实体跨 cue
        使用同一编号化名（NFKC 归一 + 去空白建键），增删字幕不重排编号，可在下方化名表改名。
        开启「跨 cue 连续扫描」后，时间相邻（结束→开始间隔不超阈值）的 cue 文本会拼接扫描，
        被字幕边界断开的敏感串仍可命中；替换写入首个 cue、后续 cue 覆盖字符删除。
      </p>

      <ul className="rule-list">
        {rules.length === 0 && <li className="empty-tip">暂无规则，请从预设添加或自定义。</li>}
        {rules.map((r) => {
          const err = r.enabled ? validateRegex(r.pattern, r.flags) : null;
          const open = openId === r.id;
          return (
            <li key={r.id} className={`rule-item ${r.enabled ? '' : 'disabled'}`}>
              <div className="rule-row">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => update(r.id, { enabled: e.target.checked })}
                  title="启用 / 停用"
                />
                <button className="rule-name" onClick={() => setOpenId(open ? null : r.id)}>
                  <span className="pri-badge" title="优先级">
                    {r.priority}
                  </span>
                  {r.name}
                  {r.mode === 'alias' && (
                    <span className="mode-badge mode-alias" title="稳定化名模式">
                      化名
                    </span>
                  )}
                  {r.crossCue && (
                    <span
                      className="mode-badge mode-crosscue"
                      title={`跨 cue 连续扫描：最大间隔 ${r.crossCueMaxGapMs ?? DEFAULT_CROSS_CUE_GAP_MS}ms`}
                    >
                      跨cue
                    </span>
                  )}
                  {err && <span className="rule-err-dot" title={err}>!</span>}
                  <span className="caret">{open ? '▾' : '▸'}</span>
                </button>
                <button className="btn btn-mini btn-danger" onClick={() => remove(r.id)}>
                  删除
                </button>
              </div>
              {open && (
                <div className="rule-detail">
                  <label>
                    规则名称
                    <input
                      value={r.name}
                      onChange={(e) => update(r.id, { name: e.target.value })}
                    />
                  </label>
                  <label>
                    正则（不含 /）
                    <input
                      className="mono"
                      spellCheck={false}
                      value={r.pattern}
                      onChange={(e) => update(r.id, { pattern: e.target.value })}
                    />
                  </label>
                  {err && <div className="rule-err">正则无效：{err}</div>}
                  <div className="rule-grid">
                    <label>
                      标志
                      <input
                        className="mono"
                        value={r.flags}
                        onChange={(e) => update(r.id, { flags: e.target.value })}
                      />
                    </label>
                    <label>
                      优先级
                      <input
                        type="number"
                        value={r.priority}
                        onChange={(e) => update(r.id, { priority: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <div className="rule-mode">
                    <span className="field-label">替换模式</span>
                    <label className={`mode-option ${r.mode === 'template' ? 'active' : ''}`}>
                      <input
                        type="radio"
                        name={`mode-${r.id}`}
                        checked={r.mode === 'template'}
                        onChange={() => update(r.id, { mode: 'template' })}
                      />
                      固定模板
                    </label>
                    <label className={`mode-option ${r.mode === 'alias' ? 'active' : ''}`}>
                      <input
                        type="radio"
                        name={`mode-${r.id}`}
                        checked={r.mode === 'alias'}
                        onChange={() => update(r.id, { mode: 'alias' })}
                      />
                      稳定化名
                    </label>
                  </div>
                  {r.mode === 'alias' ? (
                    <label>
                      化名前缀（编号化名 = 前缀 + 序号，留空为「化名」）
                      <input
                        className="mono"
                        value={r.aliasPrefix}
                        placeholder="如：人物 / 机构 / 地点"
                        onChange={(e) => update(r.id, { aliasPrefix: e.target.value })}
                      />
                    </label>
                  ) : (
                    <label>
                      替换模板
                      <input
                        className="mono"
                        value={r.replacement}
                        onChange={(e) => update(r.id, { replacement: e.target.value })}
                      />
                    </label>
                  )}
                  <div className="rule-crosscue">
                    <span className="field-label">跨 cue 连续扫描</span>
                    <label className={`mode-option ${r.crossCue ? 'active' : ''}`}>
                      <input
                        type="checkbox"
                        checked={r.crossCue === true}
                        onChange={(e) => update(r.id, { crossCue: e.target.checked })}
                      />
                      开启：拼接时间相邻 cue 扫描被字幕断开的敏感串
                    </label>
                    {r.crossCue && (
                      <label className="crossgap-field">
                        最大间隔（毫秒）
                        <input
                          type="number"
                          min={0}
                          max={3_600_000}
                          step={100}
                          value={r.crossCueMaxGapMs ?? DEFAULT_CROSS_CUE_GAP_MS}
                          onChange={(e) =>
                            update(r.id, {
                              crossCueMaxGapMs: Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                        />
                        <span className="crossgap-hint">
                          前一 cue 结束 → 后一 cue 开始的间隔不超过该值才拼接（0 = 必须首尾相接）
                        </span>
                      </label>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
