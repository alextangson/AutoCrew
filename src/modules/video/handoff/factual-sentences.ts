/**
 * 交接出处门：定稿里哪些句子必须能指回一条出处（shared-content-project spec「出处」一节）。
 * 覆盖单位是整句，两类句子：
 *
 * - **真实数字**：抽取器就是写稿数字硬门的 `extractNumbers`，口径只有一处——第 N、列表编号、
 *   版本号不算；「一个 / 一次 / 同一个」这类单字数词 + 量词是行文，不抽；「两小时」「三成」「370 次」照算。
 * - **明确归因**：第三方说 / 表示 / 认为 / 指出…、据…、听说、在 X 看来、X 在文章里写、X 管它叫…、
 *   原文 / 报告注明…；署名主语的「X 的原话 / 总结」和「X …：」转述。「先说」「说不清」「说白了」
 *   「前面说」是口语；我 / 你 / 指 AI 的「它」不是第三方来源。
 *
 * 这是结构下限，不是语义判断：没有归因标记的转述（「Thariq 把这两种错分开数了」）靠写稿侧自核。
 * 不按「主语像专名」去猜——那会把每句讲产品行为的话（「Claude 里分得更细」）都拦下来。
 */
import { EXEMPT_ROLES, extractNumbers } from "../../writing/number-gate.js";

export interface FactualSentence {
  start: number;
  end: number;
  /** 需要出处的数字原文，如「370 次」「12%」 */
  numbers: string[];
  /** 命中的归因标记原文，如「可 Thariq 说」 */
  attribution?: string;
}

const SENTENCE_RE = /[^。！？!?\n]+[。！？!?]?/g;
const CLAUSE_BREAKS = "，,；;：:、「」“”‘’『』（）()《》";

// ── 主语：剥掉连词 / 介词 / 「在视频里」（前）和副词 / 时间 / 「在文章里」/「跟我」（后），看剩下的是不是第三方 ──
const LEAD_RE = /^(?:可是|可|但是|但|不过|而且|而|所以|因为|如果|要是|那么|那|然后|于是|其实|当然|并且|还有|就连|连|甚至|请|也|还|就|都|跟|和|与|同|对|向|按照|按|照|根据|依据|用|借|在[^，。\s]{0,8}?(?:里|中|上|下|前|后|时候|时|期间|这一步|那一步))\s*/;
const TRAIL_RE = /\s*(?:也|还|就|都|又|才|只|却|倒|再|先|便|曾经|曾|已经|早就|一直|反复|一再|多次|明确|公开|直接|亲口|当面|特意|专门|私下|逐条|逐一|仔细|认真|自己|本人|当时|后来|最近|现在|刚刚|刚才|刚|之前|以前|过去|前面|上面|下面|后面|前文|上文|开头|这里|这儿|平时|常常|经常|总是|总|会|要|想|能|可能|可以|应该|得|确实|的确|也许|大概|肯定|一定|正在|正|竟然|居然|果然|在[^，。]{0,10}?(?:里|中|上|下|前|后|时候|时|期间)|在|[跟对向给和](?:我们|我|你们|你|咱们|大家|他们|他|她|它))$/;
const NEGATION_RE = /(?:不|没有|没|别|未|不要|不用|不必|无需)$/;
const SELF_RE = /(?:我们|我|咱们|咱|你们|你|您|它们|它)$/;
const SOURCE_NOUNS = "原文|原话|论文|报告|研究|调查|文章|博客|推文|帖子|公告|声明|财报|官网|文档|数据|统计|实测|实验|图注|图表|报道|新闻|采访";
const SOURCE_NOUN_RE = new RegExp(SOURCE_NOUNS);

function strip(subject: string): string {
  let s = subject.trim();
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(LEAD_RE, "").replace(TRAIL_RE, "").trim();
  }
  return s;
}

/** 动词前的主语是第三方：不空、不是我 / 你 / 它、不是否定、不是指代上文的这 / 那（「这篇文章」除外） */
function isThirdParty(subject: string): boolean {
  const s = strip(subject);
  if (!s || NEGATION_RE.test(s) || SELF_RE.test(s)) return false;
  return !/^[这那]/.test(s) || SOURCE_NOUN_RE.test(s);
}

// ── 署名主语：结构类规则（「X 的总结」「X …：」）信号弱，只认拉丁字母专名、第三人称和机构角色 ──
const NAMED = "(?:[A-Z][A-Za-z0-9.'’-]*(?:\\s+[A-Z][A-Za-z0-9.'’-]*)*|他们|她们|(?<!其)他|她|对方|官方|团队|作者|专家|网友|媒体|研究者|创始人|发言人|负责人|别人|有人|很多人|不少人)";
const NAMED_START_RE = new RegExp(`^${NAMED}`);
const NAMED_END_RE = new RegExp(`${NAMED}$`);
/** 行文里当普通名词用的大写缩写，不是署名 */
const LATIN_COMMON = /^(?:AI|App|APP|API|UI|PPT|PDF|OK)$/;

function isNamed(hit: RegExpExecArray | null): boolean {
  return Boolean(hit) && !LATIN_COMMON.test(hit![0]);
}

// ── 归因标记 ──
const SPEECH_RE = /说|表示|指出|认为|声称|宣称|号称|宣布|透露|坦言|承认|强调|提到|写道|披露|证实|公布|(?<![简俗统昵名对堪著])称(?=[，,：:「“])/g;
/** 「说」的口语搭配：说不清、说白了、说到这儿、说法、说明、说一句、对我来说…（「后来说」「站出来说」不算）；「听说」「据说」另有规则 */
const SHUO_IDIOM_AFTER = /^(?:不|清|白|到|出|法|明|完|服|起|得|好|定|来|回|句|一|几|实话|真的|了算)/;
const SHUO_IDIOM_BEFORE = /(?:小|传|听|据|怎么|这么|那么|换句话|就是|比如|比方|譬如|例如|反过来|(?<![后出过起])来|再|不用|别|应该|可以|不得不|老实|坦白|照理|按理|话|虽|俗话|老话|常言|古话)$/;
const HEARSAY_RE = /据(?:说|悉|报道|统计|了解|称|介绍|透露|估计|测算|调查)|听说(?!过)/;
/** 第 1 组是要判第三方的主语 */
const INNER_SUBJECT_RES = [
  /据([^，。；]{1,24}?)(?:说|称|介绍|透露|报道|统计|估计|测算|调查|显示)/g,
  /(?:根据|按照|依据)([^，。；]{1,24}?)的?(?:数据|说法|报告|研究|统计|调查|测算|文章|原文|论文|公告|财报|官网|文档|实测)/g,
  /在([^，。；]{1,24}?)看来/g,
  /(?:用|借|按|照)([^，。；]{1,24}?)的(?:话|说法)/g,
];
/** 主语在标记前面的分句里 */
const PREFIX_SUBJECT_RES = [
  /在(?:文章|博客|推文|帖子|论文|报告|原文|采访|访谈|演讲|视频|播客|节目|直播|公告|声明|书|信|邮件|官网|文档|发布会|会上)(?:里|中|上)?(?:写|讲|介绍|解释|分享|回应)/g,
  /管[^，。；]{0,6}?叫/g,
];
const SOURCE_SAYS_RE = new RegExp(
  `(?:${SOURCE_NOUNS})(?:里|中|上)?([^，,；;：:]{0,6}?)(?:说(?![不清白到出法明完服起得好定来回句一几])|写道|写着|提到|显示|表明|指出|发现|注明|证明|证实|称|认为|强调)`,
  "g",
);
/** 资料是我 / 你的，或是动作的宾语（把原文…、看完报告…），就不是它在「说」 */
const SOURCE_NOT_SPEAKER = /(?:我们|我|你们|你|咱们|它)的?$|(?:把|将|给|帮|替|让|看|读|写|找|查|翻|拿|用|发|贴|交|改|做|对照|参考)(?:完|了|过|好)?$/;
const POSSESSIVE_RE = /([^，,；;：:、「」“”（）()]{1,16}?)的(?:原话|说法|观点|看法|结论|总结|原文|论文|报告|文章|博客|推文|帖子|采访|演讲|发言|声明|公告)/g;

function clauseStart(sentence: string, at: number): number {
  for (let i = at - 1; i >= 0; i--) if (CLAUSE_BREAKS.includes(sentence[i])) return i + 1;
  return 0;
}

/** 分句开头的「说」承接首个分句的主语：「Altman 发了条推，说…」；首句里是我 / 你、或由「它」起头，就是自己人在说 */
function inheritsThirdParty(sentence: string): boolean {
  const first = sentence.split(/[，,；;]/)[0].replace(LEAD_RE, "");
  return !/[我你咱您]/.test(first) && !/^\s*它/.test(first);
}

function speechAttribution(sentence: string): string | undefined {
  for (const m of sentence.matchAll(SPEECH_RE)) {
    const at = m.index!;
    if (m[0] === "说" && (SHUO_IDIOM_AFTER.test(sentence.slice(at + 1)) || SHUO_IDIOM_BEFORE.test(sentence.slice(0, at)))) continue;
    const from = clauseStart(sentence, at);
    const subject = sentence.slice(from, at);
    if (isThirdParty(subject)) return sentence.slice(from, at + m[0].length).trim();
    if (m[0] === "说" && !subject.trim() && from > 0 && "，,；;".includes(sentence[from - 1]) && inheritsThirdParty(sentence)) {
      return sentence.slice(0, at + 1).trim();
    }
  }
  return undefined;
}

function markerAttribution(sentence: string): string | undefined {
  const hearsay = HEARSAY_RE.exec(sentence);
  if (hearsay) return hearsay[0];
  for (const re of INNER_SUBJECT_RES) {
    for (const m of sentence.matchAll(re)) if (isThirdParty(m[1])) return m[0];
  }
  for (const re of PREFIX_SUBJECT_RES) {
    for (const m of sentence.matchAll(re)) {
      const from = clauseStart(sentence, m.index!);
      if (isThirdParty(sentence.slice(from, m.index!))) return sentence.slice(from, m.index! + m[0].length).trim();
    }
  }
  for (const m of sentence.matchAll(SOURCE_SAYS_RE)) {
    const before = sentence.slice(clauseStart(sentence, m.index!), m.index!).trim();
    if (!SOURCE_NOT_SPEAKER.test(before) && !/[我你它]/.test(m[1])) return m[0];
  }
  return undefined;
}

function namedAttribution(sentence: string): string | undefined {
  for (const m of sentence.matchAll(POSSESSIVE_RE)) {
    if (isNamed(NAMED_END_RE.exec(strip(m[1])))) return m[0].trim();
  }
  for (let i = 0; i < sentence.length; i++) {
    if (sentence[i] !== "：" && sentence[i] !== ":") continue;
    const clause = sentence.slice(clauseStart(sentence, i), i).trim().replace(LEAD_RE, "");
    if (isNamed(NAMED_START_RE.exec(clause))) return `${clause}：`;
  }
  return undefined;
}

/** 句子里的归因标记；没有返回 undefined */
export function findAttribution(sentence: string): string | undefined {
  return speechAttribution(sentence) ?? markerAttribution(sentence) ?? namedAttribution(sentence);
}

/** 定稿里必须有出处的句子（带真实数字或明确归因），按正文顺序 */
export function factualSentences(body: string): FactualSentence[] {
  const numbers = extractNumbers(body).filter((m) => !EXEMPT_ROLES.has(m.role));
  const out: FactualSentence[] = [];
  for (const match of body.matchAll(SENTENCE_RE)) {
    const start = match.index! + (match[0].length - match[0].trimStart().length);
    const end = match.index! + match[0].trimEnd().length;
    if (end <= start) continue;
    const inside = numbers.filter((m) => m.index >= start && m.index < end).map((m) => m.raw.trim());
    const attribution = findAttribution(body.slice(start, end));
    if (inside.length || attribution) out.push({ start, end, numbers: inside, ...(attribution ? { attribution } : {}) });
  }
  return out;
}
