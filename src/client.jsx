import React, { useState } from 'react';
import { DEFAULT_EXCLUDED_FOLDERS, DEFAULT_RESOURCE_SUFFIXES, diffFilter } from './diff-filter.mjs';

const slot = 'plugins.row.config';
const key = '@feng0531/dsh-code-review#dsh-code-review';
const defaults = {
  autoExcludeNonCode: true,
  diffExcludeFolderNames: DEFAULT_EXCLUDED_FOLDERS,
  diffExcludeSuffixes: DEFAULT_RESOURCE_SUFFIXES,
};

function DiffFilterForm({ form }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const state = form?.state;
  if (!state || state.status !== 'ready') return <p>差异过滤配置暂不可用。</p>;
  const current = { ...defaults, ...state.value };
  const value = { ...current, ...draft?.values };
  const disabled = saving || !state.writable;
  const edit = (field, next) => {
    setMessage('');
    setDraft(previous => ({ revision: previous?.revision ?? state.revision, values: { ...previous?.values, [field]: next } }));
  };
  const save = async event => {
    event.preventDefault();
    if (disabled || !draft) return;
    try { diffFilter(value); } catch {
      setMessage('请检查文件夹名称和后缀：不要填写路径或通配符。');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const saved = await form.mutate(Object.entries(draft.values).map(([field, value]) => ({ op: 'set', path: [field], value })), draft.revision);
      if (saved) { setDraft(null); setMessage('已保存。下次预览使用新配置。'); }
      else setMessage('未保存。配置可能已改变，请放弃编辑后重试。');
    } catch { setMessage('保存失败，请重试。'); }
    finally { setSaving(false); }
  };
  return <form onSubmit={save} aria-label="差异过滤" style={{display:'grid',gap:12}}>
    <p>只过滤 Git / SVN 变更；命中的文件不读取差异正文。关闭或清空规则后，请重新预览。</p>
    <label><input type="checkbox" checked={value.autoExcludeNonCode} disabled={disabled}
      onChange={e => edit('autoExcludeNonCode', e.target.checked)} /> 自动过滤资源文件</label>
    <label>资源后缀（空格或逗号分隔）<br />
      <textarea rows={4} maxLength={4096} style={{width:'100%'}} value={value.diffExcludeSuffixes} disabled={disabled || !value.autoExcludeNonCode}
        onChange={e => edit('diffExcludeSuffixes', e.target.value)} /></label>
    <label>排除文件夹名（不区分大小写；逗号或换行分隔）<br />
      <textarea rows={2} maxLength={2048} style={{width:'100%'}} value={value.diffExcludeFolderNames} disabled={disabled}
        onChange={e => edit('diffExcludeFolderNames', e.target.value)} /></label>
    <div style={{display:'flex',gap:8}}>
      <button type="submit" disabled={disabled || !draft}>{saving ? '保存中…' : '保存'}</button>
      <button type="button" disabled={saving || !draft} onClick={() => { setDraft(null); setMessage(''); }}>放弃编辑</button>
      <button type="button" disabled={disabled} onClick={() => { setDraft({ revision: state.revision, values: defaults }); setMessage(''); }}>填入默认值</button>
    </div>
    <div role="status">{!state.writable ? '当前配置为只读。' : message}</div>
  </form>;
}

export const inject = ['slots'];
export function apply(ctx) {
  ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key },
    ({ view, form }) => view === 'summary' ? '配置变更审查要跳过的资源和文件夹' : <DiffFilterForm form={form} />));
}
