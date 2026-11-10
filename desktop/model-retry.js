function retryableModelError(error,signal){
  if(signal?.aborted)return false;
  return !/账号已退出|请求已停止|未配置|模型未配置|API ?key|权限不足|余额不足|账户余额|额度不足|未开通|内容政策|policy|401|402|403|429|速率限制|请求过于频繁|rate.?limit|quota|超12MB|请求超过/i.test(String(error?.message||error));
}

async function retryModelJson(run,{signal,autoRetries=3,onRetry=async()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  let retries=0;
  while(true){
    try{return await run();}
    catch(error){
      if(!retryableModelError(error,signal)||retries>=autoRetries){
        const failure=error instanceof Error?error:new Error(String(error));
        failure.retryCount=retries;
        throw failure;
      }
      retries++;
      await onRetry(retries,error);
      await sleep(Math.min(2000,250*2**(retries-1)));
    }
  }
}

module.exports={retryableModelError,retryModelJson};
