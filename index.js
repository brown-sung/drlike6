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
    temperature: 0.7, // 창의적이고 자연스러운 응답을 위해 약간 올림
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
    // [프롬프트 개선됨] 대화 관리와 정보 추출을 통합한 지능형 프롬프트
    const mainConversationPrompt = `
      You are 'Dr. Likey', an AI pediatrician. Your task is to manage a conversation to collect a child's growth data and respond naturally.

      **Current Conversation State (Session Data):**
      ${JSON.stringify(session)}

      **User's Latest Message:**
      "${userInput}"

      **Your Task:**
      1.  **Analyze the user's message:** Is it a greeting, providing information, or something else?
      2.  **Update Data:** Extract \`sex\`, \`age_month\`, \`height_cm\`, \`weight_kg\`. Infer units if missing (e.g., if asking for height, "100" means 100cm). Update the session data. If the user wants to reset, set \`reset: true\`.
      3.  **Formulate a Response:**
          - If it's a greeting, respond with a warm welcome.
          - If information was provided, confirm it warmly (e.g., "아, 아드님이군요!") and then ask for the *next* missing piece of information.
          - If the user asks a question, answer it if you can.
          - If all data is collected, set \`isComplete: true\` in your response.
      4.  **Output Format:** Your entire output **MUST** be a single, valid JSON object with the following structure:
          \`\`\`json
          {
            "updatedData": { "sex": "male", "age_month": 10, "height_cm": 100, "weight_kg": null, "reset": false },
            "isComplete": false,
            "responseText": "네, 10개월 된 남자아이군요! 키는 100cm으로 확인됐습니다. 마지막으로 아이의 몸무게를 알려주시겠어요?"
          }
          \`\`\`
    `;
    
    const rawResponse = await callOpenAI(mainConversationPrompt, true);
    
    let aiDecision;
    try {
        aiDecision = JSON.parse(rawResponse);
    } catch (parseError) {
        console.error('AI 응답 JSON 파싱 오류:', parseError, '응답 원문:', rawResponse);
        return res.json({
            version: "2.0",
            template: { outputs: [{ simpleText: { text: "죄송합니다, 잠시 응답을 처리하는 데 문제가 생겼어요. 다시 한번 말씀해주시겠어요?" } }] }
        });
    }

    const { updatedData, isComplete, responseText } = aiDecision;

    if (updatedData?.reset) {
      userSessions[userId] = { sex: null, age_month: null, height_cm: null, weight_kg: null };
      return res.json({
        version: '2.0',
        template: { outputs: [{ simpleText: { text: '네, 처음부터 다시 시작하겠습니다. 무엇을 도와드릴까요?' } }] }
      });
    }

    // 세션 업데이트
    session = { ...session, ...updatedData };
    userSessions[userId] = session;

    let finalResponseText = responseText;

    // 모든 정보가 수집되었는지 최종 확인
    if (isComplete || (session.sex && session.age_month !== null && session.height_cm && session.weight_kg)) {
      const { sex, age_month, height_cm, weight_kg } = session;
      const ageKey = String(age_month);
      const heightLMS = lmsData[sex]?.height?.[ageKey];
      const weightLMS = lmsData[sex]?.weight?.[ageKey];

      if (age_month < 0 || age_month > 227 || !heightLMS || !weightLMS) {
        finalResponseText = `죄송합니다. 입력해주신 ${age_month}개월에 대한 성장 데이터가 없거나, 나이가 범위를 벗어났습니다. 나이를 다시 확인해주세요.`;
        session.age_month = null; // 오류 데이터 초기화
      } else {
        const heightPercentile = calculatePercentile(height_cm, heightLMS);
        const weightPercentile = calculatePercentile(weight_kg, weightLMS);

        const reportPrompt = `
          You are 'Dr. Likey', a friendly and professional AI pediatrician. Create a comprehensive growth analysis report for a parent based on the provided data. Use a structured, empathetic, and clear tone in Korean.

          **Child's Data:**
          - Sex: ${sex === 'male' ? 'Male' : 'Female'}
          - Age: ${age_month} months
          - Height: ${height_cm} cm (Percentile: ${heightPercentile}%)
          - Weight: ${weight_kg} kg (Percentile: ${weightPercentile}%)

          **Report Generation Instructions:**
          1.  Start with a warm, concluding statement like "모든 정보가 확인되어 우리 아이의 성장 발달 리포트를 정리해드렸어요."
          2.  Structure the report with these markdown headers: \`[성장 발달 요약]\`, \`[상세 분석]\`, \`[의료진 조언]\`.
          3.  In \`[상세 분석]\`, explain the percentiles clearly.
          4.  In \`[의료진 조언]\`, provide general, positive advice.
          5.  Add this mandatory disclaimer at the very end: \`※ 이 결과는 2017 소아청소년 성장도표에 기반한 정보이며, 실제 의료적 진단을 대체할 수 없습니다. 정확한 진단 및 상담은 소아청소년과 전문의와 상의해주세요.\`
          6.  Conclude by encouraging the user to start over by typing '다시 시작'.
        `;
        finalResponseText = await callOpenAI(reportPrompt);
        userSessions[userId] = { sex: null, age_month: null, height_cm: null, weight_kg: null }; // 세션 초기화
      }
    }
    
    res.json({
      version: '2.0',
      template: {
        outputs: [{ simpleText: { text: finalResponseText } }],
      },
    });

  } catch (error) {
    console.error('스킬 처리 중 심각한 오류 발생:', error.message, error.stack);
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
