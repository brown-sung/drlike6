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
    temperature: 0.5, // 일관된 JSON 출력을 위해 온도를 약간 낮춤
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
    // [구조 개선] 1. AI 분석가: 다음에 할 행동과 데이터를 결정
    const decisionPrompt = `
      You are an intelligent "router" for a pediatric chatbot. Your job is to analyze the user's message and the current data, then decide the next logical action.

      **Current Data (Session):**
      ${JSON.stringify(session)}

      **User's Message:**
      "${userInput}"

      **Your Task: Decide the next action and extract data.**
      1.  **Analyze Intent:** Is the user greeting, providing data, asking to reset, or something else?
      2.  **Extract Data:** Pull \`sex\`, \`age_month\`, \`height_cm\`, \`weight_kg\` from the user's message. Assume units (e.g., if height is missing and user says "100", that is 100cm).
      3.  **Determine Action:**
          - If the user is just greeting: \`"action": "greet"\`
          - If new data was provided but more is needed: \`"action": "confirm_and_ask_next"\`
          - If no new data was provided and some is missing: \`"action": "ask_for_missing_info"\`
          - If all data is now complete: \`"action": "generate_report"\`
          - If user wants to reset: \`"action": "reset"\`
      4.  **Output:** Respond ONLY with a valid JSON object in the following format.

      **Example 1 (Greeting):**
      User says "안녕하세요".
      Output: \`{"action": "greet", "data": {}}\`

      **Example 2 (Providing data):**
      Session has \`{"sex": "male", "age_month": null, ...}\`. User says "10개월".
      Output: \`{"action": "confirm_and_ask_next", "data": {"age_month": 10}}\`
      
      **Example 3 (All data complete):**
      Session has \`{"sex": "male", "age_month": 10, "height_cm": 100, "weight_kg": null}\`. User says "15kg".
      Output: \`{"action": "generate_report", "data": {"weight_kg": 15}}\`
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

        const responseGenerationPrompt = `
          You are 'Dr. Likey'. Generate a warm, natural response.
          - **Previously collected data:** ${JSON.stringify(session)}
          - **User's last message was:** "${userInput}"
          - **Your next goal is to ask for:** "${missingField}"
          
          Acknowledge the information the user just provided, then smoothly ask for the next piece of information.
          Example: If user just said "10개월", you could say "네, 10개월이군요! 이제 키는 몇 cm인지 알려주시겠어요?"
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
            You are 'Dr. Likey'. Create a comprehensive growth analysis report in Korean.
            - **Data:** Sex: ${sex}, Age: ${age_month}mo, Height: ${height_cm}cm (${heightPercentile}%), Weight: ${weight_kg}kg (${weightPercentile}%)
            - **Instructions:** Start with "모든 정보가 확인되어 우리 아이의 성장 발달 리포트를 정리해드렸어요." Structure with headers: \`[성장 발달 요약]\`, \`[상세 분석]\`, \`[의료진 조언]\`. Explain percentiles. Give general, positive advice. Add the mandatory disclaimer: \`※ 이 결과는 2017 소아청소년 성장도표에 기반한 정보이며, 실제 의료적 진단을 대체할 수 없습니다. 정확한 진단 및 상담은 소아청소년과 전문의와 상의해주세요.\` Conclude by suggesting to type '다시 시작'.
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
