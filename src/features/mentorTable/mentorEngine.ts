import { MentorProfile } from './mentorProfiles';
import type { AdviceLanguage } from './adviceLanguage';

export type MentorRiskLevel = 'none' | 'low' | 'medium' | 'high';

export interface MentorReply {
  mentorId: string;
  mentorName: string;
  likelyResponse: string;
  whyThisFits: string;
  oneActionStep: string;
  confidenceNote: string;
}

export interface MentorSimulationResult {
  schemaVersion: 'mentor_table.v1';
  language: AdviceLanguage;
  safety: {
    riskLevel: MentorRiskLevel;
    needsProfessionalHelp: boolean;
    emergencyMessage: string;
  };
  mentorReplies: MentorReply[];
  meta: {
    disclaimer: string;
    generatedAt: string;
    provider?: string;
    model?: string;
    source?: 'llm' | 'fallback';
    debugMessage?: string;
  };
}

// The deterministic fallback speaks every UI language since 2026-10; the
// safety copy is the part that must never regress to English-only.
const EMERGENCY_MESSAGES: Record<AdviceLanguage, string> = {
  'zh-CN':
    '如果你现在有伤害自己或他人的想法，请立刻联系当地紧急服务或危机热线，并尽快寻求可信赖的大人/朋友/专业人士帮助。',
  en: 'If you may harm yourself or others, contact local emergency services or a crisis hotline right now and seek trusted in-person help.',
  ja: '自分や他人を傷つける可能性があるなら、今すぐ地域の緊急サービスや危機ホットラインに連絡し、信頼できる人や専門家の助けを求めてください。',
  ko: '지금 자신이나 타인을 해칠 가능성이 있다면, 즉시 지역 응급 서비스나 위기 상담 핫라인에 연락하고 신뢰할 수 있는 사람이나 전문가의 도움을 받으세요.',
  es: 'Si existe riesgo de que te hagas daño a ti mismo o a otros, contacta de inmediato con los servicios de emergencia locales o una línea de crisis y busca ayuda presencial de confianza.',
};

type ReplyCopy = Record<AdviceLanguage, string>;

// Per-mentor likely responses, every locale. {excerpt} is the user's problem.
const MENTOR_LIKELY_RESPONSES: Record<string, ReplyCopy> = {
  bill_gates: {
    'zh-CN': '我能理解你现在的压力。刚开始做产品时，最难的是在不确定里做决定。面对“{excerpt}”，我会先抓一个最关键瓶颈，先把它解决，再看下一步。',
    en: 'I understand this pressure. Early on, the hardest part was deciding in uncertainty. With “{excerpt}”, I would isolate the single biggest bottleneck, solve that first, and then reassess.',
    ja: '今のプレッシャーは理解できます。プロダクト初期で一番難しいのは、不確実な中での決断です。「{excerpt}」に対しては、まず最大のボトルネックを特定し、そこを優先して解いてから次を考えるでしょう。',
    ko: '지금의 압박이 이해됩니다. 제품 초기에는 불확실한 상황에서 결정하는 것이 가장 어렵습니다. "{excerpt}"에 대해서는 가장 큰 병목을 먼저 찾아 해결하고, 그다음 단계를 생각하겠습니다.',
    es: 'Entiendo esta presión. Al principio, lo más difícil es decidir en la incertidumbre. Con "{excerpt}", aislaría el mayor cuello de botella, lo resolvería primero y luego reevaluaría.',
  },
  oprah_winfrey: {
    'zh-CN': '我听见你背后的情绪了，这真的不轻松。面对“{excerpt}”，我会先诚实地承认自己的感受，再给自己一个不被打扰的边界，慢慢把力量找回来。',
    en: 'I hear the emotional weight in what you shared, and it is not easy. With “{excerpt}”, I would first name what I truly feel, then protect my energy with one clear boundary so I can recover strength.',
    ja: 'あなたの言葉の奥にある感情が聞こえます。これは本当に簡単なことではありません。「{excerpt}」に対しては、まず自分の本当の気持ちを認め、邪魔されない境界線を一つ決めて、少しずつ力を取り戻すでしょう。',
    ko: '말씀의 이면에 있는 감정이 느껴집니다. 정말 쉽지 않은 일입니다. "{excerpt}"에 대해서는 먼저 내가 진짜 느끼는 감정을 인정하고, 방해받지 않을 경계를 하나 정해 천천히 힘을 회복하겠습니다.',
    es: 'Escucho el peso emocional de lo que compartiste, y no es fácil. Con "{excerpt}", primero nombraría lo que siento de verdad y luego pondría un límite claro para recuperar energía.',
  },
  kobe_bryant: {
    'zh-CN': '我知道这种卡住感。真正改变通常不是一口气爆发，而是重复正确动作。针对“{excerpt}”，我会今天就开始一个固定训练节奏，不等状态好了再行动。',
    en: 'I know what that stuck feeling is like. Real change is usually not one burst of motivation, but repeating the right actions. For “{excerpt}”, I would start a fixed routine today and move before I feel ready.',
    ja: 'この「詰まった感覚」は分かります。本当の変化は一度の爆発ではなく、正しい行動の繰り返しから生まれます。「{excerpt}」に対しては、今日から決まったリズムで動き、状態が良くなるのを待たずに始めるでしょう。',
    ko: '이 답답함이 무엇인지 압니다. 진짜 변화는 한 번의 폭발이 아니라 올바른 행동의 반복에서 옵니다. "{excerpt}"에 대해서는 오늘부터 정해진 리듬으로 움직이고, 기분이 좋아지기를 기다리지 않고 시작하겠습니다.',
    es: 'Sé cómo se siente ese estancamiento. El cambio real no suele ser un arrebato de motivación, sino repetir las acciones correctas. Con "{excerpt}", empezaría hoy una rutina fija y me movería antes de sentirme listo.',
  },
  miyazaki_hayao: {
    'zh-CN': '我理解你现在的混乱感。很多答案不是靠逼自己想出来，而是在认真做事时慢慢浮现。面对“{excerpt}”，我会先做一件小而完整的事，让心重新安静下来。',
    en: 'I understand this sense of inner noise. Many answers appear while doing careful work, not while forcing clarity. With “{excerpt}”, I would finish one small complete task to recover calm and direction.',
    ja: '今の混沌とした感覚は理解できます。答えの多くは、無理に考えて出すものではなく、丁寧な仕事の中で少しずつ現れます。「{excerpt}」に対しては、まず小さくても完成したことを一つやり、心を静めましょう。',
    ko: '지금의 혼란스러운 느낌이 이해됩니다. 많은 답은 억지로 생각해서 나오는 것이 아니라, 정성스러운 일을 하면서 서서히 나타납니다. "{excerpt}"에 대해서는 먼저 작고 완결된 일 하나를 끝내 마음을 가라앉히겠습니다.',
    es: 'Entiendo ese ruido interior. Muchas respuestas aparecen mientras se hace un trabajo cuidadoso, no forzando la claridad. Con "{excerpt}", terminaría una tarea pequeña y completa para recuperar la calma.',
  },
  elon_musk: {
    'zh-CN': '我明白你在承受什么。遇到复杂问题时，我会回到第一性原理：哪些是假设，哪些是事实。对“{excerpt}”，我会先拆掉一个错误假设，再重建行动路径。',
    en: 'I get what you are carrying. In hard situations, I go back to first principles: what is fact and what is assumption. For “{excerpt}”, I would remove one bad assumption and rebuild the plan from there.',
    ja: '何を抱えているか分かります。難しい局面では、まず原理に戻ります：何が仮説で、何が事実か。「{excerpt}」に対しては、まず一つの誤った仮説を取り除き、そこから行動計画を再構築するでしょう。',
    ko: '무엇을 짊어지고 있는지 압니다. 어려운 상황에서는 먼저 제1원리로 돌아갑니다: 무엇이 가정이고 무엇이 사실인지. "{excerpt}"에 대해서는 잘못된 가정 하나를 먼저 제거하고, 거기서부터 행동 경로를 다시 세우겠습니다.',
    es: 'Entiendo lo que cargas. En situaciones difíciles, vuelvo a los primeros principios: qué es un hecho y qué una suposición. Con "{excerpt}", eliminaría una mala suposición y reconstruiría el plan desde ahí.',
  },
  generic: {
    'zh-CN': '我先把问题拆成可执行步骤：先明确你最卡的点，再用稳定节奏推进，而不是一次解决全部。你提到的“{excerpt}”，我会先从一个最小动作开始。',
    en: 'I would break this into executable steps first: define the main bottleneck, then move with steady momentum instead of solving everything at once. For “{excerpt}”, I would start with one focused move.',
    ja: 'まず問題を実行可能な手順に分解します。最大のボトルネックを明確にし、一度に全部を解決するのではなく、安定したペースで前進しましょう。あなたが挙げた「{excerpt}」は、まず最小の一歩から始めます。',
    ko: '먼저 문제를 실행 가능한 단계로 나눕니다. 핵심 병목을 명확히 하고, 한 번에 모두 해결하지 말고 꾸준한 리듬으로 나아가세요. "{excerpt}"에 대해서는 가장 작은 행동 하나부터 시작하겠습니다.',
    es: 'Primero dividiría esto en pasos ejecutables: definir el principal cuello de botella y avanzar con constancia en lugar de resolverlo todo de una vez. Para "{excerpt}", empezaría con un único movimiento concreto.',
  },
};

const WHY_THIS_FITS: Record<AdviceLanguage, string> = {
  'zh-CN':
    '这类建议贴合其公开形象：关注长期方向，也强调把复杂问题拆成可执行的下一步；具体判断仍需结合你的实际情况。',
  en: '', // the per-mentor interpolation in buildWhyThisFits keeps the original behavior
  ja: 'この助言はその公のイメージと合っています：長期的な方向性を重視し、複雑な問題を実行できる次の一歩に分解することを大切にしています。具体的な判断にはあなたの実情を踏まえる必要があります。',
  ko: '이 조언은 그들의 공개된 이미지와 맞닿아 있습니다: 장기적인 방향을 중시하고, 복잡한 문제를 실행 가능한 다음 단계로 나누는 것을 강조합니다. 구체적인 판단은 당신의 상황을 함께 고려해야 합니다.',
  es: 'Esta sugerencia encaja con su imagen pública: se centra en la dirección a largo plazo y en descomponer lo complejo en un siguiente paso ejecutable; cualquier decisión concreta debe tener en cuenta tu situación real.',
};

const MENTOR_ACTION_STEPS: Record<string, ReplyCopy> = {
  bill_gates: {
    'zh-CN': '下一步：列出3个问题，只选“影响最大”的1个，给它安排今天30分钟深度处理。',
    en: 'Next step: list 3 issues, pick the highest-impact one, and give it 30 focused minutes today.',
    ja: '次の一手：問題を3つ挙げ、最もインパクトの大きい1つを選び、今日30分の集中時間を確保しましょう。',
    ko: '다음 단계: 문제 3개를 나열하고 영향이 가장 큰 1개를 골라, 오늘 30분 집중 시간을 주세요.',
    es: 'Siguiente paso: anota 3 problemas, elige el de mayor impacto y dale 30 minutos de atención hoy.',
  },
  oprah_winfrey: {
    'zh-CN': '下一步：写下你此刻最真实的情绪，并设定一个今天就执行的边界（比如拒绝1件消耗你的事）。',
    en: 'Next step: write down your real feeling and set one boundary you will enforce today.',
    ja: '次の一手：今の正直な感情を書き出し、今日実行する境界線を一つ決めましょう（消耗することを1つ断るなど）。',
    ko: '다음 단계: 지금 가장 진실한 감정을 적고, 오늘 지킬 경계를 하나 정하세요 (소모적인 일 하나를 거절하는 식으로).',
    es: 'Siguiente paso: escribe tu sentimiento más honesto y pon un límite que cumplirás hoy (por ejemplo, rechazar una cosa que te desgasta).',
  },
  kobe_bryant: {
    'zh-CN': '下一步：设一个7天固定节奏，每天同一时间做20分钟最关键动作，不间断。',
    en: 'Next step: set a 7-day routine and do 20 minutes of the key action at the same time daily.',
    ja: '次の一手：7日間の固定リズムを作り、毎日同じ時間に20分だけ最重要の行動を欠かさず行いましょう。',
    ko: '다음 단계: 7일 고정 루틴을 만들고, 매일 같은 시간에 20분씩 가장 중요한 행동을 하세요.',
    es: 'Siguiente paso: crea una rutina de 7 días y haz 20 minutos de la acción clave a la misma hora cada día.',
  },
  miyazaki_hayao: {
    'zh-CN': '下一步：今天完成一件“小而完整”的任务，结束时写一句你学到的东西。',
    en: 'Next step: complete one small, finished task today and write one line about what it taught you.',
    ja: '次の一手：今日「小さく完成した」タスクを一つ終え、終わったら学んだことを一文書きましょう。',
    ko: '다음 단계: 오늘 "작고 완결된" 일 하나를 끝내고, 배운 점을 한 줄 적으세요.',
    es: 'Siguiente paso: completa hoy una tarea pequeña y terminada, y escribe una línea sobre lo que te enseñó.',
  },
  elon_musk: {
    'zh-CN': '下一步：把当前困境拆成“事实/假设”两列，删除1个错误假设后重排你的计划。',
    en: 'Next step: split the problem into facts vs assumptions, remove one weak assumption, then rebuild your plan.',
    ja: '次の一手：今の行き詰まりを「事実/仮説」に分け、誤った仮説を1つ消してから計画を組み直しましょう。',
    ko: '다음 단계: 현재의 막힘을 "사실/가정"으로 나누고, 잘못된 가정 하나를 지운 뒤 계획을 다시 짜세요.',
    es: 'Siguiente paso: separa el problema en hechos vs suposiciones, elimina una suposición débil y reconstruye tu plan.',
  },
  generic: {
    'zh-CN': '下一步（今天可做）：写下1个你能在20分钟内完成的小任务，立即完成它；记录结果后，再决定下一个动作。',
    en: 'Next step (today): define one 20-minute task and execute it using this principle: “{pattern}.” Then reassess.',
    ja: '次の一手（今日できること）：20分で終わる小さなタスクを1つ書き、すぐにやり遂げ、結果を記録してから次の行動を決めましょう。',
    ko: '다음 단계(오늘 가능한 일): 20분 안에 끝낼 수 있는 작은 일 하나를 적고 바로 해내고, 결과를 기록한 뒤 다음 행동을 정하세요.',
    es: 'Siguiente paso (posible hoy): define una tarea de 20 minutos y ejecútala ya; registra el resultado y decide el siguiente movimiento.',
  },
};

const CONFIDENCE_NOTES: Record<AdviceLanguage, string> = {
  'zh-CN': '这是基于公开信息生成的AI模拟视角，不代表本人真实发言。',
  en: 'This is an AI-simulated perspective based on public information, not an actual statement by the person.',
  ja: 'これは公開情報に基づくAIシミュレーションの視点であり、本人の実際の発言ではありません。',
  ko: '이것은 공개 정보를 바탕으로 한 AI 시뮬레이션 관점이며, 본인의 실제 발언이 아닙니다.',
  es: 'Esta es una perspectiva simulada por IA basada en información pública, no una declaración real de la persona.',
};

const DISCLAIMERS: Record<AdviceLanguage, string> = {
  'zh-CN': '名人桌为AI模拟建议，仅用于启发，不构成医疗/法律/财务等专业意见。',
  en: 'Mentor Table provides AI-simulated inspiration only and is not medical, legal, or financial advice.',
  ja: '名人卓はAIシミュレーションによる助言で、医療・法律・財務などの専門意見ではありません。',
  ko: '명인 테이블은 AI 시뮬레이션 제안으로, 의료·법률·재무 등의 전문 조언이 아닙니다.',
  es: 'Mentor Table ofrece sugerencias simuladas por IA y no constituye asesoramiento médico, legal o financiero.',
};

function emergencyMessageFor(language: AdviceLanguage): string {
  return EMERGENCY_MESSAGES[language] || EMERGENCY_MESSAGES.en;
}

function detectRiskLevel(problem: string): MentorRiskLevel {
  const normalized = problem.toLowerCase();
  const highRiskTerms = [
    'suicide', 'kill myself', 'self harm', 'hurt myself', 'want to die',
    '伤害自己', '自杀', '不想活', '伤害他人',
    '自殺', '死にたい', '自傷', '自分を傷つけたい',
    '자살', '죽고 싶어', '자해', '스스로를 해치고 싶어',
    'suicidio', 'quiero morir', 'autolesión', 'hacerme daño',
  ];
  const mediumRiskTerms = [
    'panic', 'hopeless', '绝望', '崩溃', '失眠',
    'パニック', '絶望', '不眠', '공황', '절망', '불면',
    'pánico', 'desesperanza', 'insomnio',
  ];
  if (highRiskTerms.some((term) => normalized.includes(term))) return 'high';
  if (mediumRiskTerms.some((term) => normalized.includes(term))) return 'medium';
  return problem.trim() ? 'low' : 'none';
}

function buildLikelyResponse(problem: string, mentor: MentorProfile, language: AdviceLanguage): string {
  const excerpt = problem.slice(0, language === 'zh-CN' ? 42 : 80) + (problem.length > (language === 'zh-CN' ? 42 : 80) ? '...' : '');
  const copy = MENTOR_LIKELY_RESPONSES[mentor.id] || MENTOR_LIKELY_RESPONSES.generic;
  return (copy[language] || copy.en).replace('{excerpt}', excerpt);
}

function buildWhyThisFits(mentor: MentorProfile, language: AdviceLanguage): string {
  if (language === 'en') {
    return `This fits their public persona: a ${mentor.speakingStyle[0]} tone, values around ${mentor.coreValues.slice(0, 2).join(' and ')}, and a tendency to ${mentor.decisionPatterns[0]}.`;
  }
  return WHY_THIS_FITS[language] || WHY_THIS_FITS.en;
}

function buildOneActionStep(mentor: MentorProfile, language: AdviceLanguage): string {
  const copy = MENTOR_ACTION_STEPS[mentor.id] || MENTOR_ACTION_STEPS.generic;
  const step = copy[language] || copy.en;
  const pattern = mentor.decisionPatterns[1] || mentor.decisionPatterns[0] || 'take one focused step';
  return step.replace('{pattern}', pattern);
}

export function simulateMentorTable(
  problem: string,
  mentors: MentorProfile[],
  language: AdviceLanguage
): MentorSimulationResult {
  const riskLevel = detectRiskLevel(problem);
  const isHighRisk = riskLevel === 'high';

  return {
    schemaVersion: 'mentor_table.v1',
    language,
    safety: {
      riskLevel,
      needsProfessionalHelp: riskLevel === 'high' || riskLevel === 'medium',
      emergencyMessage: isHighRisk ? emergencyMessageFor(language) : ''
    },
    mentorReplies: mentors.map((mentor) => ({
      mentorId: mentor.id,
      mentorName: mentor.displayName,
      likelyResponse: buildLikelyResponse(problem, mentor, language),
      whyThisFits: buildWhyThisFits(mentor, language),
      oneActionStep: buildOneActionStep(mentor, language),
      confidenceNote: CONFIDENCE_NOTES[language] || CONFIDENCE_NOTES.en,
    })),
    meta: {
      disclaimer: DISCLAIMERS[language] || DISCLAIMERS.en,
      generatedAt: new Date().toISOString(),
      provider: 'local-simulator',
      model: 'rule-based',
      source: 'fallback'
    }
  };
}
