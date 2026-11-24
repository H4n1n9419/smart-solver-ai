import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { promisify } from "node:util";
const scrypt=promisify(crypto.scrypt);
const reply=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
const norm=v=>String(v??"").toLocaleLowerCase("id").normalize("NFKC").replace(/\s+/g," ").trim();
const sha=v=>crypto.createHash("sha256").update(String(v)).digest("hex");
const words=v=>[...new Set(norm(v).split(/[^\p{L}\p{N}]+/u).filter(x=>x.length>1))].slice(0,30);
const shard=id=>String(id).replace(/-/g,"")[0]||"0", SHARDS="0123456789abcdef";
const CONCURRENCY=20;
// Runs up to `limit` calls to fn() at once instead of one-at-a-time; this is the
// single biggest fix for "Pemulihan terhenti" on large banks (Blobs round-trips were serial before).
async function mapLimit(items,limit,fn){
 const results=new Array(items.length);let idx=0;
 async function worker(){while(idx<items.length){const i=idx++;results[i]=await fn(items[i],i);}}
 await Promise.all(Array.from({length:Math.min(limit,items.length)||0},worker));
 return results;
}
async function verify(store,k){const s=await store.get("admin-password",{type:"json"});if(!s)return !!process.env.KNOWLEDGE_ADMIN_KEY&&k===process.env.KNOWLEDGE_ADMIN_KEY;const d=await scrypt(k,Buffer.from(s.salt,"hex"),64);return d.length===Buffer.from(s.hash,"hex").length&&crypto.timingSafeEqual(d,Buffer.from(s.hash,"hex"));}
export default async function handler(req){
 if(req.method!=="POST")return reply({error:"Method not allowed"},405);
 try{
  const store=getStore("smart-solver-questions"),key=req.headers.get("x-admin-key")||"";if(!await verify(store,key))return reply({error:"Kunci admin tidak cocok"},401);
  const b=await req.json();
  if(b.action==="start"){
   let s=await store.get("repair-v3",{type:"json"});
   if(!s||s.done){s={run:crypto.randomUUID(),cursor:null,processed:0,done:false,startedAt:new Date().toISOString()};await store.setJSON("repair-v3",s);}
   return reply({ok:true,done:s.done,processed:s.processed,resumed:true});
  }
  if(b.action==="step"){
   const s=await store.get("repair-v3",{type:"json"});if(!s)return reply({error:"Belum dimulai"},400);if(s.done)return reply({ok:true,done:true,processed:s.processed,total:s.total});
   const page=await store.list({prefix:"q:",...(s.cursor?{cursor:s.cursor}:{}),limit:50});
   const blobs=page.blobs||[];
   // Read this page's records in parallel instead of one await per record.
   const recs=await mapLimit(blobs,CONCURRENCY,blob=>store.get(blob.key,{type:"json"}));
   const valid=[];
   blobs.forEach((blob,i)=>{const rec=recs[i];if(rec?.question&&rec?.answer)valid.push({id:blob.key.slice(2),question:rec.question});});
   // Figure out every posting key this page touches, fetch them all in parallel,
   // merge the new ids in memory, then flush in parallel too.
   const perRecordTokens=valid.map(({id,question})=>{const bucket=shard(id);return {id,keys:words(question).map(t=>`tok2:${sha(t)}:${bucket}`)};});
   const neededKeys=new Set();perRecordTokens.forEach(r=>r.keys.forEach(k=>neededKeys.add(k)));
   const keyList=[...neededKeys];
   const existing=await mapLimit(keyList,CONCURRENCY,k=>store.get(k,{type:"json"}));
   const cache=new Map();keyList.forEach((k,i)=>cache.set(k,new Set(existing[i]||[])));
   perRecordTokens.forEach(r=>r.keys.forEach(k=>cache.get(k).add(r.id)));
   await mapLimit([...cache],CONCURRENCY,([k,v])=>store.setJSON(k,[...v]));
   const next=page.cursor||null,done=!next,updated={...s,cursor:next,processed:s.processed+blobs.length,done};
   await store.setJSON("repair-v3",updated);
   if(done){
    // Count is metadata only; no giant master ID array is built.
    await store.setJSON("meta:count",{count:updated.processed,verifiedAt:new Date().toISOString()});
    updated.total=updated.processed;await store.setJSON("repair-v3",updated);
    return reply({ok:true,done:true,processed:updated.processed,total:updated.total});
   }
   return reply({ok:true,done:false,processed:updated.processed,totalSoFar:updated.processed});
  }
  if(b.action==="status"){return reply({ok:true,state:await store.get("repair-v3",{type:"json"})||null});}
  return reply({error:"Aksi tidak dikenal"},400);
 }catch(e){console.error("repair-v3:",e);return reply({error:e.message||"Server error"},500);}
}
