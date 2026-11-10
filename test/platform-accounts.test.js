const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { PlatformAccounts } = require('../desktop/platform-accounts');
const { createDesktopBridge } = require('../desktop/bridge-server');
const key = crypto.randomBytes(32);
const storage = {
  encrypt(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm',key,iv); return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]).toString('base64'); },
  decrypt(value) { const b=Buffer.from(value,'base64'),cipher=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));cipher.setAuthTag(b.subarray(-16));return Buffer.concat([cipher.update(b.subarray(12,-16)),cipher.final()]).toString(); }
};
test('平台账号整包加密，快照无密码，重启保留和账号目录隔离，改账号需新密码', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'platform-accounts-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const accounts=new PlatformAccounts({dataDir:path.join(dir,'one'),storage});await accounts.load();
  await accounts.save('wsy',{username:'fixture-user',password:'fixture-password'});
  assert.equal(JSON.stringify(accounts.list()).includes('fixture-password'),false);
  const disk=await fs.readFile(accounts.file,'utf8');assert.equal(disk.includes('fixture-user'),false);assert.equal(disk.includes('fixture-password'),false);
  const restored=new PlatformAccounts({dataDir:path.join(dir,'one'),storage});await restored.load();assert.deepEqual(restored.credential('wsy'),{username:'fixture-user',password:'fixture-password'});
  await assert.rejects(restored.save('wsy',{username:'different',password:''}),/重新填写密码/);
  await restored.save('wsy',{username:'fixture-user',password:''});assert.equal(restored.credential('wsy').password,'fixture-password');
  const other=new PlatformAccounts({dataDir:path.join(dir,'two'),storage});await other.load();assert.equal(other.credential('wsy'),null);
  await restored.remove('wsy');assert.equal(restored.credential('wsy'),null);
});
test('平台凭据只对已配对扩展且 HTTPS 对应平台目标开放，退出后禁止读取', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'platform-credential-'));let active=true,reads=0;
  const bridge=createDesktopBridge({port:0,dataDir:dir,canAccess:()=>active,getPlatformCredential:()=>{reads++;return{username:'fixture-user',password:'fixture-password'};},processJob:async()=>{}});
  t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});const local=await bridge.start();
  const url=`http://127.0.0.1:${local.port}/v1/platform-credentials/wsy`;
  const headers={'content-type':'application/json','X-Desktop-Token':local.token,Origin:'chrome-extension://'+'a'.repeat(32)};
  const request=(h=headers,u='https://www.wsy.com/member/login.htm')=>fetch(url,{method:'POST',headers:h,body:JSON.stringify({loginUrl:u})});
  assert.equal((await request({...headers,'X-Desktop-Token':'wrong'})).status,401);
  assert.equal((await request({...headers,Origin:'https://example.com'})).status,403);
  assert.equal((await request(headers,'http://www.wsy.com/member/login.htm')).status,400);
  assert.equal((await request(headers,'https://www.17qcc.com/Login.html')).status,400);assert.equal(reads,0);
  assert.deepEqual((await(await request()).json()).credential,{username:'fixture-user',password:'fixture-password'});
  assert.equal(JSON.stringify(bridge.snapshot()).includes('fixture-password'),false);
  active=false;assert.equal((await request()).status,401);
});
