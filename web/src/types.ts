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
  /** 跨 cue 连续扫描：相邻 cue 间隔不超过阈值时拼接扫描 */
  crossCue?: boolean;
  /** 跨 cue 最大间隔（毫秒） */
  crossCueMaxGapMs?: number;
}

/** 命中落在单条 cue 纯文本上的一个片段（跨 cue 命中有多个） */
export interface HitSpan {
  cueIndex: number;
  start: number;
  /** 含 */
  end: number;
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

export interface Hit {
  key: string;
  ruleId: string;
  ruleName: string;
  priority: number;
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
  /** 跨 cue 命中：涉及的全部 cue 与各自被覆盖区间；单 cue 命中无此字段 */
  spans?: HitSpan[];
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
  /** 跨 cue 抑制项：涉及的全部 cue 与区间 */
  spans?: HitSpan[];
}

export interface CueHit {
  index: number;
  id: string;
  start: string;
  end: string;
  payload: string;
  map: number[];
  text: string;
  /** 首个覆盖区间落在本 cue 的命中（含跨 cue 命中本体） */
  hits: Hit[];
  /** 跨 cue 命中在本 cue 的后续覆盖部分（与首个 cue 的命中共用同一 key） */
  coveringHits: Hit[];
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
  /** 片段所属 cue（跨 cue 窗口扫描时片段可能分属不同 cue） */
  cueIndex: number;
}

/** 二次扫描发现的一条问题（可定位到 cue 与文本区间） */
export interface SafetyScanIssue {
  cueIndex: number;
  cueId: string;
  time: { start: string; end: string };
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
  /** 跨 cue 二次命中：涉及的全部 cue 序号（至少 2 个） */
  cueIndices?: number[];
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
  /** 跨 cue 连续扫描命中的胜出命中数（已计入 totalHits） */
  crossCueHits: number;
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
  rule: { id: string; name: string; priority: number };
  source: { start: number; end: number; text: string };
  replacement: string;
  status: 'applied' | 'reverted' | 'suppressed';
  suppressedBy?: { id: string; name: string };
  entityKey?: string;
  alias?: string;
  /** 最终状态的决策来源（被抑制命中无此字段） */
  decisionSource?: DecisionSource;
  /** 跨 cue 命中：涉及的全部 cue（按顺序） */
  cueIndices?: number[];
  /** 跨 cue 命中：各 cue 内被覆盖的纯文本区间（含起止） */
  spans?: HitSpan[];
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
    /** 跨 cue 连续扫描命中的胜出命中数 */
    crossCueHits?: number;
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
