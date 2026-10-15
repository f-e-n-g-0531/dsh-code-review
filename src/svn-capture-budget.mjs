// Shared across initial capture, navigation, mergeinfo and final verification.
export function createSvnCaptureBudget(signal){
 const deadline=AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])]);let commands=0,metadataBytes=0,bodyBytes=0;
 const error=message=>Object.assign(new Error(message),{code:'SVN_CAPTURE_BUDGET'});
 return Object.freeze({signal:deadline,reserve(){deadline.throwIfAborted();if(++commands>512)throw error('SVN capture shared command budget exceeded');},charge(size,body=false){deadline.throwIfAborted();if(!Number.isSafeInteger(size)||size<0)throw error('Invalid SVN capture byte charge');if(body){bodyBytes+=size;if(bodyBytes>16*1024*1024)throw error('SVN capture shared verification body budget exceeded');}else{metadataBytes+=size;if(metadataBytes>1024*1024)throw error('SVN capture shared metadata budget exceeded');}},usage(){return {commands,metadataBytes,bodyBytes};}});
}
