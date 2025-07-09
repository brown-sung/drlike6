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
    messages: [{ role: 'system', content: 'You are a helpful assistant for a chatbot in Korean.' }, { role: 'user', content: prompt }],
    temperature: 0.5,
  };

  // JSON 모드 요청 시 response_format 파라미터 추가
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

  let session = userSessions[userId] || {};
  userSessions[userId] = session;

  try {
    // [프롬프트 개선됨] 정보 추출 프롬프트: 페르소나와 규칙 강화
    const extractionPrompt = `
      You are a data extraction specialist for a pediatric AI assistant. Your task is to analyze the user's message and previously collected data to extract key information into a JSON object.

      **User's message:** "${userInput}"
      **Previously collected data:** ${JSON.stringify(session)}
      
      **Extraction Rules:**
      1.  **Extract the following fields:**
          - \`sex\`: Must be 'male' or 'female'.
          - \`age_month\`: Must be an integer representing the age in months. (e.g., "두 돌", "24개월" -> 24).
          - \`height_cm\`: Must be a number.
          - \`weight_kg\`: Must be a number.
      2.  If a piece of information is not present in the new message, its value in the JSON should be \`null\`.
      3.  If the user's message contains words like '초기화', '리셋', '다시', '처음부터', you must return only \`{"reset": true}\`.
      4.  Your output **MUST** be a valid JSON object and nothing else.

      **Example Output:**
      \`\`\`json
      {"sex": "male", "age_month": 10, "height_cm": null, "weight_kg": null}
      \`\`\`
    `;
    const rawResponse = await callOpenAI(extractionPrompt, true);
    
    let extractedData;
    try {
        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("응답에서 JSON 객체를 찾을 수 없습니다.");
        }
        extractedData = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
        console.error('JSON 파싱 오류:', parseError, '응답 원문:', rawResponse);
        return res.json({
            version: "2.0",
            template: {
                outputs: [{
                    simpleText: { text: "죄송합니다, 잠시 정보를 처리하는 데 문제가 생겼어요. 조금 다르게 다시 말씀해주시겠어요?" }
                }]
            }
        });
    }
    
    if (extractedData.reset) {
      session = {};
      userSessions[userId] = session;
      return res.json({
        version: '2.0',
        template: { outputs: [{ simpleText: { text: '네, 정보를 초기화하고 처음부터 다시 시작하겠습니다. 아이의 성별과 나이(개월 수)를 알려주시겠어요?' } }] }
      });
    }

    session.sex = extractedData.sex || session.sex;
    session.age_month = extractedData.age_month !== null && extractedData.age_month !== undefined ? extractedData.age_month : session.age_month;
    session.height_cm = extractedData.height_cm || session.height_cm;
    session.weight_kg = extractedData.weight_kg || session.weight_kg;

    let responseText = '';

    if (session.sex && session.age_month !== undefined && session.height_cm && session.weight_kg) {
      const { sex, age_month, height_cm, weight_kg } = session;

      if (age_month < 0 || age_month > 227) {
        responseText = '죄송하지만, 만 18세(227개월)까지의 정보만 조회할 수 있습니다. 나이를 다시 확인해주시겠어요?';
        session.age_month = undefined;
      } else {
        const ageKey = String(age_month);
        const heightLMS = lmsData[sex]?.height?.[ageKey];
        const weightLMS = lmsData[sex]?.weight?.[ageKey];
        
        if (!heightLMS || !weightLMS) {
            responseText = `죄송합니다. 입력해주신 ${age_month}개월에 대한 성장 데이터가 없습니다. 나이를 다시 확인해주세요.`;
        } else {
            const heightPercentile = calculatePercentile(height_cm, heightLMS);
            const weightPercentile = calculatePercentile(weight_kg, weightLMS);

            // [프롬프트 개선됨] 최종 리포트 프롬프트: 전문성과 신뢰도 강화
            const reportPrompt = `
              You are 'Dr. Likey', a friendly and professional AI pediatrician. Your task is to create a comprehensive growth analysis report for a parent based on the data provided. Use a structured, empathetic, and clear tone.

              **Child's Data:**
              - Sex: ${sex === 'male' ? 'Male' : 'Female'}
              - Age: ${age_month} months
              - Height: ${height_cm} cm (Percentile: ${heightPercentile}%)
              - Weight: ${weight_kg} kg (Percentile: ${weightPercentile}%)

              **Report Generation Instructions:**
              1.  **Start with a warm greeting.**
              2.  **Structure the report with the following markdown headers in Korean:**
                  - \`[성장 발달 요약]\`: Briefly summarize the child's information.
                  - \`[상세 분석]\`: Explain the height and weight percentiles clearly. Describe what a percentile means (e.g., "A height percentile of 75% means the child is taller than 75 out of 100 peers of the same age and sex.").
                  - \`[의료진 조언]\`: Provide general, positive advice. Mention the importance of balanced nutrition, regular sleep, and physical activity. **Do not give any specific medical diagnosis.**
              3.  **Add a mandatory disclaimer at the very end.** It must be formatted exactly as follows, including the symbol:
                  \`※ 이 결과는 2017 소아청소년 성장도표에 기반한 정보이며, 실제 의료적 진단을 대체할 수 없습니다. 정확한 진단 및 상담은 소아청소년과 전문의와 상의해주세요.\`
              4.  **Conclude** by encouraging the user to ask more questions or start over by typing '다시 시작'.
            `;
            responseText = await callOpenAI(reportPrompt);
            userSessions[userId] = {}; 
        }
      }
    } else {
      // [프롬프트 개선됨] 질문 유도 프롬프트: 능동적이고 친절한 대화
      let nextQuestion = '';
      let guideText = '';
      if (!session.sex) {
        nextQuestion = '아이의 성별을 알려주시겠어요?';
        guideText = '안녕하세요! 우리 아이 성장 발달, 저에게 편하게 물어보세요. 먼저 아이의 성별을 알려주시겠어요?';
      } else if (session.age_month === undefined) {
        nextQuestion = '아이의 나이를 개월 수로 알려주세요. (예: 18개월)';
        guideText = `네, ${session.sex === 'male' ? '남자' : '여자'}아이군요. 반갑습니다! 정확한 비교를 위해 아이가 현재 몇 개월인지 알려주시겠어요? (예: 15개월, 24개월)`;
      } else if (!session.height_cm) {
        nextQuestion = '아이의 키(cm)는 얼마인가요?';
        guideText = `네, ${session.age_month}개월이군요. 이제 거의 다 됐어요! 아이의 현재 키는 몇 cm 인가요?`;
      } else if (!session.weight_kg) {
        nextQuestion = '아이의 몸무게(kg)는 얼마인가요?';
        guideText = `키는 ${session.height_cm}cm 이군요. 마지막으로 아이의 몸무게(kg)를 알려주세요.`;
      }
      
      const questionPrompt = `
        You are 'Dr. Likey', a friendly and professional AI pediatrician. Your goal is to make the user feel comfortable and guide them to provide the necessary information.

        **Context:**
        - You have already greeted the user or processed their previous input.
        - The guiding text you should deliver is: "${guideText}"
        
        **Task:**
        - Deliver the guiding text naturally and warmly to the user.
        - Ensure your response is just the text, without any extra conversation or labels.
      `;
      responseText = await callOpenAI(questionPrompt);
    }

    res.json({
      version: '2.0',
      template: {
        outputs: [{ simpleText: { text: responseText } }],
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
