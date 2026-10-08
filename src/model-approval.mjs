// Host is the only authority. Never reinterpret truthy values as a grant.
export async function requestModelApproval(approval, request) {
 if (typeof approval?.request !== 'function') throw new Error('Model sending approval unavailable: host approval service missing; no code sent. Enable host approval before a new preview; confirmed=true is not a grant.');
 const outcome = await approval.request(request);
 if (outcome === 'allowed-once') return true;
 const status = ['rejected', 'cancelled', 'unavailable'].includes(outcome) ? outcome : 'invalid-outcome';
 let policy;
 // Diagnostic only: policy never changes the grant decision or host audit request.
 try { if (typeof approval.effectivePolicy === 'function') policy = approval.effectivePolicy(request.agent?.session); } catch {}
 const policyHint = policy === 'never' ? ' Host approval policy=never: approval requests are automatically rejected; full filesystem access does not grant model sending. Select a host permission preset with approval policy=ask, then approve once.' : '';
 throw new Error('Model sending approval denied or unavailable (' + status + '):' + policyHint + ' no code sent, review not performed. Check host approval policy/UI availability; obtain allowed-once after a new preview. confirmed=true does not replace host approval.');
}
