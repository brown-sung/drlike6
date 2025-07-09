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
      // [수정됨] Vercel 환경에서 안정적으로 파일을 찾기 위해 process.cwd() 사용
      // process.cwd()는 프로젝트의 루트 디렉토리를 가리킵니다.
      const filePath = path.join(process.cwd(), filename);
      
      if (!fs.existsSync(filePath)) {
         throw new Error(`CSV 파일을 찾을 수 없습니다. 프로젝트 루트에 파일이 있는지 확인하세요: ${filename}`);
      }

      const csvData = fs.readFileSync(filePath, 'utf8');
      const records = parse(csvData, { columns: true, skip_empty_lines: true });

      records.forEach(record => {
        lmsData[sex][type][record.Month] = {
          L: parseFloat(record.L),
          M: parseFloat(record.M),
          S: parseFloat(record.S),
        };
      });
    }
    console.log('LMS 데이터 로딩 완료.');
  } catch (error) {
    console.error('CSV 파일 로딩 중 치명적 오류 발생:', error);
    process.exit(1);
  }
}

// --- 3. 대화 상태 저장을 위한 메모리 내 세션 ---
const userSessions = {};

/**
 * Calculates the percentile for a given value using LMS parameters.
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
 * Calls the OpenAI API to get a response.
 * OpenAI API를 호출하여 응답을 가져옵니다.
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
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'You are a helpful assistant for a chatbot.' }, { role: 'user', content: prompt }],
      temperature: 0.5,
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

// 루트 경로 핸들러
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: '성장 발달 챗봇 서버가 정상적으로 실행 중입니다. 카카오톡 채널에서 이용해주세요.'
  });
});


// [수정됨] 카카오톡 스킬 API 엔드포인트 경로를 /skill로 변경
app.post('/skill', async (req, res) => {
  const userId = req.body.userRequest.user.id;
  const userInput = req.body.userRequest.utterance;

  let session = userSessions[userId] || {};
  userSessions[userId] = session;

  try {
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
    
    let extractedData;
    try {
        extractedData = JSON.parse(extractedJsonString.trim());
    } catch (parseError) {
        console.error('OpenAI 응답 JSON 파싱 오류:', parseError, '응답 원문:', extractedJsonString);
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
        const heightLMS = lmsData[sex].height[age_month];
        const weightLMS = lmsData[sex].weight[age_month];
        
        if (!heightLMS || !weightLMS) {
            responseText = `죄송합니다. ${age_month}개월에 대한 성장 데이터가 없습니다. 나이를 다시 확인해주세요.`;
        } else {
            const heightPercentile = calculatePercentile(height_cm, heightLMS);
            const weightPercentile = calculatePercentile(weight_kg, weightLMS);

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
            userSessions[userId] = {}; 
        }
      }
    } else {
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

// 서버 시작 전 데이터 로딩
loadData(); 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버가 ${PORT} 포트에서 실행 중입니다.`);
});

// Vercel 배포를 위해 export
module.exports = app;
