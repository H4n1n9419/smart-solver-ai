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
   const old=await store.get("repair-state",{type:"json"});
   // Resume an unfinished run instead of rejecting it. This avoids a stuck
   // state when the browser was closed or a previous request timed out.
   if(old&&!old.done){
    return reply({ok:true,done:false,resumed:true,processed:old.processed||0});
   }
   await store.setJSON("repair-state",{cursor:null,processed:0,ids:[],done:false,startedAt:new Date().toISOString()});
   return reply({ok:true,done:false,resumed:false,processed:0});
  }
  if(action==="step"){
   const state=await store.get("repair-state",{type:"json"});
   if(!state)return reply({error:"Belum ada proses pemulihan. Tekan tombol sekali lagi."},400);
   if(state.done)return reply({ok:true,done:true,total:state.ids.length,processed:state.processed});
   const page=await store.list({prefix:"q:",...(state.cursor?{cursor:state.cursor}:{}),limit:100});
   const ids=[...state.ids],tokenSets=new Map();
   for(const blob of (page.blobs||[])){
    const id=blob.key.slice(2); if(!id)continue;
    const record=await store.get(blob.key,{type:"json"}); if(!record||!record.question||!record.answer)continue;
    ids.push(id);
    for(const token of words(record.question)){
     if(!tokenSets.has(token))tokenSets.set(token,new Set());
     tokenSets.get(token).add(id);
    }
   }
   for(const [token,newIds] of tokenSets){
    const k=`tok:${sha(token)}`,existing=await store.get(k,{type:"json"})||[];
    const merged=new Set([...existing,...newIds]);
    await store.setJSON(k,[...merged]);
   }
   const processed=state.processed+(page.blobs||[]).length;
   const next=page.cursor||null,done=!next;
   await store.setJSON("repair-state",{cursor:next,processed,ids,done,startedAt:state.startedAt});
   if(done){
    const unique=[...new Set(ids)];
    await store.setJSON("index",{ids:unique,exact:{}});
    return reply({ok:true,done:true,total:unique.length,processed});
   }
   return reply({ok:true,done:false,processed,totalSoFar:ids.length});
  }
  if(action==="status"){
   const s=await store.get("repair-state",{type:"json"});
   return reply({ok:true,state:s||null});
  }
  return reply({error:"Aksi tidak dikenal"},400);
 }catch(e){console.error("repair-index:",e);return reply({error:e.message||"Server error"},500);}
}
