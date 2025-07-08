const { kv } = require('@vercel/kv');
const { readFileSync } = require('fs');
require('dotenv').config({ path: '.env.local' });

// CSV 파일을 읽어 파싱하는 함수
function parseCSV(filePath) {
    const fileContent = readFileSync(filePath, 'utf-8');
    const lines = fileContent.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
        const values = line.split(',');
        const obj = {};
        headers.forEach((header, index) => {
            obj[header] = values[index].trim();
        });
        return obj;
    });
}

async function seedData() {
    console.log("Vercel KV 데이터 시딩을 시작합니다...");

    // 1. 여기에 모든 데이터 파일 경로를 매핑합니다.
    const dataFiles = [
        { gender: 1, measurement: 'height', path: './data/male_height.csv' },
        { gender: 2, measurement: 'height', path: './data/female_height.csv' },
        { gender: 1, measurement: 'weight', path: './data/male_weight.csv' },
        { gender: 2, measurement: 'weight', path: './data/female_weight.csv' },
        // TODO: BMI, 머리둘레 등 나머지 데이터도 동일한 방식으로 추가
    ];

    const pipe = kv.pipeline();
    let totalEntries = 0;

    for (const fileInfo of dataFiles) {
        try {
            const records = parseCSV(fileInfo.path);
            for (const record of records) {
                const key = `${fileInfo.gender}:${fileInfo.measurement}:${record.age_months}`;
                const value = {
                    L: record.L,
                    M: record.M,
                    S: record.S,
                };
                pipe.hset(key, value);
                totalEntries++;
            }
            console.log(`- ${fileInfo.path} 파일 처리 완료 (${records.length}개 레코드)`);
        } catch (error) {
            console.error(`오류: ${fileInfo.path} 파일을 읽거나 처리할 수 없습니다.`, error);
        }
    }
    
    if (totalEntries > 0) {
        console.log(`\n총 ${totalEntries}개의 데이터를 Vercel KV에 저장합니다...`);
        await pipe.exec();
        console.log("✅ 데이터 시딩이 성공적으로 완료되었습니다!");
    } else {
        console.log("처리할 데이터가 없습니다. 데이터 파일 경로와 내용을 확인하세요.");
    }
}

seedData();