const { kv } = require('@vercel/kv');
const { SYSTEM_PROMPT, AFFIRMATIVE_PHRASES, NEGATIVE_PHRASES, END_PHRASES } = require('./constants');
const {
    createSimpleTextResponse,
    getOpenAIResponse,
    calculateAgeInMonths,
    calculatePercentile
} = require('./utils');

async function handleGreeting(userKey, utterance) {
    await kv.set(userKey, {
        state: 'collecting_init',
        history: [`사용자: ${utterance}`],
        collectedInfo: {}
    });
    return "안녕하세요! 소아청소년 성장 발달 상담 AI입니다. 자녀의 성장 정보를 알려주시면 백분위를 분석해 드릴게요. 상담을 시작할까요?";
}

async function handleCollectingInit(userKey, utterance, history) {
    const newHistory = [...history, `사용자: ${utterance}`];
    if (AFFIRMATIVE_PHRASES.some(phrase => utterance.includes(phrase))) {
        await kv.set(userKey, {
            state: 'collecting',
            history: newHistory,
            collectedInfo: {}
        });
        return "좋아요! 그럼 먼저 자녀의 생년월일을 알려주시겠어요?";
    }
    await kv.del(userKey);
    return "네, 알겠습니다. 언제든 도움이 필요하시면 다시 불러주세요.";
}

async function handleCollecting(userKey, utterance, history, collectedInfo) {
    if (END_PHRASES.some(phrase => utterance.includes(phrase))) {
        await kv.del(userKey);
        return "상담을 종료합니다. 이용해주셔서 감사합니다.";
    }

    const newHistory = [...history, `사용자: ${utterance}`];
    
    const requiredParams = ['birth_date', 'gender', 'height', 'weight'];
    const missingParams = requiredParams.filter(p => !collectedInfo[p]);

    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...newHistory.map(line => {
            const [role, ...content] = line.split(': ');
            return { role: role === '사용자' ? 'user' : 'assistant', content: content.join(': ') };
        }),
        { role: "user", content: `현재까지 수집된 정보: ${JSON.stringify(collectedInfo)}. 부족한 정보: [${missingParams.join(', ')}]. 사용자의 마지막 답변 "${utterance}"을 분석해서 정보를 추출하고, 자연스러운 다음 질문을 하나만 생성해줘.` }
    ];
    
    const aiResponse = await getOpenAIResponse(messages);
    
    // AI가 추출한 정보 업데이트
    let updatedInfo = { ...collectedInfo, ...aiResponse.extracted_info };
    
    const stillMissingParams = requiredParams.filter(p => !updatedInfo[p]);

    if (stillMissingParams.length === 0) {
        // 모든 정보 수집 완료 -> 리포트 생성
        await kv.set(userKey, { state: 'generating_report', history: newHistory, collectedInfo: updatedInfo });
        return stateHandlers.generating_report(userKey, utterance, newHistory, updatedInfo);
    } else {
        // 정보 계속 수집
        const nextQuestion = aiResponse.next_question || "다음 정보를 알려주시겠어요?";
        await kv.set(userKey, { state: 'collecting', history: [...newHistory, `assistant: ${nextQuestion}`], collectedInfo: updatedInfo });
        return nextQuestion;
    }
}

async function handleGeneratingReport(userKey, utterance, history, collectedInfo) {
    try {
        const { birth_date, gender, height, weight } = collectedInfo;
        const genderId = (gender === '남자') ? 1 : 2;
        const ageInMonths = calculateAgeInMonths(birth_date);
        
        const [h_percentile, h_err] = await calculatePercentile(genderId, ageInMonths, 'height', height);
        const [w_percentile, w_err] = await calculatePercentile(genderId, ageInMonths, 'weight', weight);

        if (h_err || w_err) {
            await kv.del(userKey);
            return `죄송합니다. 분석 중 오류가 발생했습니다. ${h_err || w_err}`;
        }
        
        const responseText = `📈 분석 결과입니다.\n\n✅ 나이: 만 ${ageInMonths}개월\n✅ 키: ${height}cm (상위 ${h_percentile}%)\n✅ 체중: ${weight}kg (상위 ${w_percentile}%)\n\n같은 나이, 같은 성별의 아이 100명 중 키는 약 ${100 - h_percentile:.0f}번째, 체중은 약 ${100 - w_percentile:.0f}번째에 해당해요.\n\n추가로 궁금한 점이 있으신가요? (초기화 또는 종료)`;
        
        await kv.set(userKey, { state: 'post_analysis', history, collectedInfo });
        return responseText;
    } catch (e) {
        console.error("리포트 생성 오류:", e);
        await kv.del(userKey);
        return "분석 리포트 생성에 실패했습니다. 입력값을 확인 후 다시 시도해주세요.";
    }
}

async function handlePostAnalysis(userKey, utterance) {
    if (utterance.includes("초기화")) {
        return handleGreeting(userKey, "다시 상담 시작할래");
    }
    await kv.del(userKey);
    return "상담을 종료합니다. 자녀의 건강한 성장을 응원합니다! 🌱";
}

const stateHandlers = {
    'greeting': handleGreeting,
    'collecting_init': handleCollectingInit,
    'collecting': handleCollecting,
    'generating_report': handleGeneratingReport,
    'post_analysis': handlePostAnalysis,
};

module.exports = stateHandlers;