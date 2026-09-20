import type { MaskRule } from './types';

export interface Preset {
  name: string;
  description: string;
  rule: Omit<MaskRule, 'id'>;
}

/**
 * 内置脱敏规则预设（可在此基础上编辑/增删）。
 * 替换模板支持：$1/$2 捕获组、$& 整体命中、$<name> 命名组、
 * $KEEP:n（保留前 n 字其余打码）、$MASK:n、$MASKALL、$RULE。
 */
export const PRESETS: Preset[] = [
  {
    name: '手机号（中国大陆）',
    description: '11 位手机号，保留前 3 后 4',
    rule: {
      name: '手机号',
      pattern: '(?<!\\d)(1[3-9]\\d)\\d{4}(\\d{4})(?!\\d)',
      flags: 'g',
      replacement: '$1****$2',
      priority: 50,
      enabled: true,
      mode: 'template',
      aliasPrefix: '号码',
      crossCue: false,
      maxCueGapMs: 500,
    },
  },
  {
    name: '固定电话',
    description: '区号-号码，整体打码',
    rule: {
      name: '固定电话',
      pattern: '(?<!\\d)0\\d{2,3}-?\\d{7,8}(?!\\d)',
      flags: 'g',
      replacement: '$MASKALL',
      priority: 40,
      enabled: false,
      mode: 'template',
      aliasPrefix: '号码',
      crossCue: false,
      maxCueGapMs: 500,
    },
  },
  {
    name: '电子邮箱',
    description: '用户名打码，保留域名',
    rule: {
      name: '邮箱',
      pattern: '([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\\.[A-Za-z]{2,})',
      flags: 'gi',
      replacement: '****@$2',
      priority: 60,
      enabled: true,
      mode: 'template',
      aliasPrefix: '邮箱',
      crossCue: false,
      maxCueGapMs: 500,
    },
  },
  {
    name: '身份证号（18 位）',
    description: '保留前 6 后 4；优先级高于银行卡以吞并 18 位重叠命中',
    rule: {
      name: '身份证',
      pattern: '(?<![0-9Xx])(\\d{6})\\d{8}(\\d{3}[0-9Xx])(?![0-9Xx])',
      flags: 'g',
      replacement: '$1********$2',
      priority: 80,
      enabled: true,
      mode: 'template',
      aliasPrefix: '证件',
      crossCue: false,
      maxCueGapMs: 500,
    },
  },
  {
    name: '银行卡号（16-19 位）',
    description: '保留前 4 后 4；与身份证重叠时被身份证规则抑制',
    rule: {
      name: '银行卡',
      pattern: '(?<!\\d)(\\d{4})\\d{8,11}(\\d{4})(?!\\d)',
      flags: 'g',
      replacement: '$1********$2',
      priority: 75,
      enabled: true,
      mode: 'template',
      aliasPrefix: '卡号',
      crossCue: false,
      maxCueGapMs: 500,
    },
  },
  {
    name: 'URL 链接',
    description: '整段链接替换为提示文字',
    rule: {
      name: '链接',
      pattern: 'https?://[^\\s<]+',
      flags: 'gi',
      replacement: '[链接已脱敏]',
      priority: 30,
      enabled: false,
      mode: 'template',
      aliasPrefix: '链接',
      crossCue: false,
      maxCueGapMs: 500,
    },
  },
  {
    name: '称谓前姓名（姓氏起头两到三字）',
    description: '按常见姓氏起头匹配，保留姓氏；可自行扩充姓氏表或改成具体姓名：张三|李四|王五',
    rule: {
      name: '姓名',
      pattern:
        '[张王李赵刘陈杨黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文][一-龥]{1,2}(?=先生|女士|老师|经理|医生|同志)',
      flags: 'g',
      replacement: '$KEEP:1',
      priority: 20,
      enabled: true,
      mode: 'template',
      aliasPrefix: '人物',
      crossCue: false,
      maxCueGapMs: 500,
    },
  },
  {
    name: '称谓前姓名（稳定化名模式）',
    description:
      '同一人跨 cue 始终替换为同一编号化名（默认「人物1、人物2」，可改前缀、可在化名表手动改名）；增删字幕不重排编号',
    rule: {
      name: '姓名-稳定化名',
      pattern:
        '[张王李赵刘陈杨黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文][一-龥]{1,2}(?=先生|女士|老师|经理|医生|同志)',
      flags: 'g',
      replacement: '',
      priority: 20,
      enabled: false,
      mode: 'alias',
      aliasPrefix: '人物',
      crossCue: false,
      maxCueGapMs: 500,
    },
  },
  {
    name: '手机号（跨字幕连续扫描）',
    description:
      '手机号被两条相邻字幕断开时也能命中：间隔不超过 800ms 的相邻字幕拼成扫描窗口；替换写入首条字幕，后续字幕中被覆盖字符删除',
    rule: {
      name: '手机号-跨字幕',
      pattern: '(?<!\\d)(1[3-9]\\d)\\d{4}(\\d{4})(?!\\d)',
      flags: 'g',
      replacement: '$1****$2',
      priority: 50,
      enabled: false,
      mode: 'template',
      aliasPrefix: '号码',
      crossCue: true,
      maxCueGapMs: 800,
    },
  },
];

export const SAMPLE_VTT = `WEBVTT

00:00:00.000 --> 00:00:04.000
客服您好，我是张伟先生，我的手机号是13812345678。

00:00:04.500 --> 00:00:09.000
请把确认函发到 zhang.wei@example.com，
身份证号 110101199003071234 也一并登记。

00:00:09.500 --> 00:00:14.000
退款卡号 6222021234567890123 与备用手机 13987654321 均已备注。
`;
