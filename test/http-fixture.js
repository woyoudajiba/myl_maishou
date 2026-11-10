// Windows may allocate a random port prohibited by the Fetch standard (for example 6000).
// Rebind fixtures only in that case, keeping real HTTP requests and normal failures visible.
exports.startFetchSafeServer=async function(service){
  for(let attempt=0;attempt<10;attempt++){
    const address=await service.start(),origin=`http://127.0.0.1:${address.port}`;
    try{const response=await fetch(origin+'/health');await response.arrayBuffer();return origin;}
    catch(error){if(error.cause?.message!=='bad port')throw error;await new Promise(resolve=>service.server.close(resolve));}
  }
  throw new Error('Could not allocate a Fetch-compatible test port');
};
