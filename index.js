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
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: 'You are a helpful and empathetic AI assistant named Dr.LIKE, specializing in pediatric growth analysis. Your primary language is Korean.' }, { role: 'user', content: prompt }],
    temperature: 0.3,
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
      <p>성장 발달 챗봇 '닥터라이크'가 성공적으로 배포되었습니다.</p>
    </body>
    </html>
  `);
});


// 카카오톡 스킬 API 엔드포인트
app.post('/skill', async (req, res) => {
  const userId = req.body.userRequest.user.id;
  const userInput = req.body.userRequest.utterance;

  let session = userSessions[userId] || { sex: null, age_month: null, height_cm: null, weight_kg: null, head_circumference_cm: null };

  try {
    // [프롬프트 개선] 1. AI 분석가: 즉시 분석 규칙 강화
    const decisionPrompt = `
      너는 '닥터라이크' 챗봇의 핵심 두뇌야. 사용자의 메시지와 현재 대화 상태를 분석해서, 다음에 할 가장 논리적인 행동을 결정해야 해.

      **현재 데이터 (세션):**
      ${JSON.stringify(session)}

      **사용자 메시지:**
      "${userInput}"

      **최소 정보 규칙:**
      - **필수 정보 (반드시 필요):** \`sex\`, \`age_month\`
      - **선택 정보 (셋 중 하나 이상 필요):** \`height_cm\`, \`weight_kg\`, \`head_circumference_cm\`

      **너의 임무: 다음 행동을 결정하고 데이터를 추출해라.**
      1.  **의도 분석**: 사용자가 인사를 하는지, 정보를 제공하는지, 질문을 건너뛰려 하는지("몰라요", "패스"), 분석을 요청하는지("분석해줘"), 주제와 무관한 질문을 하는지, 초기화를 원하는지 등을 분석해.
      2.  **데이터 추출**: 사용자 메시지에서 \`sex\`, \`age_month\`, \`height_cm\`, \`weight_kg\`, \`head_circumference_cm\`를 추출해.
      3.  **행동 결정**:
          - **가장 중요한 규칙**: 사용자가 "분석해줘"라고 말하거나, **'최소 정보 규칙'이 이미 충족된 상태에서** 정보를 건너뛰려 하거나, 더 이상 줄 정보가 없다고 말하면, 행동을 반드시 \`"action": "generate_report"\` 로 결정해야 해.
          - 단순 인사일 경우: \`"action": "greet"\`
          - 주제와 무관한 질문일 경우: \`"action": "handle_off_topic"\`
          - 그 외, 추가 정보가 필요한 모든 경우: \`"action": "ask_for_info"\`
          - 사용자가 "다시", "초기화" 등 리셋을 원할 경우: \`"action": "reset"\`
      4.  **출력**: 반드시 다음 형식의 유효한 JSON 객체 하나만 다른 설명 없이 응답해야 해.

      **예시 (즉시 분석):**
      세션에 \`{"sex": "male", "age_month": 10, "height_cm": 100, "weight_kg": null, ...}\`가 있고, 사용자가 "몸무게는 몰라요" 라고 말함.
      출력: \`{"action": "generate_report", "data": {"weight_kg": "skipped"}}\`
    `;
    
    const rawDecision = await callOpenAI(decisionPrompt, true);
    const decision = JSON.parse(rawDecision);

    // 세션 업데이트
    if (decision.data) {
        for (const key in decision.data) {
            if (decision.data[key] !== null) {
                session[key] = decision.data[key];
            }
        }
    }
    userSessions[userId] = session;
    
    let responseText = '';

    // 결정된 행동(action)에 따라 응답 생성
    switch (decision.action) {
      case 'greet':
        responseText = '안녕하세요! 우리 아이 성장 발달, 저 닥터라이크에게 편하게 물어보세요. 아이의 성별과 나이부터 알려주시겠어요?';
        break;
        
      case 'handle_off_topic':
        const offTopicPrompt = `
            너는 '닥터라이크'야. 사용자가 너의 역할과 관련 없는 질문을 했어.
            - **사용자 질문:** "${userInput}"
            
            너의 역할("소아청소년 성장 발달 AI")에 대해 간단히 소개하고, 자연스럽게 성장 발달에 대한 질문을 유도하는 짧은 답변을 생성해줘.
        `;
        responseText = await callOpenAI(offTopicPrompt);
        break;

      case 'ask_for_info':
        const hasOptionalInfo = session.height_cm || session.weight_kg || session.head_circumference_cm;
        const responseGenerationPrompt = `
          너는 '닥터라이크'야. 따뜻하고 자연스러운 한국어 응답을 생성해야 해.
          - **현재까지 수집된 정보:** ${JSON.stringify(session)}
          - **사용자의 마지막 말:** "${userInput}"
          
          **상황에 맞는 응답 생성:**
          - **만약 선택 정보가 하나도 없다면,** 사용자에게 최소 정보 규칙을 안내해줘. (예: "네, ${session.age_month}개월이군요. 정확한 분석을 위해 키, 몸무게, 머리둘레 중 확인하고 싶은 정보를 한 가지 이상 알려주시겠어요?")
          - **만약 선택 정보가 이미 있다면,** 사용자에게 추가 정보를 물어봐줘. (예: "네, 키는 100cm이군요! 혹시 몸무게도 알고 계시면 알려주시겠어요? 원치 않으시면 '분석해줘'라고 말씀해주세요.")
        `;
        responseText = await callOpenAI(responseGenerationPrompt);
        break;

      case 'generate_report':
        const { sex, age_month, height_cm, weight_kg, head_circumference_cm } = session;
        
        let reportData = { 성별: sex, 나이: `${age_month}개월` };
        const ageKey = String(age_month);

        if(height_cm && height_cm !== 'skipped') {
            const lms = lmsData[sex]?.height?.[ageKey];
            reportData['키'] = lms ? `${height_cm}cm (상위 ${calculatePercentile(height_cm, lms)}%)` : `${height_cm}cm (데이터 없음)`;
        }
        if(weight_kg && weight_kg !== 'skipped') {
            const lms = lmsData[sex]?.weight?.[ageKey];
            reportData['몸무게'] = lms ? `${weight_kg}kg (상위 ${calculatePercentile(weight_kg, lms)}%)` : `${weight_kg}kg (데이터 없음)`;
        }
        if(head_circumference_cm && head_circumference_cm !== 'skipped') {
            // 머리둘레 데이터는 현재 제공된 CSV에 없으므로, 백분위 계산은 제외
            reportData['머리둘레'] = `${head_circumference_cm}cm`;
        }

        const reportPrompt = `
          너는 '닥터라이크'야. 아래 데이터를 바탕으로 전문적이고 이해하기 쉬운 성장 분석 리포트를 한국어로 작성해줘.
          - **아이 정보:** ${JSON.stringify(reportData)}
          - **작성 지침:** "모든 정보가 확인되어 우리 아이의 성장 발달 리포트를 정리해드렸어요."로 시작해줘. 제공된 정보만으로 리포트를 작성해야 해. \`[성장 발달 요약]\`, \`[상세 분석]\`, \`[의료진 조언]\` 헤더를 사용해서 구조적으로 작성해줘. 마지막에는 반드시 다음 주의 문구를 포함해줘: \`※ 이 결과는 2017 소아청소년 성장도표에 기반한 정보이며, 실제 의료적 진단을 대체할 수 없습니다. 정확한 진단 및 상담은 소아청소년과 전문의와 상의해주세요.\` 마지막으로 "다른 아이의 성장 발달이 궁금하시거나, 다시 상담을 시작하시려면 '다시 시작'이라고 말씀해주세요." 라고 안내해줘.
        `;
        responseText = await callOpenAI(reportPrompt);
        userSessions[userId] = null; // 세션 초기화
        break;

      case 'reset':
        userSessions[userId] = null;
        responseText = '네, 처음부터 다시 시작하겠습니다. 무엇을 도와드릴까요?';
        break;

      default:
        responseText = "죄송합니다, 어떻게 도와드려야 할지 잘 모르겠어요. 아이의 성별, 나이, 키, 몸무게, 머리둘레 정보를 알려주시겠어요?";
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
