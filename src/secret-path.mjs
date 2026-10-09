// Pure path policy; never inspect credential contents or infer safe contents.
export function isSecretPath(value) {
 if(typeof value!=='string')return false;
 const parts=value.replaceAll('\\','/').toLowerCase().split('/'),base=parts.at(-1);
 if(parts.includes('.ssh'))return true;
 if(['id_rsa','id_dsa','id_ecdsa','id_ed25519','.netrc','_netrc','.npmrc','.pypirc','.dockercfg'].includes(base))return true;
 return (base==='.env'||base.startsWith('.env.'))&&!['.env.example','.env.sample','.env.template'].includes(base);
}
export function assertNonSecretPath(path){if(isSecretPath(path))throw new Error('Credential path excluded');}
