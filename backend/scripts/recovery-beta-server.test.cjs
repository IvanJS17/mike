'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {createRecordedFakeDrive} = require('./recovery-beta-server.cjs');
function file() { return `/tmp/litt-beta-${crypto.randomBytes(24).toString('hex')}-drive.json`; }
const bytes = Buffer.from('synthetic approved artifact');
const input = {publication_id:'11111111-1111-4111-8111-111111111111',folder_id:'synthetic-folder',idempotency_key:'synthetic-key',artifact_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),artifact_size_bytes:bytes.length,bytes};
test('lost ACK records actual fake remote bytes and one upload; lookup does not upload',async()=>{
  const path=file();
  try {
    const drive=createRecordedFakeDrive(path);
    assert.equal(drive.kind,'fake');assert.equal(drive.host,'fake');
    await assert.rejects(drive.upload(input));
    let state=JSON.parse(fs.readFileSync(path));
    assert.equal(state.uploadCount,1);
    assert.equal(state.objects.length,1);
    assert.deepEqual(Buffer.from(state.objects[0].bytes_base64,'base64'),bytes);
    assert.equal(state.objects[0].sha256,input.artifact_sha256);
    assert.equal((await drive.find(input)).disposition,'unknown');
    assert.equal((await drive.find(input)).disposition,'unknown');
    const result=await drive.find(input);assert.equal(result.disposition,'found');
    state=JSON.parse(fs.readFileSync(path));assert.equal(state.uploadCount,1);assert.equal(state.findCount,3);
    assert.equal(fs.statSync(path).mode & 0o777,0o600);
    assert.equal((await drive.find({...input,folder_id:'other'})).disposition,'unknown');
    state=JSON.parse(fs.readFileSync(path));assert.equal(state.uploadCount,1);assert.equal(state.objects.length,1);
  } finally { fs.rmSync(path,{force:true}); }
});
test('fixture output is exclusive and confined; preexisting data is preserved',()=>{
  const path=file();fs.writeFileSync(path,'preexisting',{mode:0o600});
  try {
    assert.throws(()=>createRecordedFakeDrive(path));assert.equal(fs.readFileSync(path,'utf8'),'preexisting');
    for(const invalid of ['/tmp/other.json','/app/state.json','relative.json',path+'/../escape'])assert.throws(()=>createRecordedFakeDrive(invalid));
  } finally {fs.rmSync(path,{force:true});}
});
