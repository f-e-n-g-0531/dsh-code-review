// Work quantity, never a provider reasoning-effort or evidence guarantee.
export function reviewRounds(value=1){
 if(!Number.isSafeInteger(value)||value<1||value>3)throw new Error('reviewRounds must be an integer from 1 to 3');
 return value;
}
