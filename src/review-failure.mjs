const LABELS = Object.freeze({
  REVIEW_SUBAGENTS_UNAVAILABLE: '受限宿主子会话不可用，请检查宿主能力后重新预览。',
  INVALID_WHOLE_SCOPE_PLAN: '整体审查计划无效，请重新生成预览。',
  INVALID_REVIEW_DISPATCH: '审查执行策略无效，请核对配置后重新预览。',
  WHOLE_SCOPE_UNSUPPORTED: '当前范围不支持整体审查，请核对模式后重新预览。',
  WHOLE_SCOPE_INPUT_BUDGET: '子会话输入超过批准容量，审核未完成。',
  WHOLE_SCOPE_MODEL_CALL_LIMIT: '子会话达到模型调用次数限制，审核未完成。',
  PROJECT_MODEL_CALL_LIMIT: '项目共享模型调用次数达到限制，审核未完成。',
  MODEL_CALL_LIMIT: '模型调用次数达到限制，审核未完成。',
  MODEL_TIMEOUT: '模型执行超时，审核未完成。',
  REVIEW_CHILD_IDENTITY: '子会话身份校验失败，审查已停止。',
  REVIEW_CHILD_ROUTE: '子会话模型路由发生变化，请重新预览。',
  REVIEW_CHILD_INCOMPLETE: '子会话未提交有效最终结果，审核未完成。',
  READER_CALL_BUDGET_EXCEEDED: '批准来源读取调用次数达到限制，审核未完成。',
  READER_OUTPUT_BUDGET_EXCEEDED: '批准来源读取字节达到限制，审核未完成。',
  RETRIEVAL_ROUND_BUDGET_EXCEEDED: '阶段检索轮数达到限制，审核未完成。',
  MODEL_ARTIFACT_FAILED: '审查诊断保存失败，执行已停止。',
  CHECKPOINT_FAILED: '审查检查点保存失败，执行已停止。',
  RESUME_CHECKPOINT_FAILED: '续审检查点保存失败，执行已停止。',
  PREVIEW_MISSING: '预览不存在或已使用，请重新预览。',
  PREVIEW_EXPIRED: '预览已过期，请重新预览并核对当前授权。',
  PREVIEW_OWNER_CHANGED: '预览所属智能体发生变化，请重新预览。',
  PREVIEW_DIRECTORY_CHANGED: '预览工作目录发生变化，请重新预览。',
  PREVIEW_MODEL_CHANGED: '预览模型发生变化，请重新预览。',
  UNKNOWN_REVIEW_FAILURE: '审核执行失败，未取得可安全展示的具体原因；请检查宿主诊断后重新预览。',
});
const data = (object, key) => {
  try {
    if (object === null || !['object', 'function'].includes(typeof object)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
};
const positive = value => Number.isSafeInteger(value) && value > 0;

/** Source-free presentation metadata, never authority to retry, split, or approve. */
export function safeReviewFailure(error) {
  const requested = data(error, 'code');
  const code = typeof requested === 'string' && Object.hasOwn(LABELS, requested) ? requested : 'UNKNOWN_REVIEW_FAILURE';
  const result = { code, label: LABELS[code] };
  if (code === 'WHOLE_SCOPE_INPUT_BUDGET') {
    for (const key of ['requiredBytes', 'approvedCap']) {
      const value = data(error, key);
      if (positive(value)) result[key] = value;
    }
  }
  return Object.freeze(result);
}
