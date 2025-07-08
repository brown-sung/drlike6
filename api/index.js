const express = require('express');
const { kv } = require('@vercel/kv');
const { createSimpleTextResponse } = require('../utils');
const stateHandlers = require('../handlers');

const app = express();
app.use(express.json());

// 카카오톡 스킬 요청 처리 엔드포인트
app.post("/api/skill", async (req, res) => {
    try {
        const userKey = req.body.userRequest?.user?.id;
        const utterance = req.body.userRequest?.utterance?.trim();

        if (!userKey || !utterance) {
            return res.status(400).json({ error: "Invalid request: userKey or utterance is missing." });
        }
        
        // Vercel KV에서 사용자 데이터 조회 (없으면 초기 상태로 생성)
        const userData = await kv.get(userKey) || { 
            state: 'greeting', 
            history: [],
            collectedInfo: {} 
        };
        
        const { state, history, collectedInfo } = userData;

        // 현재 상태에 맞는 핸들러 호출
        const handler = stateHandlers[state] || stateHandlers['greeting'];
        const responseText = await handler(userKey, utterance, history, collectedInfo);
        
        return res.json(createSimpleTextResponse(responseText));

    } catch (e) {
        console.error("스킬 처리 중 오류 발생:", e);
        const errorResponse = createSimpleTextResponse("죄송합니다, 시스템에 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
        return res.status(500).json(errorResponse);
    }
});

// Vercel 환경에서는 Express 앱을 직접 실행하지 않으므로, module.exports로 내보냅니다.
module.exports = app;