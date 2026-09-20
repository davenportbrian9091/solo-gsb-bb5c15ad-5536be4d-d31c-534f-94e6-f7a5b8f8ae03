export type RuleMode = 'template' | 'alias';

export interface MaskRule {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
  priority: number;
  enabled: boolean;
  /** 替换模式：固定模板 / 稳定化名 */
  mode: RuleMode;
  /** 化名模式前缀 */
  aliasPrefix: string;
  /** 跨 cue 连续扫描：相邻（间隔 ≤ maxCueGapMs）字幕拼成扫描窗口 */
  crossCue: boolean;
  /** 跨 cue 模式的最大相邻间隔毫秒数 */
  maxCueGapMs: number;
}

/** 稳定化名映射条目（持久化，编号不复用） */
export interface AliasEntry {
  ruleId: string;
  entityKey: string;
  seq: number;
  alias: string;
  auto: boolean;
  sourceText?: string;
}

/** 命中最终状态的决策来源：默认应用 / 继承实体决定 / 逐条显式例外 */
export type DecisionSource = 'default' | 'entity' | 'exception';

/** 实体级决定动作：apply 始终应用替换；keep 始终保留原文 */
export type EntityDecisionAction = 'apply' | 'keep';

/** 实体级决定：按「规则 + NFKC 归一实体键」持久化，新命中自动继承 */
export interface EntityDecision {
  ruleId: string;
  entityKey: string;
  action: EntityDecisionAction;
  decidedAt: string;
}

/** 逐条命中例外：显式覆盖实体决定；清除后恢复继承 */
export interface HitException {
  key: string;
  state: 'applied' | 'reverted';
}

/** 命中在某条 cue 纯文本中的覆盖区间（跨 cue 命中按 cue 顺序排列） */
export interface HitSpan {
  cueIndex: number;
  /** 起止偏移（end 含） */
  start: number;
  end: number;
}

export interface Hit {
  key: string;
  ruleId: string;
  ruleName: string;
  priority: number;
  /** 在锚定 cue（spans 首个涉及 cue）纯文本中的起止偏移（含） */
  start: number;
  end: number;
  match: string;
  replacement: string;
  reverted: boolean;
  /** 最终状态的决策来源 */
  decisionSource: DecisionSource;
  /** 实体键：NFKC + trim 后的原文（实体决策与稳定化名共用） */
  entityKey: string;
  alias?: string;
  /** 涉及的全部 cue 及各自覆盖区间（跨 cue 命中多于一个） */
  spans: HitSpan[];
}

export interface SuppressedHit {
  ruleId: string;
  ruleName: string;
  priority: number;
  start: number;
  end: number;
  match: string;
  reason: 'overlap';
  winnerRuleId: string;
  winnerRuleName: string;
  entityKey: string;
  /** 涉及的全部 cue 及各自覆盖区间 */
  spans: HitSpan[];
}

export interface CueHit {
  index: number;
  id: string;
  start: string;
  end: string;
  payload: string;
  map: number[];
  text: string;
  hits: Hit[];
  suppressed: SuppressedHit[];
}

/** 实体决策列表行：实体 + 决定 + 命中统计 */
export interface EntitySummary {
  ruleId: string;
  /** 规则名；规则已删除时为空串 */
  ruleName: string;
  entityKey: string;
  sourceText: string;
  /** 当前实体决定；null = 待定 */
  decision: EntityDecisionAction | null;
  decidedAt?: string;
  totalHits: number;
  appliedHits: number;
  revertedHits: number;
  exceptionHits: number;
}

/* ---------------- 导出残留防线（二次扫描） ---------------- */

/** 二次扫描命中分类：人工保留（仅提示）/ 替换产物 / 跨边界新命中（后两者阻断导出） */
export type SafetyScanKind = 'kept' | 'artifact' | 'crossBoundary';

/** 候选导出文本中的一个来源片段 */
export interface SafetyScanSegment {
  start: number;
  end: number;
  /** original 未命中原文 / reverted 人工保留 / replacement 替换产物 */
  source: 'original' | 'reverted' | 'replacement';
  ruleId?: string;
  ruleName?: string;
  text: string;
  /** 跨 cue 二次命中时标注片段所属 cue */
  cueIndex?: number;
}

/** 二次扫描发现的一条问题（可定位到 cue 与文本区间） */
export interface SafetyScanIssue {
  /** 锚定 cue（首个涉及 cue）序号 */
  cueIndex: number;
  cueId: string;
  time: { start: string; end: string };
  /** 涉及的全部 cue 序号（跨 cue 二次命中多于一个） */
  cueIndexes: number[];
  /** 二次命中的目标规则 */
  rule: { id: string; name: string };
  start: number;
  end: number;
  match: string;
  kind: SafetyScanKind;
  /** kind=artifact：产生替换产物的来源规则 */
  sourceRule?: { id: string; name: string };
  /** 命中涉及的来源片段 */
  segments: SafetyScanSegment[];
}

/** 二次扫描汇总：分类计数 + 问题清单 */
export interface SafetyScanSummary {
  kept: number;
  artifact: number;
  crossBoundary: number;
  /** 是否存在阻断项 */
  blocked: boolean;
  issues: SafetyScanIssue[];
}

export interface PreviewResult {
  cueCount: number;
  totalHits: number;
  appliedHits: number;
  revertedHits: number;
  suppressedHits: number;
  /** 有显式例外的胜出命中数 */
  exceptionHits: number;
  cues: CueHit[];
  parseErrors: string[];
  aliases: AliasEntry[];
  /** 实体决策列表（当前命中实体 + 已持久决定的实体） */
  entities: EntitySummary[];
  /** 导出残留防线：候选文本二次扫描结果（随规则 / 例外变化实时重算） */
  safety: SafetyScanSummary;
}

export interface JobState {
  jobId: string;
  vtt: string;
  rules: MaskRule[];
  /** 逐条命中例外 */
  hitExceptions: HitException[];
  /** 实体级决定 */
  entityDecisions: EntityDecision[];
  aliases: AliasEntry[];
  updatedAt: string;
}

export interface AuditRecord {
  cueIndex: number;
  cueId: string;
  time: { start: string; end: string };
  /** 涉及的全部 cue 序号（跨 cue 命中多于一个） */
  cueIndexes: number[];
  rule: { id: string; name: string; priority: number };
  source: { start: number; end: number; text: string };
  replacement: string;
  status: 'applied' | 'reverted' | 'suppressed';
  /** 与预览一致的稳定命中键（被抑制命中无此字段） */
  key?: string;
  suppressedBy?: { id: string; name: string };
  entityKey?: string;
  alias?: string;
  /** 最终状态的决策来源（被抑制命中无此字段） */
  decisionSource?: DecisionSource;
}

export interface AuditReport {
  app: string;
  version: number;
  generatedAt: string;
  source: { sha256: string; length: number; cueCount: number };
  rules: MaskRule[];
  stats: {
    totalHits: number;
    appliedHits: number;
    revertedHits: number;
    suppressedHits: number;
    exceptionHits: number;
  };
  records: AuditRecord[];
  aliases?: AliasEntry[];
  entityDecisions?: EntityDecision[];
  /** 导出残留防线：二次扫描分类计数与问题清单 */
  safetyScan: {
    blocked: boolean;
    counts: { kept: number; artifact: number; crossBoundary: number };
    issues: SafetyScanIssue[];
  };
}

export interface ExportResult {
  vtt: string;
  audit: AuditReport;
  jobId: string;
}

export interface Preset {
  name: string;
  description: string;
  rule: Omit<MaskRule, 'id'>;
}
