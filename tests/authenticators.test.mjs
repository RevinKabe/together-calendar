import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticatorEnrollment, verifiedAuthenticators, authenticatorLabel } from '../site/authenticators.js';

const deferred = () => { let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve}; };
function fixture() {
  const factors=[{id:'original',status:'verified',friendly_name:'Together 123456'}];
  const deleted=[], challenged=[];
  let assurance='aal2', enrollGate=null, verifyGate=null, failedVerification=false;
  const mfa={
    async listFactors(){return {data:{totp:structuredClone(factors.filter(f=>f.status==='verified')),all:structuredClone(factors)}};},
    async getAuthenticatorAssuranceLevel(){return {data:{currentLevel:assurance}};},
    async enroll({friendlyName}){if(enrollGate)await enrollGate.promise;factors.push({id:'new',status:'unverified',friendly_name:friendlyName});return {data:{id:'new',totp:{qr_code:'<svg/>',secret:'TEST_ONLY'}}};},
    async challengeAndVerify({factorId,code}){
      challenged.push(factorId);
      if(factorId==='new' && verifyGate)await verifyGate.promise;
      const expected=factorId==='original'?'123456':'654321';
      if(code!==expected)return {error:new Error('Incorrect phone/code')};
      if(factorId==='new')factors.find(f=>f.id==='new').status='verified';
      if(failedVerification)return {error:new Error('Network response lost')};
      return {data:{}};
    },
    async unenroll({factorId}){assert.notEqual(factorId,'original');deleted.push(factorId);factors.splice(factors.findIndex(f=>f.id===factorId),1);return {data:{}};}
  };
  return {flow:createAuthenticatorEnrollment(mfa),factors,deleted,challenged,
    setAssurance(value){assurance=value;},delayEnroll(){return enrollGate=deferred();},delayVerify(){return verifyGate=deferred();},loseVerificationResponse(){failedVerification=true;}};
}

test('only verified TOTP factors are choices; legacy factors get readable labels',()=>{
  assert.deepEqual(verifiedAuthenticators({totp:[{id:'one',status:'verified'},{id:'two',status:'unverified'}]}).map(f=>f.id),['one']);
  assert.equal(authenticatorLabel({friendly_name:'Together 12345'},0),'Phone 1 (existing authenticator)');
  assert.equal(authenticatorLabel({friendly_name:'Alina’s phone'},1),'Alina’s phone');
});
test('adding a phone requires a correct code from an already verified factor',async()=>{
  const f=fixture();
  await assert.rejects(f.flow.enroll('Second phone'),/Verify an existing/);
  await assert.rejects(f.flow.authorize('new','654321'),/existing verified/);
  await assert.rejects(f.flow.authorize('original','000000'),/Incorrect/);
  await assert.rejects(f.flow.enroll('Second phone'),/Verify an existing/);
  assert.equal(f.factors.length,1);
});
test('new phone must verify its own code and original factor remains untouched',async()=>{
  const f=fixture(); await f.flow.authorize('original','123456');
  await f.flow.enroll('Second phone');
  await assert.rejects(f.flow.verify('123456'),/Incorrect/);
  assert.equal(f.factors[1].status,'unverified');
  assert.equal(await f.flow.verify('654321'),true);
  await f.flow.cancel();
  assert.deepEqual(f.factors.map(f=>f.status),['verified','verified']);
  assert.deepEqual(f.deleted,[]);
  assert.deepEqual(f.challenged,['original','new','new']);
});
test('expired assurance and invalid names prevent enrollment',async()=>{
  const f=fixture(); await f.flow.authorize('original','123456');
  for(const name of ['','x'.repeat(49),'phone\nname']) await assert.rejects(f.flow.enroll(name),/phone name/);
  f.setAssurance('aal1'); await assert.rejects(f.flow.enroll('Phone'),/Sign in/);
  assert.equal(f.factors.length,1);
});
test('cancel removes only this setup’s unverified factor',async()=>{
  const f=fixture(); await f.flow.authorize('original','123456');await f.flow.enroll('Phone');
  f.factors.push({id:'another-setup',status:'unverified'});
  await f.flow.cancel(); await f.flow.cancel();
  assert.deepEqual(f.deleted,['new']);
  assert.deepEqual(f.factors.map(f=>f.id),['original','another-setup']);
  await assert.rejects(f.flow.verify('654321'),/closed/);
});
test('cancellation during enrollment hides its secret and cleans up after the request',async()=>{
  const f=fixture();await f.flow.authorize('original','123456');const gate=f.delayEnroll();
  const enrollment=f.flow.enroll('Phone');await new Promise(done=>setImmediate(done));
  const cancellation=f.flow.cancel();gate.resolve();
  assert.equal(await enrollment,null);await cancellation;
  assert.deepEqual(f.deleted,['new']);assert.equal(f.factors[0].id,'original');
});
test('cancellation during verification never removes the successfully added phone',async()=>{
  const f=fixture();await f.flow.authorize('original','123456');await f.flow.enroll('Phone');
  const gate=f.delayVerify(), verification=f.flow.verify('654321');await new Promise(done=>setImmediate(done));
  const cancellation=f.flow.cancel();gate.resolve();
  assert.equal(await verification,false);await cancellation;
  assert.deepEqual(f.deleted,[]);assert.equal(f.factors[1].status,'verified');
});
test('lost verification response does not delete a server-verified factor',async()=>{
  const f=fixture();await f.flow.authorize('original','123456');await f.flow.enroll('Phone');
  f.loseVerificationResponse();await assert.rejects(f.flow.verify('654321'),/Network/);
  await f.flow.cancel();assert.deepEqual(f.deleted,[]);assert.equal(f.factors[1].status,'verified');
});
