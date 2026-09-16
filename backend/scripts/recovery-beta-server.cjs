'use strict';
// Local synthetic server harness. Production routers/services stay unchanged.
const fs = require('node:fs');
const crypto = require('node:crypto');
function createRecordedFakeDrive(path) {
  if(typeof path!=='string'||!/^\/tmp\/litt-beta-[0-9a-f]{48}-drive\.json$/.test(path))throw new Error('Invalid fake receipt path');
  const fd=fs.openSync(path,'wx',0o600);fs.closeSync(fd);
  require('tsx/cjs');
  const {createFakeDrive}=require('../src/lib/recovery/drive/fakeDrive.ts');
  const fake=createFakeDrive({throwAfterStore:true});
  const objects=new Map();let findCount=0;
  function save(){
    const stat=fs.lstatSync(path);
    if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode & 0o777)!==0o600)throw new Error('Invalid fake receipt ownership');
    fs.writeFileSync(path,JSON.stringify({format:1,uploadCount:fake.uploadCount,findCount,objects:[...objects.values()]}),{mode:0o600});
  }
  async function observe(input){
    const observed=await fake.find(input);
    if(observed.disposition==='found')for(const object of observed.objects){
      const bytes=Buffer.from(object.bytes);
      objects.set(object.file_id,{file_id:object.file_id,folder_id:object.folder_id,idempotency_key:object.idempotency_key,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size_bytes:bytes.length,bytes_base64:bytes.toString('base64')});
    }
    save();return observed;
  }
  save();
  return {
    kind:'fake',host:'fake',
    async upload(input){try{return await fake.upload(input);}finally{await observe(input);}},
    // The production service reconciles automatically after a lost upload ACK.
    // Hide lookup for that attempt and its retry; explicit reconciliation then
    // observes the real stored fake object. Recording never changes its bytes.
    async find(input){findCount++;const observed=await observe(input);return findCount<=2?{disposition:'unknown'}:observed;},
  };
}
function validEnvironment(env){
  return env.NODE_ENV==='development'&&env.PORT==='3001'&&env.SUPABASE_URL==='http://proxy:8000'&&env.R2_ENDPOINT_URL==='http://storage:9000'&&/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(env.FRONTEND_URL||'')&&env.API_PUBLIC_URL===env.FRONTEND_URL+'/api';
}
function main(){
  if(!validEnvironment(process.env)||process.argv.length!==3)throw new Error('Invalid local fixture environment');
  require('tsx/cjs');
  const transport=process.argv[2]==='--read-only'?null:createRecordedFakeDrive(process.argv[2]);
  const {app}=require('../src/app.ts');
  if(transport)app.locals.recoveryDriveTransport=transport;
  app.listen(3001,'0.0.0.0',()=>{
    console.log('Local synthetic Beta server ready');
    // The production entry (src/index.ts) owns background work, and
    // upload-session sealing depends on it (lease-based claims over Postgres).
    // Mirror its inline mode — with no workers the synthetic journey stalls in
    // document_upload_status forever.
    require('../src/workerRuntime.ts').startAllWorkers();
  });
}
module.exports={createRecordedFakeDrive,validEnvironment,main};
if(require.main===module){try{main();}catch{console.error('Beta fixture server failed');process.exitCode=1;}}
