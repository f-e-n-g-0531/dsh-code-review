// Ask for one new response; never normalize identities, severities or evidence locally.
const GUIDANCE = {
  MODEL_INVALID_REVIEW_RESPONSE: '返回含 findings 和 limitations 数组的当前阶段完整对象。',
  MODEL_INVALID_FINDING_IDENTITY: 'fileId 必须原样复制本次主 file.id，不使用路径、候选编号或其他文件身份。',
  MODEL_INVALID_FINDING_SEVERITY: 'severity 仅允许 critical、high、medium、low，不使用 P1/P2、数字或翻译标签。',
  MODEL_MISSING_FINDING_FIELD: '每个发现必须包含非空 title/evidence/trigger/impact/suggestion。',
  MODEL_INVALID_ANCHOR: 'anchor 必须使用当前阶段允许的 kind、side、整数 start/end 及精确 snippet。',
  MODEL_ANCHOR_MISMATCH: 'snippet 必须逐行精确复制批准来源，start/end 是该来源的原始一基行号，不能使用展示窗口的相对行号。不得模糊匹配、改写源码或用 file anchor 隐藏定位失败。',
};

export async function correctedResponse(generate, validate, request, { enabled = false, canCorrect = () => true, onCorrection = async () => {} } = {}) {
  const approved = { ...request };
  const original = await generate({ ...approved });
  try { return validate(original); } catch (error) {
    approved.signal?.throwIfAborted();
    if (!enabled || !Object.hasOwn(GUIDANCE, error?.code) || !canCorrect()) throw error;
    await onCorrection({ action: 'review-response-correction', code: error.code, notice: 'Original response rejected; requesting one new response under the same approved scope and shared budgets.' });
    approved.signal?.throwIfAborted();
    const instructions = approved.instructions + '\n本次是一次明确的主审响应协议纠正：' + GUIDANCE[error.code] + ' 重新核对原批准源码并返回完整当前阶段 schema；不得把格式错误当成无缺陷，不得为通过校验编造证据或静默删除有证据的候选。原响应未被接受，纠正后仍需全部严格校验。';
    // generate enforces the same input/call/reader limits and enclosing signal.
    const response = await generate({ ...approved, instructions });
    approved.signal?.throwIfAborted();
    try { return validate(response); } catch (second) {
      second.responseAttempts = [{ code: error.code }, { code: second.code ?? 'REVIEW_EXECUTION_FAILED' }];
      throw second;
    }
  }
}
