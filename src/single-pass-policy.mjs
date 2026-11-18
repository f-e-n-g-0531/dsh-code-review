export const SINGLE_PASS_MAX_OUTPUT_TOKENS = 4096;

export function singlePassCapacity(budget, modelCapacity) {
  const contextWindowTokens = modelCapacity?.contextWindowTokens ?? null;
  const requestedOutputTokens = Math.min(SINGLE_PASS_MAX_OUTPUT_TOKENS, modelCapacity?.maxOutputTokens ?? SINGLE_PASS_MAX_OUTPUT_TOKENS);
  return {
    logicalBytes: budget.fits ? 'fits' : 'blocked',
    modelContext: { status: 'unknown', contextWindowTokens, inputTokens: null },
    output: { requestedTokens: requestedOutputTokens, modelLimitTokens: modelCapacity?.maxOutputTokens ?? null, responseFits: 'unknown' },
    independentVerification: 'not-requested',
  };
}

const own = (value, key) => {
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; }
  catch { return undefined; }
};
const reasons = Object.freeze({
  MODEL_INCOMPLETE_OUTPUT: ['SINGLE_PASS_MODEL_INCOMPLETE', '模型输出未正常结束，未接受不完整结果。可缩小审核范围后重新预览。'],
  MODEL_OUTPUT_LIMIT: ['SINGLE_PASS_OUTPUT_LIMIT', '模型输出超过本次上限。可缩小审核范围或显式选择深审后重新预览。'],
  MODEL_INVALID_JSON: ['SINGLE_PASS_MODEL_JSON_INVALID', '模型响应不是完整有效的 JSON，未接受结果。'],
  MODEL_INPUT_BUDGET_EXCEEDED: ['SINGLE_PASS_INPUT_BUDGET', '输入超过已批准的字节上限，未发送。可缩小范围或显式选择深审后重新预览。'],
  MODEL_ARTIFACT_FAILED: ['SINGLE_PASS_ARTIFACT_FAILED', '未能保存本次模型诊断工件，未接受结果。'],
  REVIEW_MODEL_CAPACITY_CHANGED: ['SINGLE_PASS_MODEL_CAPACITY_CHANGED', '模型容量信息已变化；请重新预览。'],
});
export function singlePassModelFailure(error) {
  const code = own(error, 'code');
  const diagnostic = own(error, 'diagnostic');
  if (code === 'MODEL_INCOMPLETE_OUTPUT' && own(diagnostic, 'providerCode') === 'CONTEXT_WINDOW_EXCEEDED') return ['SINGLE_PASS_CONTEXT_LIMIT', '模型拒绝了超出上下文容量的请求。可缩小审核范围或显式选择深审后重新预览。'];
  if (code === 'MODEL_INCOMPLETE_OUTPUT' && own(diagnostic, 'finishKind') === 'length') return reasons.MODEL_OUTPUT_LIMIT;
  return typeof code === 'string' && Object.hasOwn(reasons, code) ? reasons[code] : undefined;
}
