const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { jStat } = require('jstat');

// node-fetch is an ESM-only module from v3, so we use a dynamic import
// for compatibility with CommonJS (require).
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(express.json());

// --- 1. 설정: 환경변수에서 OpenAI API 키 가져오기 ---
// Vercel 프로젝트 설정에서 OPENAI_API_KEY를 반드시 추가해야 합니다.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- 2. LMS 데이터 로드 ---
const lmsData = {
  male: { height: {}, weight: {} },
  female: { height: {}, weight: {} },
};

/**
 * Loads LMS data from CSV files into memory.
 * CSV 파일에서 LMS 데이터를 메모리로 로드합니다.
 */
function loadData() {
  try {
    const files = {
      male_height: 'male_height.csv',
      male_weight: 'male_weight.csv',
      female_height: 'female_height.csv',
      female_weight: 'female_weight.csv',
    };

    for (const [key, filename] of Object.entries(files)) {
      const [sex, type] = key.split('_');
      // Use path.join for robust file path resolution
      const filePath = path.join(__dirname, filename);
      const csvData = fs.readFileSync(filePath, 'utf8');
      const records = parse(csvData, { columns: true, skip_empty_lines: true });

      records.forEach(record => {
        // 'Month' 컬럼의 숫자 값을 키로 사용합니다.
        lmsData[sex][type][record.Month] = {
          L: parseFloat(record.L),
          M: parseFloat(record.M),
          S: parseFloat(record.S),
        };
      });
    }
    console.log('LMS 데이터 로딩 완료.');
  } catch (error) {
    console.error('CSV 파일 로딩 중 오류 발생:', error);
    // In a production environment, proper error handling and notifications are needed.
    // 운영 환경에서는 적절한 오류 처리 및 알림이 필요합니다.
    process.exit(1);
  }
}

// --- 3. 대화 상태 저장을 위한 메모리 내 세션 ---
// (주의) 실제 프로덕션 환경에서는 Vercel KV나 Redis 같은 외부 DB 사용을 권장합니다.
// This is for demonstration purposes. For production, use an external database.
const userSessions = {};

/**
 * Calculates the percentile for a given value using LMS parameters.
 * LMS 파라미터를 사용하여 주어진 값의 백분위를 계산합니다.
 * @param {number} value - The value to calculate (height or weight).
 * @param {object} lms - The LMS parameters { L, M, S }.
 * @returns {number|null} The calculated percentile or null if LMS data is missing.
 */
function calculatePercentile(value, lms) {
  if (!lms) return null;
  const { L, M, S } = lms;
  let zScore;

  // LMS 공식을 사용하여 Z-score 계산
  if (L !== 0) {
    zScore = (Math.pow(value / M, L) - 1) / (L * S);
  } else {
    // L이 0일 경우의 특수 공식
    zScore = Math.log(value / M) / S;
  }

  // Z-score를 백분위로 변환 (소수점 2자리까지)
  const percentile = jStat.normal.cdf(zScore, 0, 1) * 100;
  return parseFloat(percentile.toFixed(2));
}

/**
 * Calls the OpenAI API to get a response.
 * OpenAI API를 호출하여 응답을 가져옵니다.
 * @param {string} prompt - The prompt to send to the AI.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function callOpenAI(prompt) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.');
  }
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o', // 최신 모델 사용 권장
      messages: [{ role: 'system', content: 'You are a helpful assistant for a chatbot.' }, { role: 'user', content: prompt }],
      temperature: 0.5, // 약간의 창의성을 부여하되 일관성을 유지
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`OpenAI API 오류: ${response.status} ${response.statusText}`, errorBody);
    throw new Error('OpenAI API 호출에 실패했습니다.');
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// --- 6. 카카오톡 스킬 API 엔드포인트 ---
app.post('/api/skill', async (req, res) => {
  const userId = req.body.userRequest.user.id;
  const userInput = req.body.userRequest.utterance;

  // Get or create a new session
  let session = userSessions[userId] || {};
  userSessions[userId] = session; // Update session reference

  try {
    // 1. Extract information from user input using AI
    const extractionPrompt = `
      너는 사용자 대화에서 아이의 성장 관련 정보를 추출하는 AI야.
      대화 내용: "${userInput}"
      현재까지 수집된 정보: ${JSON.stringify(session)}
      위 대화 내용에서 성별(male/female), 나이(개월 수), 키(cm), 몸무게(kg) 정보를 JSON 형식으로 추출해줘. 정보가 없다면 null로 표시해.
      나이는 반드시 0 이상의 정수인 개월 수로 변환해야 해 (예: "두 돌", "24개월" -> 24).
      '초기화', '리셋', '다시', '처음부터' 같은 단어가 있으면 모든 정보를 초기화해야 하므로 {"reset": true} 를 반환해줘.
      예시: {"sex": "male", "age_month": 36, "height_cm": 95.5, "weight_kg": 14.2}
      추출된 정보만 JSON 객체로 반환하고 다른 말은 절대 하지 마.
    `;
    const extractedJsonString = await callOpenAI(extractionPrompt);
    const extractedData = JSON.parse(extractedJsonString.trim());
    
    if (extractedData.reset) {
      session = {};
      userSessions[userId] = session;
      return res.json({
        version: '2.0',
        template: { outputs: [{ simpleText: { text: '네, 정보를 초기화하고 처음부터 다시 시작하겠습니다. 아이의 성별과 나이(개월 수)를 알려주시겠어요?' } }] }
      });
    }

    // Update session with extracted data
    session.sex = extractedData.sex || session.sex;
    session.age_month = extractedData.age_month !== null ? extractedData.age_month : session.age_month;
    session.height_cm = extractedData.height_cm || session.height_cm;
    session.weight_kg = extractedData.weight_kg || session.weight_kg;

    let responseText = '';

    // 2. Check if all information has been collected
    if (session.sex && session.age_month !== undefined && session.height_cm && session.weight_kg) {
      const { sex, age_month, height_cm, weight_kg } = session;

      // Validate data range (0-227 months)
      if (age_month < 0 || age_month > 227) {
        responseText = '죄송하지만, 만 18세(227개월)까지의 정보만 조회할 수 있습니다. 나이를 다시 확인해주시겠어요?';
        session.age_month = undefined; // Reset invalid data
      } else {
        const heightLMS = lmsData[sex].height[age_month];
        const weightLMS = lmsData[sex].weight[age_month];
        
        const heightPercentile = calculatePercentile(height_cm, heightLMS);
        const weightPercentile = calculatePercentile(weight_kg, weightLMS);

        // 3. Generate the final report using AI
        const reportPrompt = `
          너는 친절하고 전문적인 소아청소년과 상담가 AI야.
          아래 데이터를 바탕으로 부모님께 아이의 성장 발달 상태를 설명하는 최종 리포트를 작성해줘.
          - 역할: 따뜻하고 이해하기 쉬운 말투의 상담가
          - 데이터:
            - 성별: ${sex === 'male' ? '남자아이' : '여자아이'}
            - 나이: ${age_month}개월
            - 키: ${height_cm}cm (상위 ${heightPercentile}%)
            - 몸무게: ${weight_kg}kg (상위 ${weightPercentile}%)
          - 지침:
            1. 아이의 정보를 먼저 요약해줘.
            2. 키와 몸무게 백분위 수치를 명확히 알려줘.
            3. 백분위의 의미를 설명해줘. (예: "상위 15%는 같은 성별과 나이의 아이 100명 중 15번째로 크다는 의미예요.")
            4. 긍정적이고 격려하는 말로 마무리해줘.
            5. "성장 발달에 대해 더 궁금한 점이 있으시면 언제든지 다시 찾아주세요." 라는 문구를 포함해줘.
            6. "다시 상담하시려면 '다시 시작' 또는 '초기화'라고 입력해주세요." 라는 안내를 추가해줘.
        `;
        responseText = await callOpenAI(reportPrompt);
        
        // Reset session after consultation is complete
        userSessions[userId] = {}; 
      }
    } else {
      // 4. Generate a question to ask for missing information
      let nextQuestion = '';
      if (!session.sex) nextQuestion = '아이의 성별을 알려주시겠어요? (남자/여자)';
      else if (session.age_month === undefined) nextQuestion = '아이의 나이를 개월 수로 알려주세요. (예: 18개월)';
      else if (!session.height_cm) nextQuestion = '아이의 키(cm)는 얼마인가요?';
      else if (!session.weight_kg) nextQuestion = '아이의 몸무게(kg)는 얼마인가요?';
      
      const questionPrompt = `
        너는 친절한 소아과 상담가 AI야.
        사용자와 대화하며 아이의 성장 정보를 자연스럽게 물어봐줘.
        - 이전 대화: "${userInput}"
        - 다음에 물어볼 질문: "${nextQuestion}"
        - 현재까지 수집된 정보: ${JSON.stringify(session)}
        위 정보를 바탕으로, 사용자에게 다음 질문을 자연스럽고 친절한 말투로 물어봐줘.
        (예: "네, 남자아이군요! 그럼 나이는 몇 개월인가요?")
        질문만 간결하게 생성하고 다른 말은 덧붙이지 마.
      `;
      responseText = await callOpenAI(questionPrompt);
    }

    // Format the final response for KakaoTalk
    res.json({
      version: '2.0',
      template: {
        outputs: [{ simpleText: { text: responseText } }],
      },
    });

  } catch (error) {
    console.error('스킬 처리 중 오류:', error);
    res.status(500).json({
      version: '2.0',
      template: {
        outputs: [{ simpleText: { text: '죄송합니다. 시스템에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' } }],
      },
    });
  }
});

// Server startup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  loadData(); // Load data on server start
  console.log(`서버가 ${PORT} 포트에서 실행 중입니다.`);
});

// Export the app for Vercel
module.exports = app;
