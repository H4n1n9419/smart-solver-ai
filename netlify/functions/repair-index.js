import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { promisify } from "node:util";
const scrypt=promisify(crypto.scrypt);
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
const norm=v=>String(v??"").toLocaleLowerCase("id").normalize("NFKC").replace(/\s+/g," ").trim();
const sha=v=>crypto.createHash("sha256").update(String(v)).digest("hex");
const words=v=>[...new Set(norm(v).split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>1))].slice(0,30);
async function verifyAdmin(store,candidate){
 const saved=await store.get("admin-password",{type:"json"});
 if(!saved)return Boolean(process.env.KNOWLEDGE_ADMIN_KEY)&&candidate===process.env.KNOWLEDGE_ADMIN_KEY;
 const derived=await scrypt(candidate,Buffer.from(saved.salt,"hex"),64);
 return crypto.timingSafeEqual(derived,Buffer.from(saved.hash,"hex"));
}
export default async function handler(request){
 if(request.method!=="POST")return reply({error:"Method not allowed"},405);
 try{
  const store=getStore("smart-solver-questions"),key=request.headers.get("x-admin-key")||"";
  if(!(await verifyAdmin(store,key)))return reply({error:"Kunci admin tidak cocok"},401);
  const body=await request.json(),action=body.action;
  if(action==="start"){
   let state=await store.get("repair-state",{type:"json"});
   if(!state||state.done){
    const run=crypto.randomUUID();
    state={run,cursor:null,page:0,processed:0,done:false,startedAt:new Date().toISOString()};
    await store.setJSON("repair-state",state);
   }
   return reply({ok:true,done:state.done,resumed:true,processed:state.processed||0});
  }
  if(action==="step"){
   const state=await store.get("repair-state",{type:"json"});
   if(!state)return reply({error:"Belum ada proses pemulihan. Tekan tombol Pulihkan Indeks."},400);
   if(state.done)return reply({ok:true,done:true,total:state.total||0,processed:state.processed||0});
   const page=await store.list({prefix:"q:",...(state.cursor?{cursor:state.cursor}:{}),limit:100});
   const ids=[],tokenAdds=new Map();
   for(const blob of (page.blobs||[])){
    if(!blob.key.startsWith("q:"))continue;
    const id=blob.key.slice(2);if(!id)continue;
    const record=await store.get(blob.key,{type:"json"});
    if(!record||!record.question||!record.answer)continue;
    ids.push(id);
    for(const token of words(record.question)){
     if(!tokenAdds.has(token))tokenAdds.set(token,new Set());
     tokenAdds.get(token).add(id);
    }
   }
   // Merge token index entries idempotently. The cursor advances only after
   // this page's records and page-ID shard have been persisted.
   for(const [token,additions] of tokenAdds){
    const k=`tok:${sha(token)}`,existing=await store.get(k,{type:"json"})||[];
    const merged=new Set([...existing,...additions]);
    await store.setJSON(k,[...merged]);
   }
   const pageKey=`repair-ids:${state.run}:${state.page}`;
   await store.setJSON(pageKey,ids);
   const next=page.cursor||null,done=!next;
   const updated={...state,cursor:next,page:state.page+1,processed:state.processed+(page.blobs||[]).length,done};
   await store.setJSON("repair-state",updated);
   if(done){
    const all=[];
    for(let n=0;n<updated.page;n++){
     const part=await store.get(`repair-ids:${state.run}:${n}`,{type:"json"})||[];
     all.push(...part);
    }
    const unique=[...new Set(all)];
    await store.setJSON("index",{ids:unique,exact:{}});
    updated.total=unique.length;
    await store.setJSON("repair-state",updated);
    return reply({ok:true,done:true,total:unique.length,processed:updated.processed});
   }
   return reply({ok:true,done:false,processed:updated.processed,totalSoFar:state.processed+ids.length});
  }
  if(action==="status"){
   const s=await store.get("repair-state",{type:"json"});
   return reply({ok:true,state:s||null});
  }
  return reply({error:"Aksi tidak dikenal"},400);
 }catch(e){console.error("repair-index:",e);return reply({error:e.message||"Server error"},500);}
}
