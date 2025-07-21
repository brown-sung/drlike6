// index.js (최종 수정본)
const express = require('express');
const { jStat } = require('jstat');
const lmsData = require('./lms_data.js');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

console.log("LMS 데이터가 코드를 통해 로드되었습니다.");

const userSessions = {};

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
  return parseFloat(percentile.toFixed(1));
}

/**
 * [프롬프트 최적화] 복잡한 규칙을 포함한 정보 추출 및 행동 결정 전용 Gemini 호출
 */
async function callGeminiForDecision(session, userInput) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
  
  const model = 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  
  // 사용자의 다양한 입력을 처리하기 위한 초경량/고속 프롬프트
  const decisionPrompt = `
    Your task is to extract data from the user's message based on the session and decide an action.

    **Session Data:**
    ${JSON.stringify(session)}

    **User Message:**
    "${userInput}"

    **Extraction Rules:**
    - \`sex\`: "남자" -> "male", "여자" -> "female".
    - \`age_month\`: Convert years ("살", "세") to months (e.g., "3살" -> 36). If just a number, assume months.
    - \`height_cm\`, \`weight_kg\`: If two numbers like "100, 15" are given, infer the larger is height and smaller is weight. Extract numbers even if units are present.
    - An existing value in the session can be overwritten by new user input.

    **Action Rules:**
    - "reset": If the user wants to start over ("다시", "초기화").
    - "generate_report": If \`sex\`, \`age_month\`, and at least one of \`height_cm\` or \`weight_kg\` are present after extraction, OR if the user explicitly asks to "분석".
    - "ask_for_info": If essential information is still missing.
    - "greet": For simple greetings.

    **Output:** Respond ONLY with a valid JSON object.
    Example -> User: "우리 아들 3살인데 15키로야" -> Output: \`{"action": "ask_for_info", "data": {"sex": "male", "age_month": 36, "weight_kg": 15}}\`
  `;

  const body = {
    contents: [{ role: 'user', parts: [{ text: decisionPrompt }] }],
    generationConfig: {
      temperature: 0.0,
      response_mime_type: "application/json",
    },
    // 시스템 메시지 대신 프롬프트에 모든 규칙을 통합하여 속도 최적화
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
  res.status(200).send('✅ 서버가 정상적으로 실행 중입니다');
});

// 카카오톡 스킬 API 엔드포인트
app.post('/skill', async (req, res) => {
  const userId = req.body.userRequest.user.id;
  const userInput = req.body.userRequest.utterance;

  // 머리둘레 삭제
  let session = userSessions[userId] || { sex: null, age_month: null, height_cm: null, weight_kg: null };

  try {
    const rawDecision = await callGeminiForDecision(session, userInput);
    const decision = JSON.parse(rawDecision);

    // AI가 추출한 데이터가 있으면 세션에 덮어쓰기
    if (decision.data) {
      session = { ...session, ...decision.data };
    }
    userSessions[userId] = session;
    
    let responseText = '';

    switch (decision.action) {
      case 'greet':
        responseText = '안녕하세요. 아이의 성별, 나이, 키, 몸무게를 알려주세요.';
        break;
        
      // [수정] 순차적 질문 로직 강화
      case 'ask_for_info':
        if (!session.sex) {
          responseText = '아이의 성별을 알려주세요. (예: 남자)';
        } else if (!session.age_month) {
          responseText = '나이를 알려주세요. (예: 15개월 또는 3살)';
        } else {
          responseText = "키와 몸무게를 알려주세요. (예: 80cm 11kg)";
        }
        break;

      // [수정] 머리둘레 삭제
      case 'generate_report':
        const { sex, age_month, height_cm, weight_kg } = session;
        
        if (!sex || !age_month || (!height_cm && !weight_kg)) {
            responseText = "분석을 위해 아이의 성별, 나이, 그리고 키나 몸무게 정보가 필요해요. 다시 알려주시겠어요?";
            userSessions[userId] = null; // 정보 부족 시 초기화
            break;
        }

        const ageKey = String(age_month);
        const reportLines = ['[성장 발달 분석 결과]'];

        if (height_cm && height_cm !== 'skipped') {
          const lms = lmsData[sex]?.height?.[ageKey];
          const percentile = lms ? calculatePercentile(height_cm, lms) : null;
          reportLines.push(`- 키: ${height_cm}cm` + (percentile !== null ? ` (상위 ${percentile}%)` : ` (${age_month}개월 데이터 없음)`));
        }
        if (weight_kg && weight_kg !== 'skipped') {
          const lms = lmsData[sex]?.weight?.[ageKey];
          const percentile = lms ? calculatePercentile(weight_kg, lms) : null;
          reportLines.push(`- 몸무게: ${weight_kg}kg` + (percentile !== null ? ` (상위 ${percentile}%)` : ` (${age_month}개월 데이터 없음)`));
        }
        
        reportLines.push("\n분석이 완료되었습니다. 초기화를 원하시면 '다시'라고 말씀해주세요.");
        responseText = reportLines.join('\n');
        userSessions[userId] = null; // 분석 완료 후 세션 초기화
        break;

      case 'reset':
        userSessions[userId] = null;
        responseText = '네, 처음부터 다시 시작하겠습니다. 아이 정보를 알려주세요.';
        break;

      default:
        responseText = "정보를 이해하지 못했어요. '남자 3살 키 100cm' 와 같이 다시 알려주세요.";
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
