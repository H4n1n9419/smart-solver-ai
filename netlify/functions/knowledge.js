import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const reply = (data, status = 200) => new Response(JSON.stringify(data), {status, headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
const norm = v => String(v ?? "").toLocaleLowerCase("id").normalize("NFKC").replace(/\s+/g," ").trim();
const sha = v => crypto.createHash("sha256").update(String(v)).digest("hex");
const words = v => [...new Set(norm(v).split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>1))].slice(0,30);
const qkey = id => `q:${id}`;
const pairKey = q => `pair:${sha(norm(q.question)+"\u0000"+norm(q.answer))}`;
const tokenKey = t => `tok:${sha(t)}`;
const MAX_BATCH = 100;

async function verifyAdmin(store, candidate) {
  const saved = await store.get("admin-password", {type:"json"});
  if (!saved) return Boolean(process.env.KNOWLEDGE_ADMIN_KEY) && candidate === process.env.KNOWLEDGE_ADMIN_KEY;
  const derived = await scrypt(candidate, Buffer.from(saved.salt,"hex"),64);
  return crypto.timingSafeEqual(derived,Buffer.from(saved.hash,"hex"));
}
async function saveAdminPassword(store,password){const salt=crypto.randomBytes(16);const derived=await scrypt(password,salt,64);await store.setJSON("admin-password",{salt:salt.toString("hex"),hash:derived.toString("hex"),updatedAt:new Date().toISOString()});}
async function insertOne(store,index,item,tokenCache){
  const question=String(item.question??item.soal??"").trim(), answer=String(item.answer??item.jawaban??"").trim();
  if(!question||!answer)return {skipped:true};
  const normalized={question,answer};
  const pk=pairKey(normalized);
  if(await store.get(pk))return {duplicate:true};
  const id=crypto.randomUUID();
  const record={id,question,answer,updatedAt:new Date().toISOString()};
  await store.setJSON(qkey(id),record);
  await store.set(pk,id);
  index.ids.unshift(id);
  for(const token of words(question)){
    let ids=tokenCache.get(token);
    if(!ids){ids=await store.get(tokenKey(token),{type:"json"})||[];tokenCache.set(token,ids);}
    ids.push(id);
  }
  return {added:true,item:record};
}
async function flushTokens(store,cache){for(const [token,ids] of cache)await store.setJSON(tokenKey(token),ids);}

async function callAI(provider,prompt){
  const timeout=AbortSignal.timeout(25000);
  if(provider==="gemini" && process.env.GEMINI_API_KEY){
    const model=process.env.GEMINI_MODEL||"gemini-2.0-flash";
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.2,maxOutputTokens:900}}),signal:timeout});
    const j=await r.json();if(!r.ok)throw new Error(`Gemini ${r.status}: ${j.error?.message||"gagal"}`);
    return j.candidates?.[0]?.content?.parts?.map(x=>x.text||"").join("\n").trim()||"";
  }
  const openAICompat=async(url,key,model,extraHeaders={})=>{
    const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`,...extraHeaders},body:JSON.stringify({model,messages:[{role:"system",content:"Kamu adalah asisten SMART AIRA. Jawab dalam Bahasa Indonesia, jelas, langsung, dan jangan mengarang fakta. Jika informasi tidak cukup, katakan tidak yakin."},{role:"user",content:prompt}],temperature:0.2,max_tokens:900}),signal:timeout});
    const j=await r.json();if(!r.ok)throw new Error(`${provider} ${r.status}: ${j.error?.message||j.message||"gagal"}`);
    return j.choices?.[0]?.message?.content?.trim()||"";
  };
  if(provider==="groq"&&process.env.GROQ_API_KEY)return openAICompat("https://api.groq.com/openai/v1/chat/completions",process.env.GROQ_API_KEY,process.env.GROQ_MODEL||"llama-3.3-70b-versatile");
  if(provider==="mistral"&&process.env.MISTRAL_API_KEY)return openAICompat("https://api.mistral.ai/v1/chat/completions",process.env.MISTRAL_API_KEY,process.env.MISTRAL_MODEL||"mistral-small-latest");
  if(provider==="openrouter"&&process.env.OPENROUTER_API_KEY)return openAICompat("https://openrouter.ai/api/v1/chat/completions",process.env.OPENROUTER_API_KEY,process.env.OPENROUTER_MODEL||"openrouter/auto",{"HTTP-Referer":process.env.SITE_URL||"https://smartsolverai.netlify.app","X-Title":"SMART AIRA AI"});
  if(provider==="cloudflare"&&process.env.CF_ACCOUNT_ID&&process.env.CF_API_TOKEN){
    const model=process.env.CF_AI_MODEL||"@cf/meta/llama-3.1-8b-instruct";
    const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${model}`,{method:"POST",headers:{Authorization:`Bearer ${process.env.CF_API_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"system",content:"Jawab dalam Bahasa Indonesia. Jangan mengarang fakta."},{role:"user",content:prompt}]}),signal:timeout});
    const j=await r.json();if(!r.ok||j.success===false)throw new Error(`Cloudflare ${r.status}: ${j.errors?.[0]?.message||"gagal"}`);return j.result?.response||j.result?.output_text||"";
  }
  throw new Error(`${provider}: API key belum diatur`);
}

export default async function handler(request){
  if(request.method!=="POST")return reply({error:"Method not allowed"},405);
  try{
    const body=await request.json();const action=body.action;const store=getStore("smart-solver-questions");
    const adminKey=request.headers.get("x-admin-key")||"";
    const protectedActions=["admin-check","change-password","add","bulk-add","update","delete","export"];
    if(protectedActions.includes(action)&&!(await verifyAdmin(store,adminKey)))return reply({error:"Kunci admin tidak cocok"},401);
    if(action==="admin-check")return reply({ok:true});
    if(action==="change-password"){
      const p=String(body.newPassword||"");if(p.length<12)return reply({error:"Kunci baru minimal 12 karakter"},400);if(p===adminKey)return reply({error:"Kunci baru harus berbeda"},400);
      await saveAdminPassword(store,p);return reply({ok:true});
    }
    const index=await store.get("index",{type:"json"})||{ids:[],exact:{}};
    if(!Array.isArray(index.ids))index.ids=[];if(!index.exact)index.exact={};
    const getQuestion=id=>store.get(qkey(id),{type:"json"});
    if(action==="add"||action==="bulk-add"){
      const input=action==="add"?[body]:body.items;
      if(!Array.isArray(input)||!input.length)return reply({error:"Data impor kosong atau format salah"},400);
      if(input.length>MAX_BATCH)return reply({error:`Maksimal ${MAX_BATCH} pasangan per batch`},413);
      const tokenCache=new Map();let added=0,duplicates=0,skipped=0;
      for(const item of input){const r=await insertOne(store,index,item,tokenCache);if(r.added)added++;else if(r.duplicate)duplicates++;else skipped++;}
      await flushTokens(store,tokenCache);await store.setJSON("index",index);
      return reply({ok:true,added,duplicates,skipped,total:index.ids.length});
    }
    if(action==="update"){
      const old=await getQuestion(body.id);if(!old)return reply({error:"Data tidak ditemukan"},404);
      const question=String(body.question||"").trim(),answer=String(body.answer||"").trim();if(!question||!answer)return reply({error:"Soal dan jawaban wajib diisi"},400);
      const oldTokens=words(old.question),newTokens=words(question);const changed=new Map();
      for(const token of new Set([...oldTokens,...newTokens])){const ids=await store.get(tokenKey(token),{type:"json"})||[];const next=ids.filter(id=>id!==old.id);if(newTokens.includes(token))next.push(old.id);changed.set(token,next);}
      await flushTokens(store,changed);
      const updated={...old,question,answer,updatedAt:new Date().toISOString()};
      await store.setJSON(qkey(old.id),updated);return reply({ok:true,item:updated});
    }
    if(action==="delete"){
      const old=await getQuestion(body.id);if(!old)return reply({error:"Data tidak ditemukan"},404);await store.delete(qkey(old.id));await store.delete(pairKey(old));
      const changed=new Map();for(const token of words(old.question)){const ids=await store.get(tokenKey(token),{type:"json"})||[];changed.set(token,ids.filter(id=>id!==old.id));}await flushTokens(store,changed);
      index.ids=index.ids.filter(id=>id!==old.id);await store.setJSON("index",index);return reply({ok:true});
    }
    if(action==="search"){
      const query=String(body.query||"").trim();if(!query)return reply({results:[]});
      const qwords=words(query);const candidateSet=new Set();
      for(const token of qwords){const ids=await store.get(tokenKey(token),{type:"json"})||[];for(const id of ids.slice(-3500))candidateSet.add(id);}
      // Legacy compatibility: exact lookup from the previous version.
      const oldExact=index.exact[sha(norm(query))];if(oldExact)candidateSet.add(oldExact);
      const candidates=[...candidateSet].slice(0,5000);const records=await Promise.all(candidates.map(getQuestion));
      const results=records.filter(Boolean).map(item=>{const set=new Set(words(item.question));let common=0;for(const w of qwords)if(set.has(w))common++;const score=qwords.length?common/qwords.length:0;return {...item,score};}).filter(x=>x.score>=0.2).sort((a,b)=>b.score-a.score).slice(0,12);
      return reply({results, searched:candidates.length});
    }
    if(action==="list"||action==="export"){
      const limit=Math.min(Math.max(Number(body.limit)||100,1),5000);const ids=action==="export"?index.ids:index.ids.slice(0,limit);
      const items=(await Promise.all(ids.map(getQuestion))).filter(Boolean);return reply({items,total:index.ids.length});
    }
    if(action==="ai"){
      const question=String(body.query||"").trim();if(!question)return reply({error:"Pertanyaan kosong"},400);
      const prompt=`Jawab pertanyaan berikut dalam Bahasa Indonesia. Berikan jawaban langsung dan ringkas. Jika ini soal pilihan ganda, jangan menebak opsi yang tidak diberikan.\n\nPertanyaan: ${question}`;
      const order=["gemini","groq","mistral","cloudflare","openrouter"];const failures=[];
      for(const provider of order){try{const answer=await callAI(provider,prompt);if(answer)return reply({ok:true,source:"ai",provider,answer});}catch(e){failures.push(`${provider}: ${e.message}`);}}
      return reply({error:"Semua AI cadangan belum tersedia atau kuotanya habis.",details:failures},503);
    }
    return reply({error:"Aksi tidak dikenal"},400);
  }catch(error){console.error("knowledge function:",error);return reply({error:error.message||"Server error"},500);}
}
