import {captureSignal} from './capture-signal.mjs';
// One source ledger/deadline per working-copy navigation capture, never per stage.
export function createSvnNavigationBudget(signal){
 const sharedSignal=captureSignal(signal);let bytes=0;
 return Object.freeze({signal:sharedSignal,charge(size){sharedSignal.throwIfAborted();if(!Number.isSafeInteger(size)||size<0)throw new Error('Invalid SVN navigation source size');bytes+=size;if(bytes>1024*1024)throw Object.assign(new Error('SVN shared navigation source byte limit exceeded'),{code:'SVN_NAVIGATION_BUDGET'});},usage(){return bytes;}});
}
