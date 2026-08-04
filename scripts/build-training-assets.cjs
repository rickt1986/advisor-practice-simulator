const fs = require("node:fs");
const path = require("node:path");

const sourceDir = process.argv[2];
const outputFile = process.argv[3] || path.join(process.cwd(), "training-assets.json");
const channel = process.argv[4] || "训练营私域";
const source = process.argv[5] || "私域获客渠道｜Agent训练版分年级实践卡";
const version = process.argv[6] || "2026-08-04-private-domain-grade-v1";
if (!sourceDir) throw new Error("用法：node scripts/build-training-assets.cjs <训练卡目录> [输出文件]");

function field(block, label) {
  return (block.match(new RegExp(`\\*\\*${label}\\*\\*：([^\\n]+)`)) || [])[1]?.trim() || "";
}

function parseScenario(block) {
  const title = (block.match(/^([^\n]+)/) || [])[1]?.trim();
  if (!title) return null;
  const situations = block.split(/\n### 情况 \d+\n/).slice(1).map((part, index) => ({
    situation: index + 1,
    trigger: field(part, "触发信号"),
    requiredFacts: field(part, "必须补齐事实"),
    gradeGuidance: field(part, "年级校准"),
    goal: field(part, "本轮目标"),
    branches: field(part, "判断分支"),
    recommended: (part.match(/\*\*推荐表达\*\*：\s*\n\s*>\s*([^\n]+)/) || [])[1]?.trim() || "",
    forbidden: field(part, "禁说边界"),
    completion: field(part, "完成标准"),
  })).filter((item) => item.trigger);
  return { title, situations };
}

const grades = {};
for (const file of fs.readdirSync(sourceDir).filter((name) => /年级_Agent训练实践卡\.md$/.test(name))) {
  const grade = (file.match(/^(\d+)年级/) || [])[1];
  const content = fs.readFileSync(path.join(sourceDir, file), "utf8");
  const scenarios = content.split(/\n## 场景：/).slice(1).map(parseScenario).filter(Boolean);
  grades[grade] = Object.fromEntries(scenarios.map((scenario) => [scenario.title, scenario]));
}

const asset = {
  version,
  channel,
  source,
  grades,
};
fs.writeFileSync(outputFile, `${JSON.stringify(asset, null, 2)}\n`);
console.log(`已生成 ${outputFile}：${Object.keys(grades).length} 个年级`);
