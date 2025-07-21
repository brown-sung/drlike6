// index.js
const express = require('express');
const { jStat } = require('jstat');
const lmsData = require('./lms_data.js');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(express.json());

// --- 1. 설정: Gemini API 키 ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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
  return parseFloat(percentile.toFixed(1)); // 소수점 한 자리로 변경
}

/**
 * Gemini API를 호출하여 JSON 응답을 가져옵니다. (정보 추출 전용)
 */
async function callGeminiForDecision(session, userInput) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
  }
  const model = 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  
  // [프롬프트 최적화] 매우 간결하고 명확한 지시사항으로 변경
  const decisionPrompt = `
    Analyze the user's message based on the current session data. Decide the next action and extract specified data points.

    **Session Data:**
    ${JSON.stringify(session)}

    **User Message:**
    "${userInput}"

    **Rules:**
    1.  Extract \`sex\`, \`age_month\`, \`height_cm\`, \`weight_kg\`, \`head_circumference_cm\`.
    2.  If user wants to reset ("다시", "초기화"), set action to "reset".
    3.  If user provides info and required data (\`sex\`, \`age_month\`, and at least one of \`height_cm\`, \`weight_kg\`, \`head_circumference_cm\`) is complete, set action to "generate_report".
    4.  If user asks to analyze ("분석해줘") and required data is met, set action to "generate_report".
    5.  If user provides some info but more is needed, set action to "ask_for_info".
    6.  If the message is a simple greeting, set action to "greet".
    7.  Otherwise, set action to "ask_for_info".

    **Output:** Respond with a single, valid JSON object only. Example: \`{"action": "generate_report", "data": {"weight_kg": 8.5}}\`
  `;

  const body = {
    contents: [{ role: 'user', parts: [{ text: decisionPrompt }] }],
    generationConfig: {
      temperature: 0.0,
      response_mime_type: "application/json",
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Gemini API 오류: ${response.status}`, errorBody);
    throw new Error('Gemini API 호출 실패');
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

// 루트 경로 핸들러
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`
    <!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>서버 실행 중</title></head>
    <body style="font-family: sans-serif; text-align: center; padding: 40px;">
      <h1 style="color: #4CAF50;">✅ 서버가 정상적으로 실행 중입니다</h1>
    </body></html>
  `);
});

// 카카오톡 스킬 API 엔드포인트
app.post('/skill', async (req, res) => {
  const userId = req.body.userRequest.user.id;
  const userInput = req.body.userRequest.utterance;

  let session = userSessions[userId] || { sex: null, age_month: null, height_cm: null, weight_kg: null, head_circumference_cm: null };

  try {
    const rawDecision = await callGeminiForDecision(session, userInput);
    const decision = JSON.parse(rawDecision);

    if (decision.data) {
      session = { ...session, ...decision.data };
    }
    userSessions[userId] = session;
    
    let responseText = '';

    switch (decision.action) {
      case 'greet':
        responseText = '안녕하세요. 아이의 성별, 나이(개월), 키, 몸무게 등을 알려주세요.';
        break;
        
      // [수정] AI 호출을 제거하고, 코드 기반의 확정적인 답변으로 변경하여 속도 개선
      case 'ask_for_info':
        if (!session.sex) {
          responseText = '성별을 알려주세요. (예: 남자)';
        } else if (!session.age_month) {
          responseText = '나이를 개월 수로 알려주세요. (예: 10개월)';
        } else {
          responseText = "키, 몸무게, 머리둘레 정보를 알려주시거나, '분석'이라고 말씀해주세요.";
        }
        break;

      // [수정] AI 리포트 생성을 제거하고, 코드에서 직접 결과 문자열을 생성
      case 'generate_report':
        const { sex, age_month, height_cm, weight_kg, head_circumference_cm } = session;
        const ageKey = String(age_month);
        
        const reportLines = ['[성장 발달 분석 결과]'];

        if (height_cm && height_cm !== 'skipped') {
          const lms = lmsData[sex]?.height?.[ageKey];
          const percentile = lms ? calculatePercentile(height_cm, lms) : null;
          reportLines.push(`- 키: ${height_cm}cm` + (percentile !== null ? ` (상위 ${percentile}%)` : ' (백분위 데이터 없음)'));
        }
        if (weight_kg && weight_kg !== 'skipped') {
          const lms = lmsData[sex]?.weight?.[ageKey];
          const percentile = lms ? calculatePercentile(weight_kg, lms) : null;
          reportLines.push(`- 몸무게: ${weight_kg}kg` + (percentile !== null ? ` (상위 ${percentile}%)` : ' (백분위 데이터 없음)'));
        }
        if (head_circumference_cm && head_circumference_cm !== 'skipped') {
          // 현재 머리둘레 데이터가 없으므로 백분위는 계산하지 않음
          reportLines.push(`- 머리둘레: ${head_circumference_cm}cm`);
        }

        if (reportLines.length === 1) {
             responseText = "분석할 데이터가 부족합니다. 키, 몸무게, 머리둘레 중 하나 이상의 정보를 입력해주세요.";
        } else {
             reportLines.push("\n분석이 완료되었습니다. 초기화를 원하시면 '다시'라고 말씀해주세요.");
             responseText = reportLines.join('\n');
             userSessions[userId] = null; // 세션 초기화
        }
        break;

      case 'reset':
        userSessions[userId] = null;
        responseText = '네, 처음부터 다시 시작하겠습니다. 아이 정보를 알려주세요.';
        break;

      default:
        responseText = "정보를 이해하지 못했어요. '남자 12개월 키 80cm' 와 같이 알려주세요.";
    }
    
    res.json({
      version: '2.0',
      template: { outputs: [{ simpleText: { text: responseText } }] },
    });

  } catch (error) {
    console.error('스킬 처리 중 오류 발생:', error);
    res.status(500).json({
      version: '2.0',
      template: { outputs: [{ simpleText: { text: '오류가 발생했습니다. 잠시 후 다시 시도해주세요.' } }] },
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버가 ${PORT} 포트에서 실행 중입니다.`));

module.exports = app;
