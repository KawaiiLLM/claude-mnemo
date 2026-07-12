export const CANONICAL_DIARY_WIRE_FORMAT_EXAMPLE = [
  "===DIARY_V2_BEGIN===",
  "## 工作",
  "**<项目名>**",
  "- 我帮用户完成了一项协作工作 [S1/T1]",
  "  <属于上一条 bullet 的可选续行>",
  "## 人物",
  "- 用户拒绝了不符合其判断的建议 [S1/T1，T2，S2/T1]",
  "## 反思",
  "- <一条反思> [S1/T1]",
  "===DIARY_V2_END===",
  "===INDEX_HOOK_V1===",
  "<一条非空单行索引钩子，不以日期开头>",
].join("\n");

export const CANONICAL_PERSONA_WIRE_FORMAT_EXAMPLE = [
  "===USER_PROFILE_V1_BEGIN===",
  "# 用户画像",
  "用户有一项对未来交互有用且有依据的沉淀特质 [S1/T1]",
  "===USER_PROFILE_V1_END===",
  "===EXPERIENCE_V1_BEGIN===",
  "# 近期经历",
  "2026-07：我与用户推进了一项进行中的事项 [S1/T1]",
  "===EXPERIENCE_V1_END===",
].join("\n");
