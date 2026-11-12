const {OnlineTableClient}=require('./online-table-client');
const {sourceLink}=require('./buyer-import');

const sameSource=(task,row)=>{
  const local=sourceLink(task.sourceUrl),remote=sourceLink(row?.sourceUrl);
  return !!local&&!!remote&&local.sourceType===remote.sourceType&&local.sourceUrl===remote.sourceUrl;
};
const bindingError=message=>Object.assign(new Error(message),{tag:'表格任务关联失效',status:409});

// A task owns its table connection. Changing the table displayed in the UI must not reroute writes.
async function resolveOnlineTask({task,settings,authToken,workflow,transport}){
  if(!task?.onlineTableRowId)return null;
  let tableId=task.onlineTableId||settings.value.onlineTableId;
  const makeClient=id=>new OnlineTableClient({tableId:id,authToken,...(transport?{transport}:{})});
  let client=makeClient(tableId),located;
  const matches=result=>result?.row?.id===task.onlineTableRowId&&result.row.taskId===task.id&&sameSource(task,result.row);
  const locate=async connection=>{try{return await connection.locateRow({rowId:task.onlineTableRowId});}catch(error){if(error.status===404)return null;throw error;}};
  located=await locate(client);
  // Older installations stored only the row UUID. Discover its table using the exact saved identity.
  if(!matches(located)&&!task.onlineTableId){
    const {tables=[]}=await client.listTables();
    for(const table of tables){
      if(table.id===tableId)continue;
      const candidate=makeClient(table.id),result=await locate(candidate);
      if(matches(result)){client=candidate;tableId=table.id;located=result;break;}
    }
  }
  if(!located)throw bindingError('原表格行已删除或不在此表中，请从当前表格确认商品；旧任务不能继续。');
  if(!matches(located))throw bindingError('表格行的任务 ID 或商品链接已变化，请从当前表格打开对应任务；旧任务不能继续。');
  const row=located.row;
  if(!task.onlineTableId)await workflow.patchTask(task.id,{onlineTableId:tableId},'已核验并补齐旧任务的在线表格关联');
  return{client,row,offset:located.offset,tableId};
}

module.exports={resolveOnlineTask,sameSource};
