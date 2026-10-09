// Read occurrence only, never complete source coverage or semantic verification.
export function riskReadCoverage(risks, audit, catalog, snapshotId){
 const allowed=new Set(catalog.map(s=>s.id));
 const read=new Set(audit.filter(r=>r.kind==='read'&&r.snapshotId===snapshotId&&r.stage==='retrieved-locally'&&Number.isSafeInteger(r.count)&&r.count>0&&allowed.has(r.sourceId)).map(r=>r.sourceId));
 return risks.map(r=>({riskId:r.id,requestedSourceIds:[...r.sourceIds],readSourceIds:r.sourceIds.filter(id=>read.has(id)),unreadSourceIds:r.sourceIds.filter(id=>!read.has(id)),status:r.sourceIds.some(id=>!read.has(id))?'unread-sources':r.sourceIds.length?'fragments-read':'no-sources-requested',conditions:'unverified'}));
}
