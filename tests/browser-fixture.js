// ONLY loaded by scripts/serve-fixture.mjs. No real account, credential or network.
window.TOGETHER_CONFIG={supabaseUrl:'https://local-fixture.supabase.co',supabasePublishableKey:'sb_publishable_test_only'};
const testUser={id:'00000000-0000-4000-8000-000000000001',email:'test@example.invalid',user_metadata:{display_name:'Test user'}};
let assurance='aal1', listener=()=>{}, sequence=0;
let data=JSON.parse(localStorage.getItem('together-test-ciphertext-v2')||sessionStorage.getItem('together-test-ciphertext-v2')||'null')||{workspaces:[],workspace_members:[],encrypted_records:[]};
function persistFixture(){localStorage.setItem('together-test-ciphertext-v2',JSON.stringify(data));}
function syncFixture(){data=JSON.parse(localStorage.getItem('together-test-ciphertext-v2'))||data;}
persistFixture();
const diagnostics=document.createElement('p');diagnostics.id='fixture-status';diagnostics.setAttribute('role','status');
diagnostics.textContent='LOCAL TEST: no network. Verify with test code 123456.';document.body.append(diagnostics);
function inspect(value){
  const text=JSON.stringify(value);
  if(text.includes('together1_')||/Private browser (space|appointment|task)/.test(text))throw new Error('Plaintext leaked into a backend request');
  diagnostics.textContent='LOCAL TEST: '+(++sequence)+' encrypted writes; no content or key in requests.';
}
function query(table){
  let operation='select',values,filters=[],single=false,range=null;
  const builder={
    select(){return builder;},order(){return builder;},eq(k,v){filters.push([k,v]);return builder;},range(a,b){range=[a,b];return builder;},
    insert(v){operation='insert';values=v;return builder;},update(v){operation='update';values=v;return builder;},delete(){operation='delete';return builder;},
    single(){single=true;return builder;},maybeSingle(){single=true;return builder;},
    then(resolve,reject){return Promise.resolve().then(()=>{
      if(assurance!=='aal2')throw new Error('MFA required by test backend');
      syncFixture();
      let rows=data[table].filter(row=>filters.every(([k,v])=>row[k]===v));
      if(operation==='insert'){inspect(values);const row={...values,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};data[table].push(row);rows=[row];}
      if(operation==='update'){inspect(values);rows.forEach(row=>Object.assign(row,values,{updated_at:new Date().toISOString()}));}
      if(operation==='delete')data[table]=data[table].filter(row=>!rows.includes(row));
      if(operation!=='select')persistFixture();
      if(range)rows=rows.slice(range[0],range[1]+1);
      return {data:structuredClone(single?rows[0]||null:rows),error:null};
    }).then(resolve,reject);}
  };return builder;
}
window.supabase={createClient(url,key,options){
  if(options.auth.persistSession!==false)throw new Error('Test requires memory-only sessions');
  return {
    from:query,
    async rpc(name,args){
      if(assurance!=='aal2')return {error:new Error('MFA required')};
      syncFixture();
      inspect(args);
      if(name==='create_workspace'){
        data.workspaces.push({id:args.space_id,key_epoch:args.initial_epoch,encrypted_name:args.space_name,owner_id:testUser.id,created_at:new Date().toISOString()});
        data.workspace_members.push({workspace_id:args.space_id,user_id:testUser.id,display_name:'Test user'});
        persistFixture();
        return {data:args.space_id,error:null};
      }
      if(name==='create_workspace_invite')return {data:'a'.repeat(64),error:null};
      if(name==='rotate_workspace_key'){
        const space=data.workspaces.find(item=>item.id===args.target_workspace);
        Object.assign(space,{key_epoch:args.next_epoch,encrypted_name:args.space_name});
        args.replacements.forEach(item=>Object.assign(data.encrypted_records.find(row=>row.id===item.id),{ciphertext:item.ciphertext,key_epoch:args.next_epoch,updated_at:new Date().toISOString()}));
        persistFixture();
      }
      return {data:null,error:null};
    },
    auth:{
      async getSession(){return {data:{session:{user:testUser}},error:null};},
      onAuthStateChange(fn){listener=fn;return {data:{subscription:{unsubscribe(){}}}};},
      async signOut(){listener('SIGNED_OUT',null);return {error:null};},
      mfa:{
        async getAuthenticatorAssuranceLevel(){return {data:{currentLevel:assurance},error:null};},
        async listFactors(){return {data:{totp:[{id:'test-factor',status:'verified'}]},error:null};},
        async challengeAndVerify({code}){if(code!=='123456')return {error:new Error('Invalid test code')};assurance='aal2';return {data:{},error:null};}
      }
    }
  };
}};
