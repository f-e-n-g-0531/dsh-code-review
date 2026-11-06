import { RETRIEVAL_INSTRUCTIONS } from './prompts.mjs';
import { transferReceiptPolicy } from './verification-receipt-policy.mjs';

export const RETRIEVAL_BUDGET_SUFFIX = ' retrievalBudget为宿主共享检索预算的当前余量，不是新授权。每项操作消耗一次call及实际序列化输出字节；不要请求超过余量的整批操作。预算将尽请及时按本阶段schema最终答复，只引用已提供证据，证据不足须保留限制或uncertain。';
export const RETRIEVAL_FINAL_SUFFIX = ' 检索预算最终答复：本次仅有一次最终schema答复机会，不得再返回requests。不得把缺证据变成无问题/已核查；只保留已提供且可严格验证的证据，其余说明限制或uncertain。不增加reader、模型调用、输入或超时预算。';

// The same mandatory round-zero envelope is measured and sent. No cap estimate,
// source read, receipt issuance or budget mutation is performed here.
export function initialRetrievalEnvelope(request, scope, { maxRounds = request.maxRetrievalRounds ?? 3 } = {}) {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 0) throw new TypeError('Invalid initial retrieval rounds');
  const budget = scope.budget?.();
  const exhausted = budget && ((budget.remainingCalls === 0 && !budget.reusableResults) || budget.remainingOutputBytes === 0);
  const code = exhausted ? budget.remainingCalls === 0 ? 'READER_CALL_BUDGET_EXCEEDED' : 'READER_OUTPUT_BUDGET_EXCEEDED' : maxRounds === 0 ? 'RETRIEVAL_ROUND_BUDGET_EXCEEDED' : null;
  return transferReceiptPolicy(request, { ...request,
    instructions: request.instructions + String.fromCharCode(10) + RETRIEVAL_INSTRUCTIONS + (code ? RETRIEVAL_FINAL_SUFFIX : RETRIEVAL_BUDGET_SUFFIX),
    input: JSON.stringify({ ...JSON.parse(request.input), catalog: scope.catalog(), retrieved: [], retrievalRounds: { max: maxRounds, remaining: code ? 0 : maxRounds }, ...(budget ? { retrievalBudget: budget } : {}), ...(code ? { retrievalFinalization: { code } } : {}) }),
  });
}
