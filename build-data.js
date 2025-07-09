const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

/**
 * 이 스크립트는 'data' 폴더에 있는 CSV 파일들을 읽어
 * 하나의 자바스크립트 객체로 변환한 후 'lms_data.js' 파일로 저장합니다.
 * 터미널에서 `node build-data.js` 명령어로 실행하세요.
 */
function buildData() {
  try {
    console.log("데이터 빌드를 시작합니다...");
    const data = {
      male: { height: {}, weight: {} },
      female: { height: {}, weight: {} },
    };

    const files = {
      male_height: 'male_height.csv',
      male_weight: 'male_weight.csv',
      female_height: 'female_height.csv',
      female_weight: 'female_weight.csv',
    };

    for (const [key, filename] of Object.entries(files)) {
      const [sex, type] = key.split('_');
      const filePath = path.join(process.cwd(), 'data', filename);

      if (!fs.existsSync(filePath)) {
        throw new Error(`'data' 폴더에서 파일을 찾을 수 없습니다: ${filename}`);
      }

      const csvData = fs.readFileSync(filePath, 'utf8');
      const records = parse(csvData, { columns: true, skip_empty_lines: true });

      records.forEach(record => {
        data[sex][type][record.Month] = {
          L: parseFloat(record.L),
          M: parseFloat(record.M),
          S: parseFloat(record.S),
        };
      });
    }

    // 데이터를 포함하는 자바스크립트 파일 내용을 생성합니다.
    const fileContent = `// 이 파일은 build-data.js에 의해 자동으로 생성되었습니다.\n// 직접 수정하지 마세요.\nconst lmsData = ${JSON.stringify(data, null, 2)};\n\nmodule.exports = lmsData;\n`;

    // 'lms_data.js' 파일로 저장합니다.
    fs.writeFileSync('lms_data.js', fileContent, 'utf8');
    console.log("✅ 성공! 'lms_data.js' 파일이 생성되었습니다.");

  } catch (error) {
    console.error("❌ 데이터 빌드 중 오류 발생:", error);
    process.exit(1);
  }
}

buildData();
