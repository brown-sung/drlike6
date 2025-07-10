const express = require('express');
const path = require('path');
const { jStat } = require('jstat');

// 빌드된 데이터 파일을 직접 가져옵니다.
const lmsData = require('./lms_data.js');

// node-fetch는 ESM 전용 모듈이므로 dynamic import를 사용합니다.
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(express.json());

// --- 1. 설정: 환경변수에서 OpenAI API 키 가져오기 ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log("LMS 데이터가 코드를 통해 로드되었습니다.");

// --- 2. 대화 상태 저장을 위한 메모리 내 세션 ---
const userSessions = {};

/**
 * LMS 파라미터를 사용하여 주어진 값의 백분위를 계산합니다.
 */
function calculatePercentile(value, lms) {
  if (!lms) return null;
  const { L, M, S } = lms;
  let zScore;

  if (L !== 0) {
    zScore = (Math.pow(value / M, L) - 1) / (L * S);
  } else {
    zScore = Math.log(value / M) / S;
  }

  const percentile = jStat.normal.cdf(zScore, 0, 1) * 100;
  return parseFloat(percentile.toFixed(2));
}

/**
 * OpenAI API를 호출하여 응답을 가져옵니다.
 */
async function callOpenAI(prompt, isJsonMode = false) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.');
  }

  const body = {
    model: 'gpt-4o',
    messages: [{ role: 'system', content: 'You are a helpful and empathetic AI assistant named Dr. Likey, specializing in pediatric growth analysis. Your primary language is Korean.' }, { role: 'user', content: prompt }],
    temperature: 0.3, // 일관된 JSON 출력을 위해 온도를 더 낮춤
  };

  if (isJsonMode) {
    body.response_format = { type: "json_object" };
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`OpenAI API 오류: ${response.status} ${response.statusText}`, errorBody);
    throw new Error('OpenAI API 호출에 실패했습니다.');
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// 루트 경로 핸들러: 배포 성공 확인 페이지
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`
    <!DOCTYPE html>
    <html lang="ko">
    <head><meta charset="UTF-8"><title>서버 실행 중</title></head>
    <body style="font-family: sans-serif; text-align: center; padding: 40px;">
      <h1 style="color: #4CAF50;">✅ 서버가 정상적으로 실행 중입니다</h1>
      <p>성장 발달 챗봇 서버가 성공적으로 배포되었습니다.</p>
    </body>
    </html>
  `);
});


// 카카오톡 스킬 API 엔드포인트
app.post('/skill', async (req, res) => {
  const userId = req.body.userRequest.user.id;
  const userInput = req.body.userRequest.utterance;

  let session = userSessions[userId] || { sex: null, age_month: null, height_cm: null, weight_kg: null };

  try {
    // [프롬프트 개선] 1. AI 분석가: 모든 지시사항을 한글로 변경
    const decisionPrompt = `
      너는 소아과 챗봇의 지능형 '라우터'야. 사용자의 메시지와 현재 데이터를 분석해서, 다음에 할 논리적인 행동을 결정해야 해.

      **현재 데이터 (세션):**
      ${JSON.stringify(session)}

      **사용자 메시지:**
      "${userInput}"

      **너의 임무: 다음 행동을 결정하고 데이터를 추출해라.**
      1.  **의도 분석**: 사용자가 인사를 하는지, 정보를 제공하는지, 초기화를 원하는지 등을 한국어 맥락에 맞게 분석해.
      2.  **데이터 추출**: 사용자 메시지에서 \`sex\`, \`age_month\`, \`height_cm\`, \`weight_kg\`를 추출해. 단위가 없으면 추론해야 해 (예: 키를 묻는 상황에서 "100"이라고 답하면 100cm임).
      3.  **행동 결정**:
          - 사용자가 "안녕", "안녕하세요" 등 순수한 인사를 할 경우: \`"action": "greet"\`
          - 새로운 정보가 들어왔지만, 추가 정보가 더 필요한 경우: \`"action": "confirm_and_ask_next"\`
          - 새 정보는 없는데, 누락된 정보가 있는 경우: \`"action": "ask_for_missing_info"\`
          - 모든 정보가 수집된 경우: \`"action": "generate_report"\`
          - 사용자가 "다시", "초기화" 등 리셋을 원할 경우: \`"action": "reset"\`
      4.  **출력**: 반드시 다음 형식의 유효한 JSON 객체 하나만 다른 설명 없이 응답해야 해.

      **예시 1 (인사):**
      사용자가 "안녕하세요" 라고 말함.
      출력: \`{"action": "greet", "data": {}}\`

      **예시 2 (정보 제공):**
      세션에 \`{"sex": "male", "age_month": null, ...}\`가 있고, 사용자가 "10개월" 이라고 말함.
      출력: \`{"action": "confirm_and_ask_next", "data": {"age_month": 10}}\`
    `;
    
    const rawDecision = await callOpenAI(decisionPrompt, true);
    const decision = JSON.parse(rawDecision);

    // 세션 업데이트
    session = { ...session, ...decision.data };
    userSessions[userId] = session;

    let responseText = '';

    // [구조 개선] 2. 결정된 행동(action)에 따라 응답 생성
    switch (decision.action) {
      case 'greet':
        responseText = '안녕하세요! 우리 아이 성장 발달, 저 닥터 라이키에게 편하게 물어보세요. 아이의 성별과 나이부터 알려주시겠어요?';
        break;

      case 'confirm_and_ask_next':
      case 'ask_for_missing_info':
        let missingField = '';
        if (session.sex === null) missingField = '성별';
        else if (session.age_month === null) missingField = '나이(개월)';
        else if (session.height_cm === null) missingField = '키(cm)';
        else if (session.weight_kg === null) missingField = '몸무게(kg)';

        // [프롬프트 개선] 응답 생성 프롬프트도 한글로 변경
        const responseGenerationPrompt = `
          너는 '닥터 라이키'야. 따뜻하고 자연스러운 한국어 응답을 생성해야 해.
          - **이전에 수집된 정보:** ${JSON.stringify(session)}
          - **사용자의 마지막 말:** "${userInput}"
          - **너의 다음 목표:** "${missingField}"에 대해 질문하기.
          
          사용자가 방금 제공한 정보를 먼저 인정하고 확인해준 뒤(예: "네, 10개월이군요!"), 부드럽게 다음 정보를 물어봐.
          다른 부연 설명 없이, 실제 사용자에게 보낼 응답 메시지만 생성해줘.
        `;
        responseText = await callOpenAI(responseGenerationPrompt);
        break;

      case 'generate_report':
        const { sex, age_month, height_cm, weight_kg } = session;
        const ageKey = String(age_month);
        const heightLMS = lmsData[sex]?.height?.[ageKey];
        const weightLMS = lmsData[sex]?.weight?.[ageKey];

        if (age_month < 0 || age_month > 227 || !heightLMS || !weightLMS) {
          responseText = `죄송합니다. 입력해주신 ${age_month}개월에 대한 성장 데이터가 없거나, 나이가 범위를 벗어났습니다. 나이를 다시 확인해주세요.`;
          session.age_month = null; // 오류 데이터 초기화
        } else {
          const heightPercentile = calculatePercentile(height_cm, heightLMS);
          const weightPercentile = calculatePercentile(weight_kg, weightLMS);

          const reportPrompt = `
            너는 '닥터 라이키'야. 아래 데이터를 바탕으로 전문적이고 이해하기 쉬운 성장 분석 리포트를 한국어로 작성해줘.
            - **아이 정보:** 성별: ${sex}, 나이: ${age_month}개월, 키: ${height_cm}cm (${heightPercentile}%), 몸무게: ${weight_kg}kg (${weightPercentile}%)
            - **작성 지침:** "모든 정보가 확인되어 우리 아이의 성장 발달 리포트를 정리해드렸어요."로 시작해줘. \`[성장 발달 요약]\`, \`[상세 분석]\`, \`[의료진 조언]\` 헤더를 사용해서 구조적으로 작성해줘. 백분위의 의미를 명확히 설명하고, 일반적이고 긍정적인 조언을 해줘. 마지막에는 반드시 다음 주의 문구를 포함해줘: \`※ 이 결과는 2017 소아청소년 성장도표에 기반한 정보이며, 실제 의료적 진단을 대체할 수 없습니다. 정확한 진단 및 상담은 소아청소년과 전문의와 상의해주세요.\` 마지막으로 '다시 시작'을 입력하면 새로 상담할 수 있다고 안내해줘.
          `;
          responseText = await callOpenAI(reportPrompt);
          userSessions[userId] = { sex: null, age_month: null, height_cm: null, weight_kg: null }; // 세션 초기화
        }
        break;

      case 'reset':
        userSessions[userId] = { sex: null, age_month: null, height_cm: null, weight_kg: null };
        responseText = '네, 처음부터 다시 시작하겠습니다. 무엇을 도와드릴까요?';
        break;

      default:
        responseText = "죄송합니다, 어떻게 도와드려야 할지 잘 모르겠어요. 아이의 성별, 나이, 키, 몸무게 정보를 알려주시겠어요?";
    }
    
    res.json({
      version: '2.0',
      template: {
        outputs: [{ simpleText: { text: responseText } }],
      },
    });

  } catch (error) {
    console.error('스킬 처리 중 심각한 오류 발생:', error);
    res.status(500).json({
      version: '2.0',
      template: {
        outputs: [{ simpleText: { text: '죄송합니다. 시스템에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' } }],
      },
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버가 ${PORT} 포트에서 실행 중입니다.`);
});

// Vercel 배포를 위해 export
module.exports = app;
