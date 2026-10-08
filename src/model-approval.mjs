// Host is the only authority. Never reinterpret truthy values as a grant.
export async function requestModelApproval(approval, request) {
 if (typeof approval?.request !== 'function') throw new Error('Model sending approval unavailable: host approval service missing; no code sent. Enable host approval before a new preview; confirmed=true is not a grant.');
 const outcome = await approval.request(request);
 if (outcome === 'allowed-once') return true;
 const status = ['rejected', 'cancelled', 'unavailable'].includes(outcome) ? outcome : 'invalid-outcome';
 throw new Error('Model sending approval denied or unavailable (' + status + '): no code sent, review not performed. Check host approval policy/UI availability; obtain allowed-once after a new preview. confirmed=true does not replace host approval.');
}
