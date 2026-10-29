import { createDeviceKeyStore } from '/device-keys.js';
import { generateRecoveryKey, importRecoveryKey, encrypt, decrypt, context } from '/crypto.js';
const output=document.getElementById('results');
const scope='browser-security-test:'+crypto.randomUUID(), user=crypto.randomUUID(), otherUser=crypto.randomUUID(), space=crypto.randomUUID(), otherSpace=crypto.randomUUID(), epoch=crypto.randomUUID();
const store=createDeviceKeyStore(scope), other=createDeviceKeyStore(scope+':other');
const results=[];
function check(condition,message){if(!condition)throw new Error(message);results.push('PASS: '+message);}
async function rejects(fn,message){let rejected=false;try{await fn();}catch{rejected=true;}check(rejected,message);}
async function raw(operation){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('together-device-keys-v1',1);
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result,tx=db.transaction('keys','readwrite');let value;
      tx.oncomplete=()=>{db.close();resolve(value);};tx.onerror=()=>{db.close();reject(tx.error);};
      operation(tx.objectStore('keys'),result=>value=result);
    };
  });
}
try {
  const recovery=generateRecoveryKey(),key=await importRecoveryKey(recovery);
  check(await store.read(user,space,epoch)===null,'no key is saved by default');
  await store.save(user,space,epoch,key);
  const restored=await createDeviceKeyStore(scope).read(user,space,epoch);
  check(restored instanceof CryptoKey && !restored.extractable,'native IndexedDB restores a non-extractable CryptoKey');
  await rejects(()=>crypto.subtle.exportKey('raw',restored),'restored key cannot be exported as raw key bytes');
  const aad=context(space,epoch),sealed=await encrypt(key,{name:'Fictional secret'},aad);
  check((await decrypt(restored,sealed,aad)).name==='Fictional secret','restored key decrypts existing ciphertext');
  const row=await raw((table,result)=>{table.get([scope,user,space]).onsuccess=event=>result(event.target.result);});
  check(Object.keys(row).sort().join(',')==='epoch,key,scope,userId,v,workspaceId' && !JSON.stringify(row).includes(recovery),'stored record contains no recovery string or calendar content');
  check(await store.read(otherUser,space,epoch)===null,'a different account cannot load the key');
  check(await store.read(user,otherSpace,epoch)===null,'a different workspace cannot load the key');
  check(await other.read(user,space,epoch)===null,'a different project/app scope cannot load the key');
  await store.forget(user,space,crypto.randomUUID());
  check(await store.read(user,space,epoch)!==null,'stale-epoch removal does not delete a replacement key');
  check(await store.read(user,space,crypto.randomUUID())===null,'a changed encryption epoch cannot reuse the old key');
  check(await store.read(user,space,epoch)===null,'stale saved key is deleted');
  const extractable=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  await rejects(()=>store.save(user,space,epoch,extractable),'extractable keys are rejected before persistence');
  const wrongAlgorithm=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  await rejects(()=>store.save(user,space,epoch,wrongAlgorithm),'non-calendar keys are rejected');
  await rejects(()=>store.save('invalid',space,epoch,key),'malformed account identity is rejected');
  await raw(table=>table.put({...row,key:extractable}));
  check(await store.read(user,space,epoch)===null,'malformed stored key is rejected and removed');
  await Promise.all([store.save(user,space,epoch,key),store.forget(user,space)]);
  check(await store.read(user,space,epoch)===null,'Forget waits for an earlier Save and removes it');
  await store.save(user,space,epoch,key);await store.save(user,otherSpace,epoch,key);await store.save(otherUser,space,epoch,key);
  await store.prune(user,[{id:space,key_epoch:epoch}]);
  check(await store.read(user,otherSpace,epoch)===null,'revoked-space key is removed during membership refresh');
  check(await store.read(otherUser,space,epoch)!==null,'membership pruning stays within the current account');
  await other.save(user,space,epoch,key);await store.forgetAll();
  check(await store.read(user,space,epoch)===null && await store.read(otherUser,space,epoch)===null,'Forget all removes this app’s saved keys across accounts');
  check(await other.read(user,space,epoch)!==null,'Forget all preserves other application scopes');
  let blocked=true;
  const flaky=createDeviceKeyStore(scope,{open(...args){if(blocked)throw new Error('Storage disabled');return indexedDB.open(...args);}});
  await rejects(()=>flaky.save(user,space,epoch,key),'unavailable storage reports failure instead of claiming success');
  blocked=false;await flaky.save(user,space,epoch,key);
  check(await flaky.read(user,space,epoch)!==null,'storage failure does not poison later operations');
  output.dataset.status='passed';output.textContent=`${results.length} checks passed.\n`+results.join('\n');
} catch(error) {output.dataset.status='failed';output.textContent=results.join('\n')+'\nFAIL: '+error.message;}
finally {await store.forgetAll();await other.forgetAll();}
