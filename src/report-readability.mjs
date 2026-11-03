// Pure presentation: original report records remain authoritative and unchanged.
const rows = value => Array.isArray(value) ? value : [];
const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\\\x60*_{}\[\]()#+.!|~=-]/g, '\\$&');
const brief = value => { const text = String(value ?? ''); return escape(text.length > 180 ? text.slice(0, 180) + '…（完整值见附录）' : text); };
const html = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stages = { primary: '主审', verification: '独立复核', synthesis: '综合', 'window-synthesis': '跨窗口综合', interaction: '跨文件综合' };
const stage = value => Object.hasOwn(stages, value) ? stages[value] : String(value ?? '未标明阶段');

function reason(record = {}) {
  const value = typeof record === 'string' ? record : record?.failureCode ?? record?.blockCode ?? record?.code ?? record?.reason;
  const text = String(value ?? '');
  // Dependency state must not be relabelled as an input-budget failure.
  if (/dependenc|primary.*incomplete|member.*incomplete|prerequisite|依赖.*未完成|主审.*未完成/i.test(text)) return '依赖的主审或前置阶段未完成';
  if (/RETRIEVAL_ROUND_BUDGET_EXCEEDED|检索轮数|retrieval.*round.*(budget|limit)/i.test(text)) return '单阶段检索轮数达到上限（读取额度可能仍有余量）';
  if (/READER_CALL_BUDGET_EXCEEDED|reader.*call.*(budget|limit)|读取调用.*(不足|耗尽|上限)/i.test(text)) return '阶段分配或共享读取调用次数不足';
  if (/READER_OUTPUT_BUDGET_EXCEEDED|reader.*output.*(budget|limit)|读取.*字节|输出字节/i.test(text)) return '阶段分配或共享读取输出字节预算不足';
  if (/input[-_ ]budget|input.*(budget|limit).*exceed|输入.*(预算|上限|超限)/i.test(text)) return '阶段输入预算不足';
  if (/PROJECT_MODEL_CALL_LIMIT|model call budget|模型调用.*(额度不足|上限)/i.test(text)) return '模型调用额度不足';
  if (/unsupported|not[-_ ]supported|不支持/i.test(text)) return '当前不支持此来源或操作';
  if (text === 'exact-edit-analysis-unavailable') return '精确编辑分析不可用';
  if (/CANCELLED|cancelled|canceled/i.test(text)) return '执行已取消';
  if (/MODEL_TIMEOUT|timed? ?out/i.test(text)) return '阶段执行超时';
  return text ? '未知／其他原因（完整原文见附录）' : '原因未记录（未知；不推测为预算不足）';
}

function fileReasons(file, findings) {
  const result = [];
  const limits = [...rows(file?.retrievalLimits), ...rows(file?.groupRetrievalLimits)];
  const failures = rows(file?.stageFailures);
  const hasReason = record => record != null && ['failureCode', 'blockCode', 'code', 'reason'].some(key => record[key] != null && record[key] !== '');
  if (['pending', 'blocked', 'failed', 'cancelled', 'running'].includes(file?.status)) {
    // A missing top-level code does not erase concrete phase/group evidence.
    const evidence = hasReason(file) ? [file] : [...failures, ...limits].filter(hasReason);
    result.push(...(evidence.length ? evidence : [file]).map(reason));
  }
  for (const failure of failures) result.push(stage(failure?.phase ?? failure?.stage) + '未完成；' + reason(failure));
  if (file?.retrievalLimited || limits.length) {
    result.push(...(limits.length ? limits.map(reason) : [reason(file)]));
  }
  if (rows(file?.windowCoverage?.pending).length) result.push('变更窗口尚未完成');
  if (file?.continuationPending) result.push('阶段续审尚未完成');
  for (const [key, label] of [['synthesisStatus', '跨窗口综合'], ['verificationStatus', '独立复核']]) if (file?.[key] && file[key] !== 'completed') result.push(label + '未完成');
  if (rows(file?.reviewPasses).some(pass => pass?.status !== 'completed')) result.push('独立审查轮次尚未完成');
  if (file?.fileId != null && findings.some(finding => finding?.fileId === file.fileId && finding?.verification?.status !== 'completed')) result.push('候选的独立复核尚未完成');
  return [...new Set(result)];
}

function collect(report) {
  const files = rows(report?.files), findings = rows(report?.findings);
  const names = new Map(files.filter(file => file?.fileId != null).map(file => [file.fileId, file.path]));
  const identity = id => names.has(id) && names.get(id) != null ? String(names.get(id)) : '未知文件身份：' + (typeof id === 'object' ? JSON.stringify(id) : String(id));
  const paths = record => {
    if (record == null || typeof record !== 'object') return [];
    return [...new Set([...(record.path != null ? [String(record.path)] : []), ...(record.fileId != null ? [identity(record.fileId)] : []), ...rows(record.fileIds).map(identity)])];
  };
  const unfinished = files.map(record => ({ record, reasons: fileReasons(record, findings), paths: record?.path != null ? [String(record.path)] : paths(record) })).filter(item => item.reasons.length);
  const interactions = rows(report?.interactions).filter(record => record?.status !== 'completed').map(record => ({ record, reasons: [reason(record)], paths: paths(record) }));
  return { unfinished, interactions, limitations: rows(report?.limitations), paths };
}

function grouped(items) {
  const groups = new Map();
  for (const item of items) for (const label of item.reasons) {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  return [...groups];
}

function summary(output, label, items) {
  if (!items.length) return;
  output.push('- ' + label + '：' + items.length + ' 条记录。');
  const groups = grouped(items);
  for (const [why, members] of groups.slice(0, 6)) {
    const paths = [...new Set(members.flatMap(member => member.paths))];
    output.push('  - ' + brief(why) + '：' + members.length + ' 条；' + (paths.length ? paths.slice(0, 4).map(brief).join('、') + (paths.length > 4 ? '；另有 ' + (paths.length - 4) + ' 个路径／身份' : '') : '未记录文件路径／身份') + '。');
  }
  if (groups.length > 6) output.push('  - 另有 ' + (groups.length - 6) + ' 类原因；完整范围与原始记录见本报告限制附录。');
}

export function readabilityMarkdown(report = {}) {
  const data = collect(report);
  const output = ['', '## 未完成范围与原因', '以下为处理状态与限制记录数，非缺陷数；同一文件可能涉及多个阶段，限制不自动表示待审或缺陷。'];
  summary(output, '未完成条目', data.unfinished);
  summary(output, '跨文件综合未完成', data.interactions);
  if (!data.unfinished.length && !data.interactions.length) output.push(report?.partial || data.limitations.length ? '- 报告仍有部分完成标记或限制；未逐项记录待续审范围，不表示全部查完。' : '- 未记录未完成条目或跨文件综合；这不是正确性证明。');
  if (data.limitations.length) output.push('- 另有 ' + data.limitations.length + ' 条限制记录，按原文聚合保留在本报告限制附录；不将这些限制全部计入未完成范围。');
  if (data.unfinished.length || data.interactions.length) output.push('- 以上仅列有界摘要；全部路径、身份、阶段及原始记录见本报告限制附录。');
  output.push('', '## 下一步');
  if (data.unfinished.length || data.interactions.length) output.push('- 先处理对应阻断／失败原因，再选择未完成条目、窗口、综合或复核阶段继续；已完成主审不能替代后续综合和独立复核。', '- 检索轮数、读取调用数、字节与输入预算是不同限制，应按实际原因调整；依赖未完成时先完成前置阶段，不据此推断输入超限。', '- 本报告不会自动续审或调用模型；再次执行需新预览并核对当前人类授权，范围或发送目的地变化时重新确认。');
  else output.push('- 如需扩大或继续审核，请显式选择范围并核对新预览与当前人类授权；不要仅凭没有未完成记录判定通过。');
  return output;
}

function originalDetails(output, record) {
  output.push('<details><summary>原始记录 JSON（完整保留）</summary>', '', '<pre>' + html(JSON.stringify(record, null, 2) ?? 'null') + '</pre>', '', '</details>');
}

// Deduplicate identical records without losing their original positions or multiplicity.
function packed(records) {
  const entries = new Map();
  records.forEach((record, index) => {
    const key = JSON.stringify(record);
    if (!entries.has(key)) entries.set(key, { record, positions: [] });
    entries.get(key).positions.push(index);
  });
  return [...entries.values()];
}

export function limitationDetailsMarkdown(report = {}) {
  const data = collect(report);
  const output = ['', '## 限制附录', '以下按原文聚合；计数为记录数，非缺陷数，也不等于待审条目数。相同原文只展示一次，归属与重复次数聚合；折叠 JSON 保留差异字段及原始顺序。完整源报告 JSON 仍为权威记录。'];
  const groups = new Map();
  for (const record of data.limitations) {
    const text = typeof record === 'string' ? record : record?.text;
    // Prefixes distinguish a text-bearing record from an opaque legacy record.
    const key = text == null ? 'record:' + JSON.stringify(record) : 'text:' + JSON.stringify(text);
    if (!groups.has(key)) groups.set(key, { text, records: [] });
    groups.get(key).records.push(record);
  }
  if (!groups.size) output.push('- 未记录限制原文。');
  for (const { text, records } of groups.values()) {
    output.push('', '### 限制（' + records.length + ' 条记录）', text == null ? '未提供限制原文' : '<pre>' + html(JSON.stringify(text)) + '</pre>');
    const scopes = new Map();
    for (const record of records) {
      const paths = data.paths(record);
      const scope = '- 范围：' + (paths.length ? paths.map(escape).join('、') : '未标明文件身份') + (record?.stage != null || record?.phase != null ? '；阶段：' + escape(stage(record.stage ?? record.phase)) : '');
      scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
    }
    for (const [scope, count] of scopes) output.push(scope + '；重复次数：' + count);
    // Shared text is represented by the visible original above, not repeated in every JSON row.
    const compact = records.map(record => typeof record === 'string' ? { type: 'string' } : record && typeof record === 'object' && record.text != null && Object.hasOwn(record, 'text') ? { type: 'object-with-shared-text', fields: Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'text')) } : { type: 'original', value: record });
    output.push('折叠记录中 object-with-shared-text 的 text、string 的原值均为本组上方完整原文；positions 为组内原始索引。');
    originalDetails(output, packed(compact));
  }
  for (const [label, items] of [['未完成条目明细', data.unfinished], ['未完成跨文件综合明细', data.interactions]]) {
    if (!items.length) continue;
    output.push('', '### ' + label + '（' + items.length + ' 条记录）');
    for (const item of items) output.push('- ' + (item.paths.length ? item.paths.map(escape).join('、') : '未标明文件身份') + '：' + item.reasons.map(escape).join('；'));
    // State/reason metadata includes window IDs and pass statuses; full source and candidates already
    // exist in the complete report JSON and must not be duplicated into this appendix.
    const keys = ['fileId', 'path', 'groupId', 'fileIds', 'status', 'failureCode', 'blockCode', 'code', 'reason', 'stage', 'phase', 'stageFailures', 'retrievalLimited', 'retrievalLimits', 'groupRetrievalLimits', 'continuationPending', 'synthesisStatus', 'verificationStatus', 'windowCoverage', 'reviewPasses'];
    output.push('以下仅为状态与原因元数据；源码、候选及其他完整字段见完整源报告 JSON。');
    originalDetails(output, packed(items.map(item => Object.fromEntries(keys.filter(key => Object.hasOwn(item.record ?? {}, key)).map(key => [key, item.record[key]])))));
  }
  return output;
}
