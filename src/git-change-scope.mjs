// Git working-copy comparison scopes: whole working tree (default), staged index or unstaged edits.
export const CHANGE_SCOPES = ['worktree', 'staged', 'unstaged'];

/** Normalize the requested scope; only the three documented values are accepted. */
export function changeScope(value) {
  if (value === undefined) return 'worktree';
  if (typeof value !== 'string' || !CHANGE_SCOPES.includes(value)) throw new Error('Invalid changeScope; expected worktree, staged or unstaged');
  return value;
}

/** Model-facing note: what the two captured sides actually are for this scope. */
export const CHANGE_SCOPE_NOTICE = {
  staged: '本次比较为 Git 暂存区（HEAD → index）：变更文件左侧为 HEAD 内容，右侧为已暂存内容；工作区未暂存修改不作为变更正文发送。显式上下文、自动依赖、调用方候选与规则文件按工作区当前内容读取，可能包含未暂存修改。',
  unstaged: '本次比较为 Git 未暂存改动（index → 工作区）：左侧为已暂存内容，仅作旧侧基线；右侧为工作区文件。已暂存内容不代表由本次未暂存改动引入。',
};

/** Preview/report label: disclose the exact comparison and its exclusions. */
export const CHANGE_SCOPE_LABEL = {
  staged: 'Git 暂存区（HEAD → index），不包含工作区未暂存修改；上下文与规则文件按工作区读取',
  unstaged: 'Git 未暂存改动（index → 工作区），已暂存内容仅作旧侧基线',
};

/** Preview notice: tell the user what will be sent before confirmation. */
export const CHANGE_SCOPE_PREVIEW_NOTICE = {
  staged: '本次审查范围是 Git 暂存区（HEAD → index）：只发送已暂存变更内容，工作区未暂存修改不作为变更正文；如选择上下文、自动依赖、调用方或规则文件，它们按工作区当前内容读取。',
  unstaged: '本次审查范围是 Git 未暂存改动（index → 工作区）：已暂存内容只作为旧侧基线。',
};

export function changeScopeNotice(scope) {
  return CHANGE_SCOPE_NOTICE[scope];
}

export function changeScopeLabel(scope) {
  return CHANGE_SCOPE_LABEL[scope];
}

export function changeScopePreviewNotice(scope) {
  return CHANGE_SCOPE_PREVIEW_NOTICE[scope];
}
