import { isDeepStrictEqual } from 'node:util';
// Internal scope projection only; never an extra public source authority.
export function approvedRetrievalSnapshot(review,approved=review) {
  if(approved===review)return review;
  if(!approved||review.id!==approved.id||!Array.isArray(review.files)||review.files.length!==approved.files?.length)throw new Error('Incremental source identity mismatch');
  const expected=structuredClone(approved);
  for(let i=0;i<review.files.length;i++){
    const target=review.files[i],source=expected.files[i];
    if(target.eligibility==='excluded'&&target.reason==='incremental-unchanged-not-reviewed'&&source.eligibility==='reviewable'){source.eligibility=target.eligibility;source.reason=target.reason;}
  }
  if(!isDeepStrictEqual(expected,review))throw new Error('Incremental projection changed approved source or metadata');
  return structuredClone(approved);
}
