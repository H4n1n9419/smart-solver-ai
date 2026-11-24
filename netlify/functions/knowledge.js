import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { promisify } from "node:util";
const scrypt=promisify(crypto.scrypt);
const reply=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
const norm=v=>String(v??"").toLocaleLowerCase("id").normalize("NFKC").replace(/\s+/g," ").trim();
const sha=v=>crypto.createHash("sha256").update(String(v)).digest("hex");
const words=v=>[...new Set(norm(v).split(/[^\p{L}\p{N}]+/u).filter(x=>x.length>1))].slice(0,30);
const qkey=id=>`q:${id}`, pairKey=x=>`pair:${sha(norm(x.question)+"\u0000"+norm(x.answer))}`;
const shard=id=>String(id).replace(/-/g,"")[0]||"0";
const tokKey=(token,b)=>`tok2:${sha(token)}:${b}`;
const MAX_BATCH=100, SHARDS="0123456789abcdef";
async function verifyAdmin(store,k){
 const saved=await store.get("admin-password",{type:"json"});
 if(!saved)return !!process.env.KNOWLEDGE_ADMIN_KEY&&k===process.env.KNOWLEDGE_ADMIN_KEY;
 const d=await scrypt(k,Buffer.from(saved.salt,"hex"),64);
 return d.length===Buffer.from(saved.hash,"hex").length&&crypto.timingSafeEqual(d,Buffer.from(saved.hash,"hex"));
}
async function callAI(provider,prompt){
 const signal=AbortSignal.timeout(22000);
 if(provider==="gemini"&&process.env.GEMINI_API_KEY){
  const model=process.env.GEMINI_MODEL||"gemini-2.0-flash";
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:.2,maxOutputTokens:900}}),signal});
  const j=await r.json();if(!r.ok)throw Error(j.error?.message||`Gemini ${r.status}`);return j.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("\n").trim()||"";
 }
 let url,key,model,headers={};
 if(provider==="groq"){url="https://api.groq.com/openai/v1/chat/completions";key=process.env.GROQ_API_KEY;model=process.env.GROQ_MODEL||"llama-3.3-70b-versatile";}
 if(provider==="mistral"){url="https://api.mistral.ai/v1/chat/completions";key=process.env.MISTRAL_API_KEY;model=process.env.MISTRAL_MODEL||"mistral-small-latest";}
 if(provider==="openrouter"){url="https://openrouter.ai/api/v1/chat/completions";key=process.env.OPENROUTER_API_KEY;model=process.env.OPENROUTER_MODEL||"openrouter/auto";headers={"HTTP-Referer":process.env.SITE_URL||"https://smartsolverai.netlify.app","X-Title":"SMART AIRA AI"};}
 if(provider==="cloudflare"&&process.env.CF_ACCOUNT_ID&&process.env.CF_API_TOKEN){
  const m=process.env.CF_AI_MODEL||"@cf/meta/llama-3.1-8b-instruct";
  const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${m}`,{method:"POST",headers:{Authorization:`Bearer ${process.env.CF_API_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"system",content:"Jawab Bahasa Indonesia, jelas, jangan mengarang."},{role:"user",content:prompt}]}),signal});
  const j=await r.json();if(!r.ok||j.success===false)throw Error(j.errors?.[0]?.message||`Cloudflare ${r.status}`);return j.result?.response||"";
 }
 if(!url||!key)throw Error(`${provider}: API key belum diatur`);
 const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`,...headers},body:JSON.stringify({model,messages:[{role:"system",content:"Kamu asisten SMART AIRA. Jawab Bahasa Indonesia, jelas, langsung, dan jangan mengarang fakta."},{role:"user",content:prompt}],temperature:.2,max_tokens:900}),signal});
 const j=await r.json();if(!r.ok)throw Error(j.error?.message||`${provider} ${r.status}`);return j.choices?.[0]?.message?.content?.trim()||"";
}
async function addRecord(store,item,cache){
 const question=String(item?.question??item?.soal??"").trim(),answer=String(item?.answer??item?.jawaban??"").trim();
 if(!question||!answer)return "skipped";
 const pair=pairKey({question,answer});
 if(await store.get(pair))return "duplicate";
 const id=crypto.randomUUID(),record={id,question,answer,updatedAt:new Date().toISOString()};
 await store.setJSON(qkey(id),record);
 await store.set(pair,id);
 const b=shard(id);
 for(const t of words(question)){
  const k=tokKey(t,b);
  if(!cache.has(k))cache.set(k,new Set(await store.get(k,{type:"json"})||[]));
  cache.get(k).add(id);
 }
 return "added";
}
async function flushCache(store,cache){for(const [k,v] of cache)await store.setJSON(k,[...v]);}
async function listPage(store,cursor,limit){
 const p=await store.list({prefix:"q:",...(cursor?{cursor}:{}),limit});
 const items=[];
 for(const b of p.blobs||[]){const x=await store.get(b.key,{type:"json"});if(x)items.push(x);}
 return {items,cursor:p.cursor||null};
}
export default async function handler(req){
 if(req.method!=="POST")return reply({error:"Method not allowed"},405);
 try{
  const body=await req.json(),action=body.action,store=getStore("smart-solver-questions"),admin=req.headers.get("x-admin-key")||"";
  const protectedActions=["admin-check","change-password","add","bulk-add","update","delete","export"];
  if(protectedActions.includes(action)&&!(await verifyAdmin(store,admin)))return reply({error:"Kunci admin tidak cocok"},401);
  if(action==="admin-check")return reply({ok:true});
  if(action==="change-password"){
   const p=String(body.newPassword||"");if(p.length<12||p===admin)return reply({error:"Kunci baru minimal 12 karakter dan harus berbeda"},400);
   const salt=crypto.randomBytes(16),hash=await scrypt(p,salt,64);await store.setJSON("admin-password",{salt:salt.toString("hex"),hash:hash.toString("hex"),updatedAt:new Date().toISOString()});return reply({ok:true});
  }
  if(action==="add"||action==="bulk-add"){
   const arr=action==="add"?[body]:body.items;if(!Array.isArray(arr)||!arr.length)return reply({error:"Data kosong atau format salah"},400);
   if(arr.length>MAX_BATCH)return reply({error:"Maksimal 100 pasangan per batch"},413);
   const cache=new Map();let added=0,duplicates=0,skipped=0;
   for(const item of arr){const x=await addRecord(store,item,cache);if(x==="added")added++;else if(x==="duplicate")duplicates++;else skipped++;}
   await flushCache(store,cache);
   const count=await store.get("meta:count",{type:"json"})||{count:0};count.count+=added;await store.setJSON("meta:count",count);
   return reply({ok:true,added,duplicates,skipped,total:count.count});
  }
  if(action==="search"){
   const query=String(body.query||"").trim();if(!query)return reply({results:[]});
   const terms=words(query),candidates=new Set();
   // New sharded postings; bounded candidate pool per term and shard.
   for(const t of terms)for(const b of SHARDS){
    const ids=await store.get(tokKey(t,b),{type:"json"})||[];
    for(const id of ids.slice(-350))candidates.add(id);
   }
   // Compatibility fallback while migration is in progress.
   if(candidates.size<30)for(const t of terms){
    const old=await store.get(`tok:${sha(t)}`,{type:"json"})||[];
    for(const id of old.slice(-500))candidates.add(id);
   }
   const rows=await Promise.all([...candidates].slice(0,4000).map(id=>store.get(qkey(id),{type:"json"})));
   const results=rows.filter(Boolean).map(x=>{const ws=new Set(words(x.question));let n=0;for(const t of terms)if(ws.has(t))n++;return {...x,score:terms.length?n/terms.length:0};}).filter(x=>x.score>=.2).sort((a,b)=>b.score-a.score).slice(0,20);
   return reply({results,searched:candidates.size});
  }
  if(action==="list"){
   const limit=Math.min(Math.max(Number(body.limit)||100,1),100),p=await listPage(store,body.cursor||null,limit);
   const meta=await store.get("meta:count",{type:"json"})||{count:0};
   return reply({items:p.items,total:meta.count||0,nextCursor:p.cursor});
  }
  if(action==="export"){
   const all=[];let cursor=null,loops=0;
   do{const p=await listPage(store,cursor,500);all.push(...p.items);cursor=p.cursor;loops++;if(loops>1000)throw Error("Ekspor terlalu besar; gunakan ekspor bertahap.");}while(cursor);
   return reply({items:all,total:all.length});
  }
  if(action==="update"){
   const old=await store.get(qkey(body.id),{type:"json"});if(!old)return reply({error:"Data tidak ditemukan"},404);
   const question=String(body.question||"").trim(),answer=String(body.answer||"").trim();if(!question||!answer)return reply({error:"Soal dan jawaban wajib diisi"},400);
   const updated={...old,question,answer,updatedAt:new Date().toISOString()};
   const nextPair=pairKey(updated),owner=await store.get(nextPair);
   if(owner&&owner!==old.id)return reply({error:"Pasangan soal dan jawaban yang sama sudah ada"},409);
   await store.setJSON(qkey(old.id),updated);
   const oldPair=pairKey(old);if(oldPair!==nextPair){await store.delete(oldPair);await store.set(nextPair,old.id);}
   const c=new Map(),bucket=shard(old.id);
   for(const t of new Set([...words(old.question),...words(question)])){
    const k=tokKey(t,bucket);if(!c.has(k))c.set(k,new Set(await store.get(k,{type:"json"})||[]));
    if(words(question).includes(t))c.get(k).add(old.id);else c.get(k).delete(old.id);
   }
   await flushCache(store,c);
   return reply({ok:true,item:updated});
  }
  if(action==="delete"){
   const old=await store.get(qkey(body.id),{type:"json"});if(!old)return reply({error:"Data tidak ditemukan"},404);
   await store.delete(qkey(old.id));await store.delete(pairKey(old));
   for(const t of words(old.question)){const k=tokKey(t,shard(old.id)),ids=await store.get(k,{type:"json"})||[];await store.setJSON(k,ids.filter(id=>id!==old.id));}
   const m=await store.get("meta:count",{type:"json"})||{count:0};m.count=Math.max(0,m.count-1);await store.setJSON("meta:count",m);return reply({ok:true});
  }
  if(action==="ai"){
   const q=String(body.query||"").trim();if(!q)return reply({error:"Pertanyaan kosong"},400);
   const prompt=`Jawab pertanyaan berikut dalam Bahasa Indonesia. Ringkas, tepat, jangan menebak jika informasi kurang.\n\n${q}`;
   const failures=[];for(const p of ["gemini","groq","mistral","cloudflare","openrouter"]){try{const answer=await callAI(p,prompt);if(answer)return reply({ok:true,source:"ai",provider:p,answer});}catch(e){failures.push(`${p}: ${e.message}`);}}
   return reply({error:"Semua AI cadangan belum tersedia atau kuotanya habis.",details:failures},503);
  }
  return reply({error:"Aksi tidak dikenal"},400);
 }catch(e){console.error("knowledge:",e);return reply({error:e.message||"Server error"},500);}
}
