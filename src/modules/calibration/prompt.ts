/** 交发布包（video_kit）时附带的预测提示（规格 §二 触发点）：只提示，不拦发布 */
export function predictionPrompt(contentId: string): Record<string, unknown> {
  return {
    message: "发布前先做盲预测：创始人还没看到这条的任何数据时，先交你的逐维自评，再起盲评通道对照。",
    tool: "autocrew_insights",
    params: { action: "calib_blind", calib: { content_id: contentId, self_scores: "{ER,SR,HP,QL,NA,AB,SAT,MS,TS 各 0–5}" } },
  };
}
