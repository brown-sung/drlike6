const OpenAI = require('openai');
const { kv } = require('@vercel/kv');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 카카오톡 응답 형식 생성
function createSimpleTextResponse(text) {
    return {
        version: "2.0",
        template: {
            outputs: [{ simpleText: { text } }]
        }
    };
}

// OpenAI API 호출
async function getOpenAIResponse(messages) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messages,
            temperature: 0.5,
            response_format: { type: "json_object" },
        });
        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        console.error("OpenAI API 호출 오류:", error);
        return { extracted_info: {}, next_question: "죄송해요, 잠시 생각할 시간을 주시겠어요?" };
    }
}

// 만나이 계산
function calculateAgeInMonths(birthDateStr) {
    const birthDate = new Date(birthDateStr);
    const today = new Date();
    let years = today.getFullYear() - birthDate.getFullYear();
    let months = today.getMonth() - birthDate.getMonth();
    if (months < 0) {
        years--;
        months += 12;
    }
    return years * 12 + months;
}

// Z-점수를 이용한 백분위수 계산 (LMS 공식)
async function calculatePercentile(gender, ageMonths, measurementType, value) {
    try {
        const key = `${gender}:${measurementType}:${ageMonths}`;
        const lmsData = await kv.hgetall(key);
        if (!lmsData || !lmsData.L) {
            return [null, `해당 개월 수(${ageMonths}개월)의 ${measurementType} 데이터가 없습니다.`];
        }

        const L = parseFloat(lmsData.L);
        const M = parseFloat(lmsData.M);
        const S = parseFloat(lmsData.S);
        const x = parseFloat(value);
        
        let Z = 0;
        if (L !== 0) {
            Z = (Math.pow(x / M, L) - 1) / (L * S);
        } else {
            Z = Math.log(x / M) / S;
        }

        // 정규분포(CDF) 함수 근사치 계산
        const p = 0.3275911;
        const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
        const sign = (Z < 0) ? -1 : 1;
        const t = 1.0 / (1.0 + p * Math.abs(Z));
        const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-Z * Z);
        const percentile = (0.5 * (1.0 + sign * erf)) * 100;
        
        return [percentile.toFixed(1), null];

    } catch (e) {
        console.error(`백분위 계산 오류: ${e}`);
        return [null, "백분위 계산 중 오류가 발생했습니다."];
    }
}

module.exports = { createSimpleTextResponse, getOpenAIResponse, calculateAgeInMonths, calculatePercentile };